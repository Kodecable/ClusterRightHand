import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CompiledQuery } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime, depthLimitedSessions } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";
import { toolNames } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The startup depth-limit scan (`AgentRuntime#enforceDepthToolLimits`, doc/design/agent-runtime.md "Subagents"): a
 * session that reached the subagent limit before conversations carried a tool filter must lose the subagent
 * tool when crhs starts, and no idle session may be read. The scan is sized for doc/design/webui.md's 100,000
 * sessions, so it walks up from the subagent rows instead of loading every session's id and parent.
 */

const SEEDED = 3_000;
const SEEDED_BASE_MS = Date.parse("2026-02-01T00:00:00.000Z");
const SEEDED_CONVERSATION_BASE = 90_000_000;

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const rules = { default: "inherit" as const, rules: [] };

let dir = "";
let db: Db;
let cluster: Cluster;
let groups: TaskGroups;
let models: ModelConfig;
let owner: SessionUser;

const openStorage = (): Promise<Storage> => openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" });

const open = (storage: Storage) =>
	AgentRuntime.open({ db, storage, models, cluster, taskGroups: groups, audit: new Audit(db) });

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "crh-depth-limit-"));
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	groups = new TaskGroups(db, cluster, { audit });
	models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const user = await createUser(db, { username: "depth-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
	await rm(dir, { recursive: true, force: true });
});

/** Idle root sessions, most of the fleet the scan must not read; their conversations are never opened. */
async function seedIdleSessions(): Promise<{ conversationIds: Set<string> }> {
	const orgId = await defaultOrgId(db);
	const modelJson = JSON.stringify(model());
	const conversationIds = new Set<string>();
	await db.transaction().execute(async (trx) => {
		for (let start = 0; start < SEEDED; start += 500) {
			const rows = [];
			for (let index = start; index < Math.min(start + 500, SEEDED); index++) {
				const id = `depth-idle-${String(index).padStart(5, "0")}`;
				const time = new Date(SEEDED_BASE_MS + index * 1_000).toISOString();
				const conversationId = String(SEEDED_CONVERSATION_BASE + index);
				conversationIds.add(conversationId);
				rows.push({
					id,
					org_id: orgId,
					owner_user_id: owner.userId,
					conversation_id: conversationId,
					parent_session_id: null,
					root_session_id: id,
					schedule_id: null,
					title: `idle ${index}`,
					model: modelJson,
					status: "active" as const,
					created_at: time,
					updated_at: time,
					archived_at: null,
					last_submission_id: null,
					state: "idle" as const,
					waiting_kind: null,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: time,
					quota_tokens: null,
				});
			}
			await trx.insertInto("sessions").values(rows).execute();
		}
	});
	return { conversationIds };
}

it("removes the subagent tool only from sessions at the depth limit, without reading the idle ones", async () => {
	// A tree the startup scan must repair: root -> middle -> legacy. The legacy session reached the limit
	// through its parent link, but its conversation was created before the per-conversation tool filter, so it
	// still offers the subagent tool until the scan runs.
	const firstStorage = await openStorage();
	const first = await open(firstStorage);
	let middle = "";
	let legacy = "";
	let legacyConversation = "";
	try {
		const root = await first.createSession(owner, { model: model(), rulePreset: "yolo", title: "depth root" });
		middle = (await first.createSubagent(root.id, { callKey: "depth-middle", task: "middle", rules, quota: null })).id;
		legacy = (await first.createSubagent(root.id, { callKey: "depth-legacy", task: "legacy", rules, quota: null })).id;
		await db.updateTable("sessions").set({ parent_session_id: middle }).where("id", "=", legacy).execute();
		expect(await toolNames(firstStorage, db, middle)).toContain("subagent");
		expect(await toolNames(firstStorage, db, legacy)).toContain("subagent");
		legacyConversation = (
			await db.selectFrom("sessions").select("conversation_id").where("id", "=", legacy).executeTakeFirstOrThrow()
		).conversation_id;
	} finally {
		await first.close();
	}

	const seeded = await seedIdleSessions();

	// The scan's own query finds exactly the session at the limit, and reads the subagent rows through the
	// parent index rather than scanning the sessions table.
	const limited = await depthLimitedSessions().execute(db);
	expect(limited.rows.map((row) => row.id)).toEqual([legacy]);
	const compiled = depthLimitedSessions().compile(db);
	const explained = await db.executeQuery<{ detail: string }>(
		CompiledQuery.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.parameters]),
	);
	const plan = explained.rows.map((row) => row.detail).join("\n");
	expect(plan).toContain("sessions_parent_updated_idx");
	expect(plan).not.toContain("SCAN sessions");

	// Restart: the scan fixes the legacy conversation and nothing else. Every conversation lookup of the new
	// runtime is observed, so a scan that read every session would show up here.
	const storage = await openStorage();
	const conversation = vi.spyOn(storage, "conversation");
	const second = await open(storage);
	try {
		const read = conversation.mock.calls.map(([id]) => String(id));
		expect(read).toContain(legacyConversation);
		expect(read.filter((id) => seeded.conversationIds.has(id))).toEqual([]);
		// The session at the limit no longer offers the tool; its parent, one level above it, still does.
		expect(await toolNames(storage, db, legacy)).not.toContain("subagent");
		expect(await toolNames(storage, db, middle)).toContain("subagent");
	} finally {
		await second.close();
	}
});
