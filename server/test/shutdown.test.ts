import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { Db } from "../src/storage/db.ts";
import { openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";

// A SIGTERM must not lose the node.disconnected audit to a destroyed database.
describe("graceful shutdown", () => {
	let dir: string;
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let nodeId: string;
	let rejections: unknown[];
	let consoleErrors: string[];
	let destroyed: boolean;
	let onRejection: (reason: unknown) => void;

	const addNode = async (publicKey: Uint8Array): Promise<void> => {
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "shutdown-node",
				name_key: "shutdown-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(publicKey).toString("base64"),
				hostname: "shutdown-node",
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
				trust_report: null,
				trust_digest: null,
				trust_updated_at: null,
			})
			.execute();
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crh-shutdown-"));
		// A file database, so the test can reopen it after destroy() and check what was written.
		db = openDb({ driver: "sqlite", path: join(dir, "crhs.db") });
		await migrateToLatest(db);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit, reconnectGraceMs: 600_000 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		rejections = [];
		consoleErrors = [];
		destroyed = false;
		onRejection = (reason) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		process.off("unhandledRejection", onRejection);
		vi.restoreAllMocks();
		if (!destroyed) await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	it("waits for disconnect work before the database is destroyed", async () => {
		const key = generateKeyPair();
		await addNode(key.publicKey);
		const fake = await agents.connect(key, handshakeInit());
		await waitFor(
			"node connected",
			async () =>
				(
					await db
						.selectFrom("audit_events")
						.select("seq")
						.where("action", "=", "node.connected")
						.where("target_id", "=", nodeId)
						.execute()
				).length === 1,
		);

		await cluster.close();

		// close() resolved only once the disconnect audit and last_seen update were written.
		const events = await db
			.selectFrom("audit_events")
			.select(["action", "target_id"])
			.where("action", "=", "node.disconnected")
			.execute();
		expect(events).toEqual([{ action: "node.disconnected", target_id: nodeId }]);
		const node = await db.selectFrom("nodes").select("last_seen_at").where("id", "=", nodeId).executeTakeFirstOrThrow();
		expect(node.last_seen_at).not.toBeNull();
		expect(await fake.closed).toMatchObject({ code: 1000, reason: "server shutting down" });

		await agents.close();
		await db.destroy();
		destroyed = true;
		// Give a write that ignored close() a turn to reach the destroyed database.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(rejections).toEqual([]);
		expect(consoleErrors.filter((line) => /database is not open|already been destroyed/i.test(line))).toEqual([]);

		// The audit record was written durably and is readable on a fresh connection.
		const reopened = openDb({ driver: "sqlite", path: join(dir, "crhs.db") });
		try {
			const durable = await reopened
				.selectFrom("audit_events")
				.select(["action", "target_id"])
				.where("action", "=", "node.disconnected")
				.execute();
			expect(durable).toEqual([{ action: "node.disconnected", target_id: nodeId }]);
		} finally {
			await reopened.destroy();
		}
	});

	it("does not attach a node connection once shutdown has begun", async () => {
		const key = generateKeyPair();
		await addNode(key.publicKey);
		await cluster.close();
		// The handshake still succeeds at the wire level, but attach() closes the connection instead of
		// starting last_seen or audit writes after close() resolved.
		const fake = await agents.connect(key, handshakeInit());
		const closed = await fake.closed;
		expect(closed.reason).toBe("server shutting down");
		await agents.close();
		expect(rejections).toEqual([]);
	});
});
