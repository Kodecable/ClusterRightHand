import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, CRHS_MAIN, CrhsProcess, goAvailable, pkill, runCrha, waitFor } from "./harness.ts";

const execFileAsync = promisify(execFile);
const hasGo = await goAvailable();

// A SIGTERM on a live crhs with a connected crha: exit 0, no database errors, and the disconnect audit
// survives in a verifiable chain.
describe.skipIf(!hasGo)("crhs SIGTERM shutdown with a connected node", () => {
	let tmp = "";
	let bin = "";
	let crhs: CrhsProcess;
	let crha: ChildProcess | undefined;
	let port = 0;
	let cookie = "";
	let nodeId = "";

	const url = () => `http://127.0.0.1:${port}`;
	const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
		const res = await fetch(url() + path, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers: { cookie, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const up = () =>
		waitFor("crhs up", async () => (await fetch(`${url()}/api/health`).catch(() => undefined))?.ok, 30_000);
	const login = async () => {
		const res = await fetch(`${url()}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "root", password: "admin-password" }),
		});
		cookie = res.headers.get("set-cookie")?.match(/crh_session=[^;]+/)?.[0] ?? "";
		expect(res.status).toBe(200);
	};
	/** A model for the session below: it is only recorded, never called, so the URL is never reached. */
	const setUpModel = async () => {
		const res = await api("/api/model-providers/e2e", {
			method: "PUT",
			body: {
				kind: "openai-compatible",
				baseUrl: "http://127.0.0.1:9/v1",
				models: [{ id: "test-model", contextWindow: 8192, maxTokens: 1024 }],
			},
		});
		expect(res.status, JSON.stringify(res.json)).toBe(200);
		return { provider: "e2e", modelId: "test-model" };
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-shutdown-e2e-"));
		bin = await buildCrha(tmp);

		// A free port for crhs, fixed across the restart.
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
		port = (probe.address() as AddressInfo).port;
		await new Promise((r) => probe.close(r));

		const config = join(tmp, "crhs.toml");
		await writeFile(
			config,
			`master_key_file = "${join(tmp, "master.key")}"\n[listen]\nhost = "127.0.0.1"\nport = ${port}\n[database]\ndriver = "sqlite"\npath = "${join(tmp, "crhs.db")}"\n`,
		);
		await execFileAsync(process.execPath, [CRHS_MAIN, "-c", config, "keys", "init"]);
		const add = execFile(process.execPath, [CRHS_MAIN, "-c", config, "user", "add", "root", "--admin"]);
		add.stdin?.end("admin-password\n");
		await new Promise((r) => add.once("exit", r));

		crhs = new CrhsProcess(config);
		crhs.start();
		await up();
		await login();

		const token = (await api("/api/enrollment-tokens", { body: { nameHint: "shutdown-node" } })).json.token;
		const cfg = join(tmp, "crha.toml");
		await writeFile(cfg, `server = "${url()}"\nstate_dir = "${join(tmp, "crha-state")}"\n`);
		const enrolled = await runCrha(bin, ["enroll", "--config", cfg, url(), token]);
		expect(enrolled.code, `${enrolled.stdout}${enrolled.stderr}\n${crhs.log}`).toBe(0);
		crha = spawn(bin, ["run", "--config", cfg], { stdio: "ignore" });
		const node = await waitFor("pending node", async () =>
			(await api("/api/nodes")).json.nodes.find((n: { status: string }) => n.status === "pending"),
		);
		nodeId = node.id;
		await api(`/api/nodes/${node.id}/approve`, { body: {} });
		await waitFor("node online", async () => (await api(`/api/nodes/${node.id}`)).json.node.connected === true);
	}, 240_000);

	afterAll(async () => {
		crha?.kill("SIGKILL");
		await crhs?.kill();
		await pkill("sleep 61.3");
		await rm(tmp, { recursive: true, force: true });
	});

	it("exits 0 and keeps the disconnect audit", async () => {
		const before = crhs.log.length;
		const ended = await crhs.stop("SIGTERM");
		expect(ended).toEqual({ code: 0, signal: null });
		const log = crhs.log.slice(before);
		expect(log).not.toMatch(
			/database is not open|driver has already been destroyed|audit: failed|shutdown failed|did not finish within/i,
		);

		crhs.start();
		await up();
		await login();

		const verify = await api("/api/audit/verify");
		expect(verify.status).toBe(200);
		expect(verify.json).toMatchObject({ ok: true });

		const events = await api("/api/audit?action=node.disconnected");
		expect(events.status).toBe(200);
		expect(events.json.items).toHaveLength(1);
		expect(events.json.items[0]).toMatchObject({ action: "node.disconnected", targetType: "node", targetId: nodeId });
	}, 120_000);

	it("ends an open session event stream and exits 0 well under the timeout", async () => {
		const model = await setUpModel();
		const created = await api("/api/sessions", { body: { model } });
		expect(created.status).toBe(201);
		const sessionId = created.json.session.id;

		const stream = await fetch(`${url()}/api/sessions/${sessionId}/events`, { headers: { cookie } });
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("the event stream has no body");
		// The snapshot proves the stream is live when the signal arrives; the client never closes it.
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("snapshot")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("the event stream ended before the snapshot");
			text += decoder.decode(chunk.value, { stream: true });
		}

		const before = crhs.log.length;
		const started = Date.now();
		const ended = await crhs.stop("SIGTERM");
		const elapsed = Date.now() - started;
		expect(ended).toEqual({ code: 0, signal: null });
		// The ping interval alone would take 15 s: the stream must end as soon as shutdown begins.
		expect(elapsed).toBeLessThan(5_000);
		const log = crhs.log.slice(before);
		expect(log).not.toMatch(
			/database is not open|driver has already been destroyed|audit: failed|shutdown failed|did not finish within/i,
		);
		// The server ended the stream (rather than the process dying with it).
		expect((await reader.read()).done).toBe(true);
	}, 120_000);

	it("ends an open task wait instead of holding the shutdown", async () => {
		crhs.start();
		await up();
		await login();
		await waitFor("node online", async () => (await api(`/api/nodes/${nodeId}`)).json.node.connected === true);
		const task = (await api(`/api/nodes/${nodeId}/tasks`, { body: { kind: "exec", argv: ["sleep", "61.3"] } })).json
			.task as { id: string };
		// A long wait on a task that does not finish within it: shutdown must end the wait, not wait it out.
		const waiting = fetch(`${url()}/api/tasks/${task.id}/wait?timeoutMs=60000`, { headers: { cookie } });
		// Let the request reach its handler and enter the wait before the signal.
		await new Promise((resolve) => setTimeout(resolve, 500));

		const before = crhs.log.length;
		const started = Date.now();
		const ended = await crhs.stop("SIGTERM");
		const elapsed = Date.now() - started;
		expect(ended).toEqual({ code: 0, signal: null });
		// The wait's own timeout (60 s) alone would exceed the shutdown timeout (10 s).
		expect(elapsed).toBeLessThan(5_000);

		const response = await waiting;
		expect(response.status).toBe(200);
		const body = (await response.json()) as { task: { state: string } };
		// The normal response with the current, non-final state; the task keeps running on the node.
		expect(["dispatched", "running"]).toContain(body.task.state);
		const log = crhs.log.slice(before);
		expect(log).not.toMatch(
			/database is not open|driver has already been destroyed|audit: failed|shutdown failed|did not finish within/i,
		);
		await pkill("sleep 61.3");
	}, 120_000);

	it("exits 1 on a second signal during shutdown", async () => {
		crhs.start();
		await up();
		await login();
		await waitFor("node online", async () => (await api(`/api/nodes/${nodeId}`)).json.node.connected === true);

		const before = crhs.log.length;
		const child = crhs.child;
		const ended = crhs.stop("SIGTERM");
		// A different signal, so the kernel cannot coalesce the two: the first handler starts the shutdown,
		// the second finds it underway and exits 1.
		child?.kill("SIGINT");
		expect(await ended).toEqual({ code: 1, signal: null });
		expect(crhs.log.slice(before)).toMatch(/crhs: SIG(?:INT|TERM) during shutdown, exiting/);
	}, 120_000);
});
