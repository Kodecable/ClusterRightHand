import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import type { NodeGroup } from "../src/cluster/node-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function addNode(db: Db, name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport: "client",
			status: "active",
			public_key: null,
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
	return id;
}

describeBackends("node and node group emoji API", (backend) => {
	let db: Db;
	let app: App;
	let audit: Audit;
	let rootCookie: string;
	let memberCookie: string;
	let nodeId: string;
	let groupId: string;

	const setNodeEmoji = (cookie: string, emoji: string | null, id = nodeId) =>
		call(app, `/api/nodes/${id}/emoji`, { method: "PUT", cookie, body: { emoji } });
	const setGroupEmoji = (cookie: string, emoji: string | null, id = groupId) =>
		call(app, `/api/node-groups/${id}/emoji`, { method: "PUT", cookie, body: { emoji } });
	const nodeEmoji = async (cookie: string, id = nodeId): Promise<string | null> => {
		const res = await call(app, `/api/nodes/${id}`, { cookie });
		expect(res.status).toBe(200);
		return ((await res.json()) as { node: { emoji: string | null } }).node.emoji;
	};
	// There is no single-group read route: the list is the node group "detail" the WebUI filters.
	const groupEmoji = async (cookie: string, id = groupId): Promise<string | null> => {
		const res = await call(app, "/api/node-groups", { cookie });
		expect(res.status).toBe(200);
		const groups = ((await res.json()) as { groups: { id: string; emoji: string | null }[] }).groups;
		return groups.find((group) => group.id === id)?.emoji ?? null;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		app = createApp(db, { clientAddress: () => "198.51.100.8", captcha: "none", audit });
		const root = await createUser(db, { username: "emoji-root", kind: "admin", password: "password-123" });
		const member = await createUser(db, { username: "emoji-member", kind: "member", password: "password-123" });
		nodeId = await addNode(db, "emoji-node");
		// A member sees the node only through a grant; without one it is hidden and answers 404.
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: member.id,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: root.id,
				created_at: new Date().toISOString(),
			})
			.execute();
		rootCookie = await login(app, "emoji-root", "password-123");
		memberCookie = await login(app, "emoji-member", "password-123");
		const created = await call(app, "/api/node-groups", {
			method: "POST",
			cookie: rootCookie,
			body: { name: "emoji-group" },
		});
		expect(created.status).toBe(201);
		groupId = ((await created.json()) as { group: NodeGroup }).group.id;
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("sets a trimmed node emoji and serves it on the detail and the list", async () => {
		const res = await setNodeEmoji(rootCookie, "  🇨🇳  ");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { node: { emoji: string | null; name: string } };
		expect(body.node.emoji).toBe("🇨🇳");
		expect(body.node.name).toBe("emoji-node");
		expect(await nodeEmoji(rootCookie)).toBe("🇨🇳");

		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; emoji: string | null }[];
		};
		expect(list.nodes.find((node) => node.id === nodeId)?.emoji).toBe("🇨🇳");
	});

	it("accepts one flag, skin tone, ZWJ sequence or keycap and rejects anything else", async () => {
		for (const emoji of ["👍🏽", "👨‍👩‍👧", "1️⃣"]) {
			expect((await setNodeEmoji(rootCookie, emoji)).status, emoji).toBe(200);
			expect(await nodeEmoji(rootCookie)).toBe(emoji);
		}
		for (const emoji of ["ab", "😀😀", "1", "©", "two words", "😀 ".repeat(2)]) {
			const res = await setNodeEmoji(rootCookie, emoji);
			expect(res.status, emoji).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/one emoji/);
		}
		// The refused values left the last accepted emoji in place.
		expect(await nodeEmoji(rootCookie)).toBe("1️⃣");
	});

	it("stores an empty or blank node emoji as null", async () => {
		expect((await setNodeEmoji(rootCookie, "😀")).status).toBe(200);
		const blank = await setNodeEmoji(rootCookie, "   ");
		expect(blank.status).toBe(200);
		expect(((await blank.json()) as { node: { emoji: string | null } }).node.emoji).toBeNull();
		expect(await nodeEmoji(rootCookie)).toBeNull();

		const explicit = await setNodeEmoji(rootCookie, null);
		expect(explicit.status).toBe(200);
		expect(((await explicit.json()) as { node: { emoji: string | null } }).node.emoji).toBeNull();
	});

	it("refuses members and hides the node from users without access", async () => {
		expect((await setNodeEmoji(memberCookie, "😀")).status).toBe(403);
		expect((await setNodeEmoji(rootCookie, "😀", "no-such-node")).status).toBe(404);
		expect((await call(app, `/api/nodes/${nodeId}/emoji`, { method: "PUT", body: { emoji: "😀" } })).status).toBe(401);
		expect(await nodeEmoji(rootCookie)).toBeNull();
	});

	it("audits the previous and the new node emoji", async () => {
		expect((await setNodeEmoji(rootCookie, "😀")).status).toBe(200);
		expect((await setNodeEmoji(rootCookie, "🐧")).status).toBe(200);
		await audit.flush();
		const rows = await db
			.selectFrom("audit_events")
			.select(["target_type", "target_id", "detail"])
			.where("action", "=", "node.emoji_set")
			.orderBy("seq", "desc")
			.execute();
		const [latest, first] = rows;
		expect(latest).toMatchObject({ target_type: "node", target_id: nodeId });
		expect(JSON.parse(latest?.detail ?? "null")).toEqual({ previous: "😀", emoji: "🐧" });
		expect(JSON.parse(first?.detail ?? "null")).toEqual({ previous: null, emoji: "😀" });
	});

	it("sets a node group emoji and serves it on the list and the detail", async () => {
		const res = await setGroupEmoji(rootCookie, "🚀");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { group: { emoji: string | null } }).group.emoji).toBe("🚀");
		expect(await groupEmoji(rootCookie)).toBe("🚀");

		const list = (await (await call(app, "/api/node-groups", { cookie: rootCookie })).json()) as {
			groups: { id: string; emoji: string | null }[];
		};
		expect(list.groups.find((group) => group.id === groupId)?.emoji).toBe("🚀");
	});

	it("refuses a bad node group emoji, members and an unknown group", async () => {
		for (const emoji of ["ab", "1", "😀😀"]) {
			const res = await setGroupEmoji(rootCookie, emoji);
			expect(res.status, emoji).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/one emoji/);
		}
		expect((await setGroupEmoji(memberCookie, "😀")).status).toBe(403);
		expect((await setGroupEmoji(rootCookie, "😀", "no-such-group")).status).toBe(404);
		expect(
			(await call(app, `/api/node-groups/${groupId}/emoji`, { method: "PUT", body: { emoji: "😀" } })).status,
		).toBe(401);
		expect(await groupEmoji(rootCookie)).toBe("🚀");
	});

	it("audits the previous and the new node group emoji", async () => {
		expect((await setGroupEmoji(rootCookie, "🌍")).status).toBe(200);
		await audit.flush();
		const rows = await db
			.selectFrom("audit_events")
			.select(["target_type", "target_id", "detail"])
			.where("action", "=", "node_group.emoji_set")
			.orderBy("seq", "desc")
			.execute();
		const [latest] = rows;
		expect(latest).toMatchObject({ target_type: "node_group", target_id: groupId });
		expect(JSON.parse(latest?.detail ?? "null")).toEqual({ previous: "🚀", emoji: "🌍" });
	});
});
