import type { TaskView } from "@crh/api";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiToken } from "../src/auth/api-tokens.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { DEFAULT_SYSTEM_SETTINGS, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

/** A single-node exec that is waiting for its owner's approval: the result carries the approval link. */
const APPROVAL_TASK_ID = "0190a000-0000-7000-8000-000000000001";

describe("MCP links", () => {
	let db: Db;
	let user: SessionUser;
	let token: string;
	let nodeId: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const created = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		user = { sessionId: "s", userId: created.id, username: created.username, kind: "member" };
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1",
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: user.userId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: user.userId,
				created_at: now,
			})
			.execute();
		token = (await createApiToken(db, user, { name: "mcp", rulePreset: "yolo" })).token;
	});

	afterEach(async () => {
		await db.destroy();
	});

	/** Builds an app whose task tools return one task waiting for approval. */
	function appWith(publicUrl?: string, settings?: SettingsStore): App {
		const task: TaskView = {
			id: APPROVAL_TASK_ID,
			nodeId,
			kind: "exec",
			summary: "true",
			operation: null,
			actorType: "api_token",
			actorId: "token",
			onBehalfOfUserId: user.userId,
			state: "awaiting_approval",
			exitCode: null,
			signal: null,
			timedOut: false,
			cancelled: false,
			timeoutMs: null,
			errorCode: null,
			errorMessage: null,
			outputBytes: 0,
			outputHead: "",
			outputTail: "",
			outputTailLines: 0,
			outputLines: null,
			notice: null,
			maxLines: null,
			maxBytes: null,
			outputFile: null,
			outputMode: "full",
			privileged: false,
			authorization: null,
			result: null,
			createdAt: new Date().toISOString(),
			finishedAt: null,
			taskGroupId: null,
			ruleChain: null,
			approval: null,
			rootSessionId: null,
			handlerType: "user",
			handlerSessionId: null,
			purpose: null,
		};
		const cluster = {
			createTask: async () => task,
			waitTask: async () => task,
		} as unknown as Cluster;
		return makeApp(db, undefined, {
			cluster,
			taskGroups: new TaskGroups(db, cluster),
			...(publicUrl === undefined ? {} : { publicUrl }),
			...(settings === undefined ? {} : { settings }),
		});
	}

	async function execText(app: App): Promise<string> {
		const client = new Client({ name: "crh-test", version: "0.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL("http://crh.test/mcp"), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
			// In-process MCP: the Hono app is the network.
			fetch: async (input, init) => await app.request(new Request(input, init)),
		});
		await client.connect(transport);
		try {
			const res = await client.callTool({
				name: "exec",
				arguments: { targets: ["web-1"], cmd: "true", wait: 0 },
			});
			return (res.content as { type: string; text: string }[]).map((block) => block.text).join("\n");
		} finally {
			await client.close();
		}
	}

	it("names the token user's own library in the library tool descriptions", async () => {
		const app = appWith();
		const client = new Client({ name: "crh-test", version: "0.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL("http://crh.test/mcp"), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
			fetch: async (input, init) => await app.request(new Request(input, init)),
		});
		await client.connect(transport);
		try {
			const tools = (await client.listTools()).tools;
			for (const name of ["list_dir", "stat", "copy_file", "view_image"]) {
				const tool = tools.find((candidate) => candidate.name === name);
				expect(tool?.description, name).toContain("user:alice");
			}
		} finally {
			await client.close();
		}
	});

	it("uses public_url when set", async () => {
		const text = await execText(appWith("https://crh.example.com"));
		expect(text).toContain(`waiting for approval: https://crh.example.com/approvals/tasks/${APPROVAL_TASK_ID}`);
	});

	it("falls back to the request origin when public_url is unset", async () => {
		const text = await execText(appWith());
		expect(text).toContain(`waiting for approval: http://crh.test/approvals/tasks/${APPROVAL_TASK_ID}`);
	});

	it("applies a public_url change without a restart", async () => {
		const settings = SettingsStore.fromSystemSettings(DEFAULT_SYSTEM_SETTINGS);
		const app = appWith(undefined, settings);
		expect(await execText(app)).toContain(`waiting for approval: http://crh.test/approvals/tasks/${APPROVAL_TASK_ID}`);

		await settings.patch(db, { publicUrl: "https://crh.example.com" }, null);
		expect(await execText(app)).toContain(
			`waiting for approval: https://crh.example.com/approvals/tasks/${APPROVAL_TASK_ID}`,
		);
	});
});
