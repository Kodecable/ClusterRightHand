import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, goAvailable, runCrha, waitFor } from "./harness.ts";

const execFileAsync = promisify(execFile);
const hasGo = await goAvailable();
const MAIN = resolve(import.meta.dirname, "../../src/main.ts");

/**
 * A minimal OpenAI-compatible chat completions server: each request gets the next scripted step, streamed the way
 * OpenAI streams it. Records what it was sent.
 */
function fakeModel(steps: ((body: { messages: { role: string; content: unknown }[] }) => object)[]) {
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
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
			const delta = step(body);
			const chunk = (o: object) =>
				`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", ...o })}\n\n`;
			const toolCall = "tool_calls" in delta;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] }));
			res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] }));
			res.write(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	return { server, requests };
}

/** crhs as a real child process, on a fixed port and database, so it can be killed with SIGKILL and started again. */
class CrhsProcess {
	child?: ChildProcess;
	log = "";
	readonly config: string;
	constructor(config: string) {
		this.config = config;
	}

	start(): void {
		const child = spawn(process.execPath, [MAIN, "-c", this.config, "serve"], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (d) => {
			this.log += d;
		});
		child.stderr?.on("data", (d) => {
			this.log += d;
		});
		this.child = child;
	}

	async kill(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		const exited = new Promise((r) => child.once("exit", r));
		child.kill("SIGKILL");
		await exited;
	}
}

// doc/agent-runtime.md#故障注入: crhs is killed (SIGKILL) while a session's exec runs on a real node; after a restart
// the tool call reattaches to the same Cluster task and the session gets its real result.
describe.skipIf(!hasGo)("crhs killed mid tool call", () => {
	let tmp = "";
	let crha: ChildProcess | undefined;
	let crhs: CrhsProcess;
	let port = 0;
	let cookie = "";
	const model = fakeModel([
		() => ({
			tool_calls: [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: "exec", arguments: JSON.stringify({ node: "crash-node", cmd: "sleep 4; echo survived" }) },
				},
			],
		}),
		() => ({ content: "the command finished" }),
	]);

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
				kind: "openai-compatible",
				baseUrl: `http://127.0.0.1:${modelPort}/v1`,
				apiKey: "test",
				models: [{ id: "fake-1", contextWindow: 128_000, maxTokens: 4096 }],
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
		const session = (
			await api("/api/sessions", { body: { model: { provider: "fake", modelId: "fake-1" }, preset: "yolo" } })
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

		// The second model request carries the tool result: the real output of the one task.
		await waitFor("the model asked again", () => model.requests.length === 2, 60_000);
		const toolResult = model.requests[1]?.messages.find((m) => m.role === "tool");
		expect(JSON.stringify(toolResult)).toContain("survived");
		expect(JSON.stringify(toolResult)).toContain(running.id);
		const tasks = await tasksOf();
		expect(tasks.map((t: { id: string }) => t.id)).toEqual([running.id]);
		expect(tasks[0]).toMatchObject({ state: "exited", exitCode: 0 });
	}, 120_000);
});
