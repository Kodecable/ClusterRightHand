import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

/**
 * `pendingAgentRequests` runs after every tool result of a session with subagents. With no descendant awaiting it
 * used to build `in ()`, which SQLite accepts and PostgreSQL rejects, so the empty case is tested on both.
 */
describeBackends("pending subagent requests", (backend) => {
	let db: Db;
	let runtime: AgentRuntime;
	let owner: SessionUser;
	const faux = fauxProvider();
	const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

	beforeAll(async () => {
		db = await openTestDb(backend);
		const audit = new Audit(db);
		const cluster = new Cluster(db, { audit });
		const models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		runtime = await AgentRuntime.open({
			db,
			storage: new MemoryStorage(),
			models,
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit }),
			audit,
		});
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	});

	afterAll(async () => {
		await runtime.close();
		await db.destroy();
	});

	it("returns no requests when no subagent is waiting", async () => {
		const root = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
		const child = await runtime.createSubagent(root.id, {
			callKey: "idle-child",
			task: "child work",
			rules: { default: "inherit", rules: [] },
			quota: null,
		});
		expect(await runtime.pendingAgentRequests(root.id)).toEqual([]);
		expect(await runtime.pendingAgentRequests(child.id)).toEqual([]);
	});
});
