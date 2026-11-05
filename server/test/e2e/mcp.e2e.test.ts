import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, Env, goAvailable } from "./harness.ts";

const hasGo = await goAvailable();

// The M2 completion check: an MCP client manages a real node, and every step shows up in the audit log.
describe.skipIf(!hasGo)("MCP against in-process crhs and a real crha", () => {
	let tmp = "";
	let env: Env;
	let nodeName = "";

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-mcp-"));
		env = await Env.create(await buildCrha(tmp), tmp);
		await env.bringUp();
		nodeName = (await env.crhs.api(`/api/nodes/${env.nodeId}`)).json.node.name;
	}, 180_000);

	afterAll(async () => {
		await env?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	const token = async (preset: string) => {
		const res = await env.crhs.api("/api/api-tokens", { body: { name: `mcp-${preset}`, preset } });
		expect(res.status).toBe(201);
		return { token: res.json.token as string, id: res.json.apiToken.id as string };
	};

	const connect = async (bearer: string) => {
		const client = new Client({ name: "crh-test", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${env.crhs.url}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
			}),
		);
		return client;
	};

	// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text
	const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<any> => {
		const res = await client.callTool({ name, arguments: args });
		const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
		if (res.isError) throw new Error(`tool error: ${text}`);
		return JSON.parse(text);
	};

	it("lists the cluster tools and the node", async () => {
		const client = await connect((await token("yolo")).token);
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(
			[
				"edit_file",
				"exec",
				"list_dir",
				"list_nodes",
				"node_info",
				"read_file",
				"task_cancel",
				"task_wait",
				"write_file",
			].sort(),
		);
		const { nodes } = await call(client, "list_nodes", {});
		expect(nodes).toEqual([expect.objectContaining({ name: nodeName, connected: true, can_run_tasks: true })]);
		await client.close();
	});

	it("runs commands and file operations under yolo", async () => {
		const client = await connect((await token("yolo")).token);
		const r = await call(client, "exec", { targets: [nodeName], cmd: "echo hello; echo oops >&2; exit 3" });
		expect(r).toMatchObject({ state: "exited", exit_code: 3, stdout: "hello\n", stderr: "oops\n" });

		const path = join(env.dir, "mcp-file.txt");
		expect(await call(client, "write_file", { targets: [nodeName], path, content: "one\ntwo\n" })).toMatchObject({
			state: "exited",
		});
		await call(client, "edit_file", { node: nodeName, path, edits: [{ oldText: "two", newText: "three" }] });
		expect(await call(client, "read_file", { targets: [nodeName], path })).toMatchObject({ stdout: "one\nthree\n" });
		// A directory listing is the task's structured result, not JSON text in its output.
		const listing = await call(client, "list_dir", { targets: [nodeName], path: env.dir });
		expect(listing).toMatchObject({ state: "exited", truncated: false });
		expect(listing.entries.map((e: { name: string }) => e.name)).toContain("mcp-file.txt");
		// write_file refuses to overwrite by default
		expect(await call(client, "write_file", { targets: [nodeName], path, content: "x" })).toMatchObject({
			state: "failed",
		});
		await client.close();
	});

	it("pages a file by lines on the real crha", async () => {
		const client = await connect((await token("yolo")).token);
		const path = join(env.dir, "mcp-lines.txt");
		await call(client, "write_file", { targets: [nodeName], path, content: "one\ntwo\nthree\n" });
		// The node itself pages: a line offset needs no byte cursor, and the result carries the lines.
		const first = await call(client, "read_file", { targets: [nodeName], path, limit: 2 });
		expect(first).toMatchObject({
			stdout: "one\ntwo\n",
			lines: { from: 1, to: 2 },
			truncated: { note: "Use offset=3 to continue." },
		});
		const next = await call(client, "read_file", { targets: [nodeName], path, offset: 3 });
		expect(next).toMatchObject({ stdout: "three\n", lines: { from: 3, to: 3 }, total: 3 });
		await client.close();
	});

	it("node_info returns the node's notes", async () => {
		const client = await connect((await token("yolo")).token);
		const before = await call(client, "node_info", { node: nodeName });
		expect(before.notes).toMatchObject({ content: null, note: expect.stringContaining("no notes yet") });
		const path = before.notes.path as string;
		await call(client, "write_file", {
			targets: [nodeName],
			path,
			content: "# web-1\n\nnginx config lives in /etc/nginx.\n",
		});
		const after = await call(client, "node_info", { node: nodeName });
		expect(after.notes).toEqual({ path, content: "# web-1\n\nnginx config lives in /etc/nginx.\n" });
		await client.close();
	});

	it("node_info does not read the notes when that would need approval", async () => {
		const client = await connect((await token("ask")).token);
		// ask allows reads, so the notes are read...
		expect((await call(client, "node_info", { node: nodeName })).notes.content).toContain("nginx");
		await client.close();
		// ...but with a rule requiring approval for that path, node_info leaves it alone.
		const t = await token("ask");
		const path = (await env.crhs.api(`/api/nodes/${env.nodeId}`)).json.node.facts.notesPath;
		await env.crhs.api(`/api/api-tokens/${t.id}/rules`, {
			method: "PUT",
			body: { rules: [{ action: "require-approval", method: "file.read", exact: path }] },
		});
		const strict = await connect(t.token);
		expect((await call(strict, "node_info", { node: nodeName })).notes).toMatchObject({
			content: null,
			note: expect.stringContaining("approval"),
		});
		expect((await env.crhs.api("/api/approvals")).json.tasks).toEqual([]);
		await strict.close();
	});

	it("waits for approval under ask, then finishes once the user approves", async () => {
		const t = await token("ask");
		const client = await connect(t.token);
		// Reads are allowed by the ask preset.
		expect(await call(client, "read_file", { targets: [nodeName], path: "/etc/hostname" })).toMatchObject({
			state: "exited",
		});
		const pending = await call(client, "exec", { targets: [nodeName], argv: ["echo", "approved"], wait: 1 });
		expect(pending).toMatchObject({
			state: "awaiting_approval",
			approval: { url: expect.stringContaining(pending.task_id) },
		});

		const approvals = (await env.crhs.api("/api/approvals")).json;
		expect(approvals.tasks.map((x: { id: string }) => x.id)).toEqual([pending.task_id]);
		const decided = await env.crhs.api(`/api/tasks/${pending.task_id}/approval`, {
			body: { decision: "approve", always: { action: "allow", method: "exec", exact: "echo approved" } },
		});
		expect(decided.status).toBe(200);
		expect(await call(client, "task_wait", { task_id: pending.task_id })).toMatchObject({
			state: "exited",
			exit_code: 0,
			stdout: "approved\n",
		});
		// "Always allow" took effect: the same command now runs at once.
		expect(await call(client, "exec", { targets: [nodeName], argv: ["echo", "approved"] })).toMatchObject({
			state: "exited",
		});
		// Rejection reaches the client as the task's outcome.
		const second = await call(client, "exec", { targets: [nodeName], cmd: "rm -rf /tmp/nothing", wait: 0 });
		await env.crhs.api(`/api/tasks/${second.task_id}/approval`, { body: { decision: "reject", reason: "no" } });
		expect(await call(client, "task_wait", { task_id: second.task_id })).toMatchObject({
			state: "rejected",
			error: { code: "approval_rejected", message: "no" },
		});
		await client.close();
	});

	it("runs a batch as one approval for the group", async () => {
		const t = await token("ask");
		const client = await connect(t.token);
		// The node group name selects several nodes; one node name would be a single task.
		const g = await call(client, "exec", { targets: ["e2e"], cmd: "echo batch", output: "text", wait: 0 });
		expect(g).toMatchObject({ state: "awaiting_approval", nodes: [] });
		await env.crhs.api(`/api/task-groups/${g.task_group_id}/approval`, { body: { decision: "approve" } });
		const done = await call(client, "task_wait", { task_group_id: g.task_group_id });
		expect(done).toMatchObject({
			state: "finished",
			nodes: [expect.objectContaining({ exit_code: 0, output: "batch\n" })],
		});
		await client.close();
	});

	it("rejects missing, bad and revoked tokens", async () => {
		const t = await token("yolo");
		await env.crhs.api(`/api/api-tokens/${t.id}/revoke`, { body: {} });
		for (const auth of [undefined, "Bearer crh_nope", `Bearer ${t.token}`]) {
			const res = await fetch(`${env.crhs.url}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
			expect(res.status).toBe(401);
		}
	});

	it("records every step in the audit log", async () => {
		await env.crhs.audit.flush();
		const { items } = (await env.crhs.api("/api/audit?limit=200")).json;
		const actions = new Set(items.map((e: { action: string }) => e.action));
		for (const a of [
			"api_token.created",
			"tool.call",
			"task.created",
			"task.approval",
			"task.finished",
			"rules.changed",
			"task_group.created",
			"task_group.approval",
		]) {
			expect(actions, a).toContain(a);
		}
	});
});
