/**
 * A real crhs in this process, assembled the way `main.ts` assembles it, with a FILE-backed crhs database and a
 * FILE-backed pi-durable storage in OUT_DIR. The shared e2e harness opens SQLite with `:memory:`, which would hide
 * the disk growth this test is about; that is why the soak has its own small wrapper here instead of changing the
 * shared fixture.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { serve } from "@hono/node-server";
import { sql } from "kysely";
import { ModelConfig } from "../../src/agent/models.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { createApp } from "../../src/api/app.ts";
import { Audit } from "../../src/audit/audit.ts";
import { LoginLimiter } from "../../src/auth/login-limiter.ts";
import type { SessionUser } from "../../src/auth/sessions.ts";
import { AgentServer } from "../../src/cluster/agent-server.ts";
import { Cluster } from "../../src/cluster/cluster.ts";
import { loadServerIdentity } from "../../src/cluster/identity.ts";
import { TaskGroups } from "../../src/cluster/task-groups.ts";
import { MasterKey } from "../../src/keys/master-key.ts";
import { loadAuthorizationSigningKey } from "../../src/privilege/key.ts";
import { Scheduler } from "../../src/scheduler/scheduler.ts";
import { type Db, openAgentStorage, openDb } from "../../src/storage/db.ts";
import { migrateToLatest } from "../../src/storage/migrate.ts";
import { createUser } from "../../src/users/service.ts";
import type { RuntimeStats } from "./ipc.ts";
import type { SoakParams } from "./params.ts";
import { percentile, type WorkloadProgress } from "./workload.ts";

export interface SoakCrhs {
	readonly db: Db;
	readonly runtime: AgentRuntime;
	readonly faux: FauxProviderHandle;
	readonly owner: SessionUser;
	readonly url: string;
	readonly cookie: string;
	readonly model: { provider: string; modelId: string };
	readonly paths: { db: string; durableDir: string; durableDb: string };
	stats(progress: WorkloadProgress): Promise<RuntimeStats>;
	close(): Promise<void>;
}

const ADMIN_PASSWORD = "soak-password";

export async function openSoakCrhs(params: SoakParams, faux: FauxProviderHandle): Promise<SoakCrhs> {
	const dbDir = join(params.outDir, "crhs", "db");
	const durableDir = join(params.outDir, "crhs", "durable");
	await mkdir(dbDir, { recursive: true });
	await mkdir(durableDir, { recursive: true });
	const dbPath = join(dbDir, "crhs.sqlite");
	const durableDbPath = join(durableDir, "durable.sqlite");

	const db = openDb({ driver: "sqlite", path: dbPath });
	await migrateToLatest(db);
	const masterKey = MasterKey.generate();
	const identity = await loadServerIdentity(db, masterKey);
	const authorizationKey = await loadAuthorizationSigningKey(db, masterKey);
	const audit = new Audit(db);
	const cluster = new Cluster(db, { authorizationKey, audit });
	const agents = new AgentServer(db, identity, cluster, audit);
	const taskGroups = new TaskGroups(db, cluster, { audit });
	await taskGroups.recover();
	await cluster.recover();

	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	const opened = await openAgentStorage({ driver: "sqlite", path: durableDbPath });
	const runtime = await AgentRuntime.open({
		db,
		storage: opened.storage,
		models,
		cluster,
		taskGroups,
		audit,
	});
	const scheduler = new Scheduler({ db, runtime, audit });
	const app = createApp(db, {
		taskGroups,
		agent: { runtime, models },
		scheduler,
		serverFingerprint: identity.fingerprint,
		serverPublicKey: identity.keyPair.publicKey,
		authorizationKey,
		cluster,
		masterKey,
		audit,
		limiter: new LoginLimiter(),
		captcha: "none",
	});
	const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	server.on("upgrade", (req, socket, head) => {
		if (!agents.handleUpgrade(req, socket, head)) socket.destroy();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		if (server.listening) resolve();
		else server.once("listening", () => resolve());
	});
	await scheduler.start();
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}`;

	const username = `soak-${randomUUID().slice(0, 8)}`;
	const user = await createUser(db, { username, kind: "admin", password: ADMIN_PASSWORD });
	const login = await fetch(`${url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password: ADMIN_PASSWORD }),
	});
	const setCookie = login.headers.get("set-cookie") ?? "";
	const cookie = /crh_session=[^;]+/.exec(setCookie)?.[0] ?? "";
	if (login.status !== 200 || cookie === "") throw new Error(`soak crhs: admin login failed with HTTP ${login.status}`);

	const durableDb = new DatabaseSync(durableDbPath, { readOnly: true, timeout: 5_000 });
	const countEntries = durableDb.prepare("SELECT count(*) AS c FROM pi_entries");
	const countCompactions = durableDb.prepare(
		"SELECT count(*) AS c FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.compaction'",
	);

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await scheduler.stop();
		await runtime.close();
		await opened.close();
		cluster.endWaits();
		taskGroups.endWaits();
		await cluster.close();
		await taskGroups.close();
		await agents.close();
		await audit.flush();
		const closeable = server as unknown as { closeAllConnections?: () => void };
		closeable.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await db.destroy();
		durableDb.close();
	};

	const stats = async (progress: WorkloadProgress): Promise<RuntimeStats> => {
		const counts = await sql<{ tasks: number; audit_events: number; sessions: number }>`
			SELECT
				(SELECT count(*) FROM tasks) AS tasks,
				(SELECT count(*) FROM audit_events) AS audit_events,
				(SELECT count(*) FROM sessions) AS sessions
		`.execute(db);
		const failed = await sql<{ c: number }>`
			SELECT count(*) AS c FROM tasks
			WHERE state = 'failed' OR timed_out = 1 OR (exit_code IS NOT NULL AND exit_code <> 0)
		`.execute(db);
		const row = counts.rows[0];
		const memory = process.memoryUsage();
		const durationMs = progress.startedAt === 0 ? 0 : (progress.endedAt || performance.now()) - progress.startedAt;
		return {
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
			rssBytes: memory.rss,
			tasks: Number(row?.tasks ?? 0),
			auditEvents: Number(row?.audit_events ?? 0),
			sessions: Number(row?.sessions ?? 0),
			piEntries: Number((countEntries.get() as { c?: number } | undefined)?.c ?? 0),
			compactions: Number((countCompactions.get() as { c?: number } | undefined)?.c ?? 0),
			tasksFailed: Number(failed.rows[0]?.c ?? 0),
			turnsDone: progress.turnsDone,
			toolCallsDone: progress.toolCallsDone,
			turnP50Ms: percentile(progress.latenciesMs, 0.5),
			turnP95Ms: percentile(progress.latenciesMs, 0.95),
			durationMs,
			failures: [...progress.failures],
			parallelism: { ...progress.parallelism },
		};
	};

	return {
		db,
		runtime,
		faux,
		owner: { sessionId: "soak", userId: user.id, username: user.username, kind: "admin" },
		url,
		cookie,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
		paths: { db: dbPath, durableDir, durableDb: durableDbPath },
		stats,
		close,
	};
}
