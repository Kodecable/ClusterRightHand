import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, CrhsProcess, goAvailable, runCrha, waitFor } from "./harness.ts";

const execFileAsync = promisify(execFile);
const hasGo = await goAvailable();
const MAIN = resolve(import.meta.dirname, "../../src/main.ts");

/**
 * A minimal OpenAI-compatible chat completions server: each request gets the next scripted step, streamed the way
 * OpenAI streams it. Records what it was sent.
 */
function fakeModel(steps: ((body: { messages: { role: string; content: unknown }[] }) => object)[]) {
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
	/** Request indexes whose response started streaming; a test can kill crhs once one is here. */
	const streaming: number[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => {
			raw += d;
		});
		req.on("end", () => {
			const body = JSON.parse(raw);
			requests.push(body);
			const step = steps.shift();
			if (!step) {
				res.writeHead(500).end("no more scripted responses");
				return;
			}
			const delta = step(body) as { content?: unknown; __slow?: number };
			const chunk = (o: object) =>
				`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", ...o })}\n\n`;
			const toolCall = "tool_calls" in delta;
			res.writeHead(200, { "content-type": "text/event-stream" });
			// __slow: send a first piece, then pause, so a test can kill crhs in the middle of the model's answer.
			if (typeof delta.content === "string" && delta.__slow) {
				const text = delta.content;
				const first = text.slice(0, 3);
				const rest = text.slice(3);
				res.write(
					chunk({ choices: [{ index: 0, delta: { role: "assistant", content: first }, finish_reason: null }] }),
				);
				streaming.push(requests.length);
				setTimeout(() => {
					if (res.destroyed) return;
					res.write(chunk({ choices: [{ index: 0, delta: { content: rest }, finish_reason: null }] }));
					res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
					res.write(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
					res.end("data: [DONE]\n\n");
				}, delta.__slow);
				return;
			}
			res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] }));
			res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] }));
			res.write(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	return { server, requests, streaming, steps };
}

