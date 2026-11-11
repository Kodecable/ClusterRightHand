import { generateKeyPair } from "@crh/noise";
import { encode as encodeCbor, type Facts, handshakeInitCodec } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { createEnrollmentToken, enrollNode } from "../src/cluster/enrollment.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import { approveNode, findNodeByPublicKey, getNode } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { handshakeInit, TestAgentServer } from "./helpers/agent.ts";
import { type App, call, login } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const FACTS: Facts = {
	hostname: "old-host",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/crh-notes.md",
	clockOffsetMs: 0,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
};
const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };

describe("node re-enrollment over the agent protocol", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let app: App;
	let cookie: string;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db);
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "fp-test" };
		agents = await TestAgentServer.start(db, identity, cluster);
		app = createApp(db, {
			cluster,
			serverFingerprint: "fp-test",
			clientAddress: () => "198.51.100.7",
			captcha: "none",
		});
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		cookie = await login(app, "root", "password-123");
	});
	afterAll(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	it("re-enrolls by replacing the key, closing the old connection, and refusing the old key", async () => {
		const admin = await db.selectFrom("users").select("id").where("username", "=", "root").executeTakeFirstOrThrow();
		const oldKey = generateKeyPair();
		const { token: oldToken } = await createEnrollmentToken(db, {
			userId: admin.id,
			serverFingerprint: "fp-test",
		});
		const node = await enrollNode(db, {
			secret: oldToken.split(".")[2] ?? "",
			publicKey: oldKey.publicKey,
			hostname: "old-host",
			facts: FACTS,
			clientVersion: "1",
		});
		await approveNode(db, node.id, admin.id);

		const old = await agents.connect(oldKey, handshakeInit());
		expect(await old.peer.request("hello", HELLO)).toEqual({ acks: [] });
		expect(cluster.isConnected(node.id)).toBe(true);

		const tokenRes = await call(app, `/api/nodes/${node.id}/reenroll`, { cookie, body: {} });
		expect(tokenRes.status).toBe(201);
		const { token } = (await tokenRes.json()) as { token: string };

		const newKey = generateKeyPair();
		const fresh = await agents.connect(
			newKey,
			handshakeInit({
				enroll: {
					tokenSecret: token.split(".")[2] ?? "",
					hostname: "new-host",
					facts: { ...FACTS, hostname: "new-host" },
				},
			}),
		);
		expect(fresh.response).toMatchObject({ nodeId: node.id, nodeState: "pending" });
		fresh.peer.onEvent("node.status", () => {});
		// The old connection authenticated with the replaced key and is closed at once.
		await expect(old.closed).resolves.toEqual({ code: 1000, reason: "node re-enrolled" });

		const row = await getNode(db, node.id);
		expect(row).toMatchObject({ id: node.id, name: node.name, status: "pending", hostname: "new-host" });
		expect(await findNodeByPublicKey(db, oldKey.publicKey)).toBeUndefined();
		expect((await findNodeByPublicKey(db, newKey.publicKey))?.id).toBe(node.id);

		// The old key no longer authenticates, even though the node still exists.
		const { ws, hs, closed } = await agents.prepare(oldKey);
		ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit()))));
		await expect(closed).resolves.toEqual({ code: 1008, reason: "unknown node" });

		// The administrator approves the new fingerprint as usual.
		const approval = await call(app, `/api/nodes/${node.id}/approve`, { cookie, body: {} });
		expect(approval.status).toBe(200);
		expect((await getNode(db, node.id))?.status).toBe("active");
		await expect(fresh.closed).resolves.toMatchObject({ code: 1000 });
	});
});
