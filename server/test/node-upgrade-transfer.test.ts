/**
 * A node.upgrade task on crhs (doc/design/distribution.md "The upgrade task"): its binary travels on a data
 * connection like a push, every member of a group hashes like the group's spec, and the kind goes only to a
 * node whose hello lists it (doc/design/protocol.md "Version negotiation").
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import { upgradeSpec } from "../src/cluster/node-upgrade.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { specSha256 } from "../src/privilege/payload.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

const BINARY = Buffer.alloc(70 * 1024, 0x42);

describe("node.upgrade transfers", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let ownerUserId = "";
	let transferRoot = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		transferRoot = await mkdtemp(join(tmpdir(), "crhs-upgrade-"));
		cluster = new Cluster(db, { transferRoot, reconnectGraceMs: 100, dataIdleTimeoutMs: 2000 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "admin", password: "password-123" })).id;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
		await rm(transferRoot, { recursive: true, force: true });
	});

	const actor = () => ({ type: "user" as const, id: ownerUserId, onBehalfOfUserId: ownerUserId });

	const addNode = async (name: string): Promise<{ node: NodeRow; key: ReturnType<typeof generateKeyPair> }> => {
		const key = generateKeyPair();
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name,
				transport: "client",
				status: "active",
				public_key: Buffer.from(key.publicKey).toString("base64"),
				hostname: name,
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
		return { node: await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow(), key };
	};

	/** Connects a node in ignore mode, which runs a privileged task without an authorization. */
	const connect = async (node: NodeRow, key: ReturnType<typeof generateKeyPair>, taskKinds: string[]) => {
		const crha: FakeCrha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { tasks: [], taskKinds, privilegedMode: "ignore" })).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return crha;
	};

	const startUpgrade = async (node: NodeRow) => {
		const sha256 = createHash("sha256").update(BINARY).digest();
		const location = await cluster.stageBytesForPush(BINARY);
		const transferId = randomUUID();
		const spec: TaskSpec = {
			...upgradeSpec({ version: "1.3.0", arch: "amd64", bytes: BINARY, sha256 }),
			endpoint: { kind: "crhs", transferId },
		} as TaskSpec;
		return cluster.createTask({
			nodeId: node.id,
			spec,
			privileged: true,
			outputMode: "status",
			transfer: JSON.stringify({ transferId, location }),
			actor: actor(),
		});
	};

	it("streams the binary on a data connection and ends with the node's result", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key, ["node.upgrade"]);
		const task = await startUpgrade(node);
		await waitFor("upgrade task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "node.upgrade") throw new Error("no upgrade spec");
		expect(start.privileged).toBe(true);
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		const chunks: Buffer[] = [];
		for (;;) {
			const frame = await data.next();
			if (frame.kind === "data") chunks.push(Buffer.from(frame.bytes));
			else if (frame.kind === "end") break;
			else throw new Error(`unexpected abort ${frame.code}`);
		}
		expect(Buffer.concat(chunks).equals(BINARY)).toBe(true);
		crha.exit(task.id);
		await waitFor("upgrade task exited", async () => (await cluster.getTask(task.id))?.state === "exited");
		const done = await cluster.getTask(task.id);
		expect(done?.action).toEqual({ type: "upgrade", version: "1.3.0", arch: "amd64" });
	});

	it("never sends node.upgrade to a node whose hello does not list it", async () => {
		const { node, key } = await addNode("old-crha");
		const crha = await connect(node, key, []);
		const task = await startUpgrade(node);
		await waitFor("upgrade refused", async () => (await cluster.getTask(task.id))?.state === "errored");
		expect((await cluster.getTask(task.id))?.errorCode).toBe("unsupported_kind");
		expect(crha.starts).toHaveLength(0);
	});

	it("hashes every member's spec alike: the transfer id is routing", () => {
		const sha256 = new Uint8Array(32).fill(1);
		const base = upgradeSpec({ version: "1.3.0", arch: "amd64", bytes: BINARY, sha256 }) as Extract<
			TaskSpec,
			{ kind: "node.upgrade" }
		>;
		const a = specSha256({ ...base, endpoint: { kind: "crhs", transferId: "a" } });
		const b = specSha256({ ...base, endpoint: { kind: "crhs", transferId: "b" } });
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	});
});