// doc/agent-runtime.md#故障注入: crhs is killed (SIGKILL) while a session's exec runs on a real node; after a restart
// the tool call reattaches to the same Cluster task and the session gets its real result.
describe.skipIf(!hasGo)("crhs killed mid tool call", () => {
	let tmp = "";
	let crha: ChildProcess | undefined;
	let crhs: CrhsProcess;
	let port = 0;
	let cookie = "";
	const model = fakeModel([]);
	/** Replace the fake model's script; test order must not leak steps into the next test. */
	const script = (...steps: ((body: { messages: { role: string; content: unknown }[] }) => object)[]) => {
		model.steps.splice(0, model.steps.length);
		model.steps.push(...steps);
	};

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

	/** The first event of the session's stream: the snapshot, with its entries and whether a run is live. */
	const snapshot = async (id: string) => {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), 10_000);
		try {
			const res = await fetch(`${url()}/api/sessions/${id}/events`, { headers: { cookie }, signal: ctl.signal });
			const reader = res.body?.getReader();
			if (!reader) return undefined;
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return undefined;
				buf += decoder.decode(value);
				const end = buf.indexOf("\n\n");
				if (end < 0) continue;
				const data = buf
					.slice(0, end)
					.split("\n")
					.find((line) => line.startsWith("data:"));
				if (!data) continue;
				void reader.cancel();
				const events = JSON.parse(data.slice(5)) as {
					type: string;
					snapshot?: {
						entries: { model?: { role: string; content: unknown }[] }[];
						run?: unknown;
					};
				}[];
				return events.find((e) => e.type === "snapshot")?.snapshot;
			}
		} finally {
			clearTimeout(timer);
		}
	};
	const assistantTexts = (snap: { entries: { model?: { role: string; content: unknown }[] }[] } | undefined) =>
		(snap?.entries ?? []).flatMap((entry) =>
			(entry.model ?? [])
				.filter((m) => m.role === "assistant")
				.map((m) =>
					typeof m.content === "string"
						? m.content
						: (m.content as { text?: string }[]).map((c) => c.text ?? "").join(""),
				),
		);

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-crash-"));
		const bin = await buildCrha(tmp);
		await new Promise<void>((r) => model.server.listen(0, "127.0.0.1", r));
		const modelPort = (model.server.address() as AddressInfo).port;

		// A free port for crhs, fixed across restarts.
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
		port = (probe.address() as AddressInfo).port;
		await new Promise((r) => probe.close(r));

		const config = join(tmp, "crhs.toml");
		await writeFile(
			config,
			`master_key_file = "${join(tmp, "master.key")}"\n[listen]\nhost = "127.0.0.1"\nport = ${port}\n[database]\ndriver = "sqlite"\npath = "${join(tmp, "crhs.db")}"\n`,
		);
		await execFileAsync(process.execPath, [MAIN, "-c", config, "keys", "init"]);
		const add = execFile(process.execPath, [MAIN, "-c", config, "user", "add", "root", "--admin"]);
		add.stdin?.end("admin-password\n");
		await new Promise((r) => add.once("exit", r));

		crhs = new CrhsProcess(config);
		crhs.start();
		await up();
		const login = await fetch(`${url()}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "root", password: "admin-password" }),
		});
		cookie = login.headers.get("set-cookie")?.match(/crh_session=[^;]+/)?.[0] ?? "";

		// The model: an OpenAI-compatible provider pointing at the fake server.
		const provider = await api("/api/model-providers/fake", {
			method: "PUT",
			body: {
				kind: "custom",
				baseUrl: `http://127.0.0.1:${modelPort}/v1`,
				apiKey: "test",
				models: [{ id: "fake-1", api: "openai-completions", input: ["text"], contextWindow: 128_000, maxTokens: 4096 }],
			},
		});
		expect(provider.status).toBe(200);

		// A node.
		const token = (await api("/api/enrollment-tokens", { body: { nameHint: "crash-node" } })).json.token;
		const cfg = join(tmp, "crha.toml");
		await writeFile(cfg, `server = "${url()}"\nstate_dir = "${join(tmp, "crha-state")}"\n`);
		const enrolled = await runCrha(bin, ["enroll", "--config", cfg, url(), token]);
		expect(enrolled.code, `${enrolled.stdout}${enrolled.stderr}\n${crhs.log}`).toBe(0);
		crha = spawn(bin, ["run", "--config", cfg], { stdio: "ignore" });
		const node = await waitFor("pending node", async () =>
			(await api("/api/nodes")).json.nodes.find((n: { status: string }) => n.status === "pending"),
		);
		await api(`/api/nodes/${node.id}/approve`, { body: {} });
		await waitFor("node online", async () => (await api(`/api/nodes/${node.id}`)).json.node.connected === true);
	}, 180_000);

	afterAll(async () => {
		crha?.kill("SIGKILL");
		await crhs?.kill();
		await new Promise((r) => model.server.close(r));
		await rm(tmp, { recursive: true, force: true });
	});

	it("finishes the session with the command's real output after a SIGKILL restart", async () => {
		script(
			() => ({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: {
							name: "exec",
							arguments: JSON.stringify({ targets: ["crash-node"], cmd: "sleep 4; echo survived" }),
						},
					},
				],
			}),
			() => ({ content: "the command finished" }),
		);
		const session = (
			await api("/api/sessions", { body: { model: { provider: "fake", modelId: "fake-1" }, rulePreset: "yolo" } })
		).json.session;
		expect((await api(`/api/sessions/${session.id}/messages`, { body: { text: "go", requestId: "r1" } })).status).toBe(
			202,
		);

		const tasksOf = async () => {
			const { nodes } = (await api("/api/nodes")).json;
			const lists = await Promise.all(
				nodes.map(async (n: { id: string }) => (await api(`/api/nodes/${n.id}/tasks`)).json.tasks),
			);
			return lists.flat().filter((t: { actorId: string }) => t.actorId === session.id);
		};
		const running = await waitFor("the exec running", async () =>
			(await tasksOf()).find((t: { state: string }) => t.state === "running"),
		);

		await crhs.kill();
		crhs.start();
		await up();

		// The second model request carries the tool result: the real output of the one task. The result is
		// text (D111/D112); the task id is UI-only metadata in its `details`, never sent to the model, so the
		// task-API check below ties the output to the task that was running before the crash.
		await waitFor("the model asked again", () => model.requests.length === 2, 60_000);
		const toolResult = model.requests[1]?.messages.find((m) => m.role === "tool");
		expect(JSON.stringify(toolResult)).toContain("survived");
		const tasks = await tasksOf();
		expect(tasks.map((t: { id: string }) => t.id)).toEqual([running.id]);
		expect(tasks[0]).toMatchObject({ state: "exited", exitCode: 0 });
	}, 120_000);
	it("continues after a SIGKILL in the middle of the model's answer", async () => {
		script(
			() => ({ content: "recovered answer", __slow: 5000 }),
			() => ({ content: "recovered answer" }),
		);
		const session = (
			await api("/api/sessions", { body: { model: { provider: "fake", modelId: "fake-1" }, rulePreset: "yolo" } })
		).json.session;
		const before = model.streaming.length;
		expect(
			(await api(`/api/sessions/${session.id}/messages`, { body: { text: "say it", requestId: "stream-r1" } })).status,
		).toBe(202);

		await waitFor("the answer streaming", () => model.streaming.length > before, 30_000);
		await crhs.kill();
		crhs.start();
		await up();

		const texts = await waitFor(
			"the recovered answer",
			async () => {
				const snap = await snapshot(session.id);
				return assistantTexts(snap).some((text) => text.includes("recovered answer")) ? snap : undefined;
			},
			60_000,
		);
		expect(assistantTexts(texts).filter((text) => text.includes("recovered answer"))).toHaveLength(1);
		// The run finished; the session is idle again.
		const final = await snapshot(session.id);
		expect(final?.run).toBeUndefined();
	}, 120_000);
});
