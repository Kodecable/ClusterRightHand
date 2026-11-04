import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import { createNodeGroup, type NodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const KEY_A = `SHA256:${"A".repeat(43)}`;
const KEY_B = `SHA256:${"B".repeat(43)}`;

describeBackends("api ssh nodes", (backend) => {
	let db: Db;
	let app: App;
	const ids: Record<string, string> = {};
	const cookies: Record<string, string> = {};
	let credId: string;
	let sshId: string;
	let crhaId: string;
	let webGroup: NodeGroup;

	const req = (who: string, path: string, body?: unknown, method?: string) =>
		call(app, path, { cookie: cookies[who], body, method });
	const target = (extra: object = {}) => ({
		host: "127.0.0.1",
		port: 1,
		user: "root",
		hostKey: KEY_B,
		credentialId: credId,
		...extra,
	});
	const share = async (nodeId: string, who: string, access: string) =>
		expect(
			(await req("owner", `/api/nodes/${nodeId}/shares`, { granteeType: "user", granteeId: ids[who], access }, "PUT"))
				.status,
		).toBe(200);

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = makeApp(db, undefined, { masterKey: MasterKey.generate(), serverFingerprint: "fp-test" });
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
		const cred = await req("owner", "/api/ssh-credentials", { name: "my key" });
		expect(cred.status).toBe(201);
		credId = ((await cred.json()) as { credential: { id: string } }).credential.id;

		const res = await req("owner", "/api/ssh-nodes", {
			name: "box",
			jumps: [{ host: "127.0.0.1", port: 2222, user: "jumper", hostKey: KEY_A }],
			host: "target.example",
			user: "deploy",
			hostKey: KEY_B,
			credentialId: credId,
		});
		expect(res.status).toBe(201);
		sshId = ((await res.json()) as { node: { id: string } }).node.id;
		webGroup = await createNodeGroup(db, await defaultOrgId(db), "web");
		await setNodeGroupsForNode(db, sshId, [webGroup.id]);

		const tokenRes = await req("owner", "/api/enrollment-tokens", {});
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
		await share(sshId, "viewer", "view");
		await share(sshId, "op", "operate");
		await share(crhaId, "op", "operate");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("creates a credential with a public key", async () => {
		const res = await req("owner", "/api/ssh-credentials", { name: "other" });
		const body = (await res.json()) as { credential: { name: string; publicKey: string } };
		expect(body.credential.name).toBe("other");
		expect(body.credential.publicKey).toMatch(/^ssh-ed25519 /);
	});

	describe("creating and reading a node", () => {
		it("rejects unpinned hops", async () => {
			const res = await req("owner", "/api/ssh-nodes", target({ hostKey: undefined, name: "x" }));
			expect(res.status).toBe(400);
		});

		it("shows route details to the owner and admin", async () => {
			for (const who of ["owner", "root"]) {
				const res = await req(who, `/api/nodes/${sshId}`);
				const body = (await res.json()) as {
					node: { transport: string; nodeGroups: { id: string; name: string }[] };
					ssh: { hops: unknown[]; credential: unknown } | null;
				};
				expect(body.node.transport).toBe("ssh");
				expect(body.node.nodeGroups).toEqual([{ id: webGroup.id, name: "web" }]);
				expect(body.ssh).toEqual({
					hops: [
						{ host: "127.0.0.1", port: 2222, user: "jumper", hostKey: KEY_A },
						{ host: "target.example", port: 22, user: "deploy", hostKey: KEY_B },
					],
					credential: { id: credId, name: "my key" },
				});
			}
		});

		it("hides route details from shared users, and has none for crha nodes", async () => {
			for (const who of ["viewer", "op"]) {
				const body = (await (await req(who, `/api/nodes/${sshId}`)).json()) as object;
				expect(body).toHaveProperty("node");
				expect(body).not.toHaveProperty("ssh");
			}
			const crha = (await (await req("owner", `/api/nodes/${crhaId}`)).json()) as { ssh: unknown };
			expect(crha.ssh).toBeNull();
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
			const body = (await (await req("owner", `/api/nodes/${sshId}`)).json()) as {
				node: { nodeGroups: { id: string; name: string }[] };
			};
			expect(body.node.nodeGroups).toEqual([]);

			// A crha node's node groups are crhs-managed too (Facts.groups is ignored).
			expect((await put("root", crhaId, { nodeGroups: [dbGroup.id] })).status).toBe(200);
			const crha = (await (await req("owner", `/api/nodes/${crhaId}`)).json()) as {
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
			const res = await req("owner", "/api/ssh-nodes", {
				...target({ hostKey: KEY_B, name: "grouped" }),
				nodeGroups: [],
			});
			expect(res.status).toBe(400);
		});
	});

	describe("testing connections", () => {
		it("refuses unpinned hops before connecting", async () => {
			const res = await req("owner", "/api/ssh-nodes/test", target({ hostKey: undefined }));
			expect(res.status).toBe(400);
		});

		it("reports an unreachable host as 502 connect_failed", async () => {
			const res = await req("owner", "/api/ssh-nodes/test", target());
			expect(res.status).toBe(502);
			expect(((await res.json()) as { code: string }).code).toBe("connect_failed");
		});

		it("tests a saved node for those who may operate it", async () => {
			expect((await req("viewer", `/api/nodes/${sshId}/ssh-test`, {})).status).toBe(403);
			expect((await req("stranger", `/api/nodes/${sshId}/ssh-test`, {})).status).toBe(404);
			expect((await req("op", `/api/nodes/${crhaId}/ssh-test`, {})).status).toBe(400);
			for (const who of ["owner", "op", "root"]) {
				const res = await req(who, `/api/nodes/${sshId}/ssh-test`, {});
				expect(res.status).toBe(502);
				expect(((await res.json()) as { code: string }).code).toBe("connect_failed");
			}
		});
	});
});
