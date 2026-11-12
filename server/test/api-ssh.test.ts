import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit, type AuditEvent } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import { createNodeGroup, type NodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { nodeRoute } from "../src/cluster/ssh/nodes.ts";
import { secretAad } from "../src/keys/export.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const KEY_A = `SHA256:${"A".repeat(43)}`;
const KEY_B = `SHA256:${"B".repeat(43)}`;

describeBackends("api ssh nodes", (backend) => {
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let app: App;
	let masterKey: MasterKey;
	const ids: Record<string, string> = {};
	const cookies: Record<string, string> = {};
	let credId: string;
	let jumpCredId: string;
	let sshId: string;
	let crhaId: string;
	let webGroup: NodeGroup;

	const req = (who: string, path: string, body?: unknown, method?: string) =>
		call(app, path, { cookie: cookies[who], body, method });
	const target = (extra: object = {}) => ({
		host: "127.0.0.1",
		port: 1,
		user: "root",
		hostFingerprint: KEY_B,
		credentialId: credId,
		...extra,
	});
	const grant = async (nodeId: string, who: string) =>
		expect(
			(
				await req("root", "/api/node-access-grants", {
					granteeType: "user",
					granteeId: ids[who],
					targetType: "node",
					targetId: nodeId,
				})
			).status,
		).toBe(201);
	const auditEvents = async (action: string): Promise<AuditEvent[]> => {
		await audit.flush();
		const res = await req("root", `/api/audit?action=${action}`);
		return ((await res.json()) as { items: AuditEvent[] }).items;
	};
	/** The decrypted private key of a credential, to check which hop uses it. */
	const privateKeyOf = async (id: string): Promise<string> => {
		const cred = await db
			.selectFrom("ssh_credentials")
			.select("secret_id")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		const secret = await db
			.selectFrom("secrets")
			.selectAll()
			.where("id", "=", cred.secret_id)
			.executeTakeFirstOrThrow();
		return masterKey.decrypt(secret.ciphertext, secretAad(secret.id, secret.kind)).toString("utf8");
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		masterKey = MasterKey.generate();
		app = makeApp(db, undefined, { masterKey, serverFingerprint: "fp-test", audit, cluster });
		for (const [name, kind] of [
			["root", "admin"],
			["owner", "member"],
			["op", "member"],
			["viewer", "member"],
			["stranger", "member"],
		] as const) {
			ids[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
			cookies[name] = await login(app, name, "password-123");
		}
		const cred = await req("root", "/api/ssh-credentials", { name: "my key" });
		expect(cred.status).toBe(201);
		credId = ((await cred.json()) as { credential: { id: string } }).credential.id;
		const jumpCred = await req("root", "/api/ssh-credentials", { name: "jump key" });
		expect(jumpCred.status).toBe(201);
		jumpCredId = ((await jumpCred.json()) as { credential: { id: string } }).credential.id;

		const res = await req("root", "/api/ssh-nodes", {
			name: "box",
			jumps: [{ host: "127.0.0.1", port: 2222, user: "jumper", hostFingerprint: KEY_A, credentialId: jumpCredId }],
			host: "target.example",
			user: "deploy",
			hostFingerprint: KEY_B,
			credentialId: credId,
		});
		expect(res.status).toBe(201);
		sshId = ((await res.json()) as { node: { id: string } }).node.id;
		webGroup = await createNodeGroup(db, await defaultOrgId(db), "web");
		await setNodeGroupsForNode(db, sshId, [webGroup.id]);

		const tokenRes = await req("root", "/api/enrollment-tokens", {});
		const token = ((await tokenRes.json()) as { token: string }).token;
		crhaId = (
			await enrollNode(db, {
				secret: parseEnrollmentToken(token).secret,
				publicKey: new Uint8Array(randomBytes(32)),
				hostname: "crha-box",
				facts: {},
				clientVersion: "1",
			})
		).id;
		await grant(sshId, "viewer");
		await grant(sshId, "op");
		await grant(sshId, "owner");
		await grant(crhaId, "op");
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("creates a credential with a public key and deletes it only when unused", async () => {
		const res = await req("root", "/api/ssh-credentials", { name: "other" });
		const body = (await res.json()) as {
			credential: { id: string; name: string; publicKey: string; usedBy: unknown[] };
		};
		expect(body.credential.name).toBe("other");
		expect(body.credential.publicKey).toMatch(/^ssh-ed25519 /);
		expect(body.credential.usedBy).toEqual([]);
		expect((await req("op", `/api/ssh-credentials/${body.credential.id}`, {}, "DELETE")).status).toBe(403);

		// The list names the nodes that use each credential on any hop: the target's own and the jump's.
		const listed = (await (await req("root", "/api/ssh-credentials")).json()) as {
			credentials: { id: string; usedBy: { id: string; name: string }[] }[];
		};
		expect(listed.credentials.find((credential) => credential.id === body.credential.id)?.usedBy).toEqual([]);
		expect(listed.credentials.find((credential) => credential.id === credId)?.usedBy).toEqual([
			{ id: sshId, name: "box" },
		]);
		expect(listed.credentials.find((credential) => credential.id === jumpCredId)?.usedBy).toEqual([
			{ id: sshId, name: "box" },
		]);
		for (const who of ["owner", "op", "viewer"]) {
			expect((await req(who, "/api/ssh-credentials")).status).toBe(403);
			expect((await req(who, "/api/ssh-credentials", { name: "not mine" })).status).toBe(403);
		}

		// The credential bound to the SSH node cannot be deleted while the node uses it.
		expect((await req("root", `/api/ssh-credentials/${credId}`, {}, "DELETE")).status).toBe(409);
		expect((await req("root", `/api/ssh-credentials/${body.credential.id}`, {}, "DELETE")).status).toBe(200);
		expect((await req("root", `/api/ssh-credentials/${body.credential.id}`, {}, "DELETE")).status).toBe(404);
	});

	it("refuses to delete a credential used only by a jump host", async () => {
		expect((await req("root", `/api/ssh-credentials/${jumpCredId}`, {}, "DELETE")).status).toBe(409);
	});

	it("loads each hop's own private key for the connection route", async () => {
		const node = (await db
			.selectFrom("nodes")
			.selectAll()
			.where("id", "=", sshId)
			.executeTakeFirstOrThrow()) as NodeRow;
		const route = await nodeRoute(db, masterKey, node);
		const [jump, targetHop] = route.hops;
		if (!jump || !targetHop) throw new Error("route is missing a hop");
		expect(jump.privateKey).toBe(await privateKeyOf(jumpCredId));
		expect(targetHop.privateKey).toBe(await privateKeyOf(credId));
		expect(jump.privateKey).not.toBe(targetHop.privateKey);
	});

	describe("creating and reading a node", () => {
		it("rejects unpinned hops", async () => {
			const res = await req("root", "/api/ssh-nodes", target({ hostFingerprint: undefined, name: "x" }));
			expect(res.status).toBe(400);
		});

		it("requires a credential on every hop", async () => {
			expect((await req("root", "/api/ssh-nodes", target({ credentialId: "", name: "x" }))).status).toBe(400);
			const res = await req("root", "/api/ssh-nodes", {
				...target({ name: "x" }),
				jumps: [{ host: "127.0.0.1", port: 2222, user: "jumper", hostFingerprint: KEY_A }],
			});
			expect(res.status).toBe(400);
		});

		it("probes without a credential for the probed hop", async () => {
			const res = await req("root", "/api/ssh-nodes/probe", { host: "127.0.0.1", port: 1, user: "root" });
			// The probe passed validation (no credential required) and failed to connect.
			expect(res.status).toBe(502);
		});

		it("shows route details to an administrator", async () => {
			for (const who of ["root"]) {
				const res = await req(who, `/api/nodes/${sshId}`);
				const body = (await res.json()) as {
					node: { transport: string; nodeGroups: { id: string; name: string }[] };
					ssh: { hops: unknown[] } | null;
				};
				expect(body.node.transport).toBe("ssh");
				expect(body.node.nodeGroups).toEqual([{ id: webGroup.id, name: "web" }]);
				expect(body.ssh).toEqual({
					hops: [
						{
							host: "127.0.0.1",
							port: 2222,
							user: "jumper",
							hostFingerprint: KEY_A,
							credentialId: jumpCredId,
							credential: { id: jumpCredId, name: "jump key" },
						},
						{
							host: "target.example",
							port: 22,
							user: "deploy",
							hostFingerprint: KEY_B,
							credentialId: credId,
							credential: { id: credId, name: "my key" },
						},
					],
				});
			}
		});

		it("hides route details from grantees, and has none for crha nodes", async () => {
			for (const who of ["viewer", "op"]) {
				const body = (await (await req(who, `/api/nodes/${sshId}`)).json()) as object;
				expect(body).toHaveProperty("node");
				expect(body).not.toHaveProperty("ssh");
			}
			const crha = (await (await req("root", `/api/nodes/${crhaId}`)).json()) as { ssh: unknown };
			expect(crha.ssh).toBeNull();
		});
	});

	describe("editing an SSH node's route", () => {
		const patch = (who: string, id: string, body: unknown) => req(who, `/api/nodes/${id}/ssh-route`, body, "PATCH");
		let editId: string;
		let oldTargetCredId: string;
		let oldJumpCredId: string;
		let newTargetCredId: string;
		let newJumpCredId: string;
		let oldHop: { host: string; port: number; user: string; hostFingerprint: string; credentialId: string };
		let oldTarget: { host: string; port: number; user: string; hostFingerprint: string; credentialId: string };
		let newHop: { host: string; port: number; user: string; hostFingerprint: string; credentialId: string };
		let newTarget: { host: string; port: number; user: string; hostFingerprint: string; credentialId: string };

		const credential = async (name: string): Promise<string> => {
			const res = await req("root", "/api/ssh-credentials", { name });
			return ((await res.json()) as { credential: { id: string } }).credential.id;
		};

		beforeAll(async () => {
			oldTargetCredId = await credential("old target key");
			oldJumpCredId = await credential("old jump key");
			newTargetCredId = await credential("new target key");
			newJumpCredId = await credential("new jump key");
			oldHop = {
				host: "old-jump.example",
				port: 2222,
				user: "jumper",
				hostFingerprint: KEY_A,
				credentialId: oldJumpCredId,
			};
			oldTarget = {
				host: "old.example",
				port: 22,
				user: "deploy",
				hostFingerprint: KEY_B,
				credentialId: oldTargetCredId,
			};
			newHop = {
				host: "new-jump.example",
				port: 2200,
				user: "jumper2",
				hostFingerprint: KEY_A,
				credentialId: newJumpCredId,
			};
			newTarget = {
				host: "new.example",
				port: 2022,
				user: "deploy2",
				hostFingerprint: KEY_B,
				credentialId: newTargetCredId,
			};
			const res = await req("root", "/api/ssh-nodes", {
				name: "edit-box",
				jumps: [oldHop],
				...oldTarget,
			});
			expect(res.status).toBe(201);
			editId = ((await res.json()) as { node: { id: string } }).node.id;
			await setNodeGroupsForNode(db, editId, [webGroup.id]);
		});

		it("is for administrators only and only for SSH nodes", async () => {
			for (const who of ["owner", "op", "viewer", "stranger"]) {
				expect((await patch(who, editId, { jumps: [newHop], ...newTarget })).status).toBe(403);
			}
			expect((await patch("root", crhaId, target())).status).toBe(400);
			expect((await patch("root", "no-such-node", target())).status).toBe(404);
		});

		it("rejects an unpinned hop", async () => {
			const res = await patch("root", editId, {
				...newTarget,
				hostFingerprint: undefined,
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("every hop needs a confirmed host fingerprint");
		});

		it("rejects a hop without a credential", async () => {
			const res = await patch("root", editId, {
				...newTarget,
				credentialId: "",
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("target: a credential is required");
		});

		it("rejects node groups, which are not part of the route", async () => {
			expect((await patch("root", editId, { ...oldTarget, nodeGroups: [] })).status).toBe(400);
		});

		it("replaces the route in place, closing the pooled connection and auditing before and after", async () => {
			const close = vi.spyOn(cluster, "closeSshNode");
			const res = await patch("root", editId, {
				jumps: [newHop],
				...newTarget,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				node: { id: string; name: string; nodeGroups: { id: string; name: string }[] };
			};
			// The node keeps its identity and node groups; only the route changes.
			expect(body.node).toMatchObject({
				id: editId,
				name: "edit-box",
				nodeGroups: [{ id: webGroup.id, name: "web" }],
			});
			expect(close).toHaveBeenCalledWith(editId);
			close.mockRestore();

			// Each hop keeps its own credential, jump included.
			const detail = (await (await req("root", `/api/nodes/${editId}`)).json()) as { ssh: { hops: unknown[] } };
			expect(detail.ssh).toEqual({
				hops: [
					{ ...newHop, credential: { id: newJumpCredId, name: "new jump key" } },
					{ ...newTarget, credential: { id: newTargetCredId, name: "new target key" } },
				],
			});

			const [event] = await auditEvents("node.ssh_route_changed");
			expect(event).toMatchObject({
				targetType: "node",
				targetId: editId,
				detail: {
					before: { hops: [oldHop, oldTarget] },
					after: { hops: [newHop, newTarget] },
				},
			});
		});

		it("moves credential usage to the new route, so the old credentials can be deleted", async () => {
			const listed = (await (await req("root", "/api/ssh-credentials")).json()) as {
				credentials: { id: string; usedBy: { id: string; name: string }[] }[];
			};
			for (const id of [oldTargetCredId, oldJumpCredId]) {
				expect(listed.credentials.find((credential) => credential.id === id)?.usedBy).toEqual([]);
				expect((await req("root", `/api/ssh-credentials/${id}`, {}, "DELETE")).status).toBe(200);
			}
			for (const id of [newTargetCredId, newJumpCredId]) {
				expect(listed.credentials.find((credential) => credential.id === id)?.usedBy).toEqual([
					{ id: editId, name: "edit-box" },
				]);
			}
		});
	});

	describe("node groups", () => {
		const put = (who: string, id: string, body: unknown) => req(who, `/api/nodes/${id}/node-groups`, body, "PUT");

		it("replaces, dedupes and clears, for SSH and crha nodes", async () => {
			const orgId = await defaultOrgId(db);
			const dbGroup = await createNodeGroup(db, orgId, "db");
			const dotted = await createNodeGroup(db, orgId, "a.b-c");
			let res = await put("root", sshId, { nodeGroups: ["db", "db", dotted.id] });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { nodeGroups: { id: string; name: string }[] }).nodeGroups).toEqual([
				{ id: dotted.id, name: "a.b-c" },
				{ id: dbGroup.id, name: "db" },
			]);
			res = await put("root", sshId, { nodeGroups: [] });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ nodeGroups: [] });
			const body = (await (await req("root", `/api/nodes/${sshId}`)).json()) as {
				node: { nodeGroups: { id: string; name: string }[] };
			};
			expect(body.node.nodeGroups).toEqual([]);

			// A crha node's node groups are crhs-managed; Facts does not report them.
			expect((await put("root", crhaId, { nodeGroups: [dbGroup.id] })).status).toBe(200);
			const crha = (await (await req("root", `/api/nodes/${crhaId}`)).json()) as {
				node: { nodeGroups: { id: string; name: string }[] };
			};
			expect(crha.node.nodeGroups).toEqual([{ id: dbGroup.id, name: "db" }]);
			await put("root", crhaId, { nodeGroups: [] });
		});

		it("rejects bad input", async () => {
			expect((await put("root", sshId, { nodeGroups: ["Bad Name"] })).status).toBe(400);
			expect((await put("root", sshId, { nodeGroups: ["no-such-group"] })).status).toBe(400);
			expect((await put("root", sshId, { nodeGroups: "web" })).status).toBe(400);
			expect((await put("root", sshId, { nodeGroups: [1] })).status).toBe(400);
			expect((await put("root", sshId, [])).status).toBe(400);
		});

		it("is for administrators only", async () => {
			for (const who of ["owner", "op", "viewer"]) {
				expect((await put(who, sshId, { nodeGroups: [] })).status).toBe(403);
			}
			expect((await put("stranger", sshId, { nodeGroups: [] })).status).toBe(404);
		});

		it("does not accept node groups when adding an SSH node", async () => {
			const res = await req("root", "/api/ssh-nodes", {
				...target({ hostFingerprint: KEY_B, name: "grouped" }),
				nodeGroups: [],
			});
			expect(res.status).toBe(400);
		});
	});

	describe("testing connections", () => {
		it("refuses unpinned hops before connecting", async () => {
			const res = await req("root", "/api/ssh-nodes/test", target({ hostFingerprint: undefined }));
			expect(res.status).toBe(400);
		});

		it("reports an unreachable host as 502 connect_failed", async () => {
			const res = await req("root", "/api/ssh-nodes/test", target());
			expect(res.status).toBe(502);
			expect(((await res.json()) as { code: string }).code).toBe("connect_failed");
		});

		it("tests a saved node for administrators only", async () => {
			expect((await req("viewer", `/api/nodes/${sshId}/ssh-test`, {})).status).toBe(403);
			expect((await req("op", `/api/nodes/${sshId}/ssh-test`, {})).status).toBe(403);
			expect((await req("stranger", `/api/nodes/${sshId}/ssh-test`, {})).status).toBe(404);
			expect((await req("root", `/api/nodes/${crhaId}/ssh-test`, {})).status).toBe(400);
			const res = await req("root", `/api/nodes/${sshId}/ssh-test`, {});
			expect(res.status).toBe(502);
			expect(((await res.json()) as { code: string }).code).toBe("connect_failed");
		});
	});
});
