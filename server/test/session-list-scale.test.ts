import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { SessionListItem } from "../src/agent/session-list.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

/**
 * The session list at the size the WebUI is designed for (doc/webui.md#性能与质量目标): 100,000 root
 * sessions, bulk inserted. The test checks mine/all/search correctness and prints the timings; it does not
 * assert them, since a slow CI machine says nothing about the query.
 */
const COUNT = 100_000;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const NEEDLES = 10;

let db: Db;
let app: App;
let runtime: AgentRuntime;
let aliceCookie = "";
let adminCookie = "";
let aliceId = "";
let bobId = "";
const ids: string[] = [];
const owners: string[] = [];
const times: string[] = [];
const titles: string[] = [];

const updatedAt = (index: number) => new Date(BASE_MS + index * 1_000).toISOString();
const idOf = (index: number) => `session-${String(index).padStart(6, "0")}`;

/** The expected page for one predicate, in the list's order (updated_at desc, id desc). */
function expected(filter: (index: number) => boolean, limit: number): string[] {
	const matches: number[] = [];
	for (let index = 0; index < COUNT; index++) if (filter(index)) matches.push(index);
	matches.sort((left, right) => {
		const time = (times[right] as string).localeCompare(times[left] as string);
		return time !== 0 ? time : (ids[right] as string).localeCompare(ids[left] as string);
	});
	return matches.slice(0, limit).map((index) => ids[index] as string);
}

const list = async (
	cookie: string,
	query: string,
): Promise<{ items: SessionListItem[]; nextCursor: string | null }> => {
	const res = await call(app, `/api/sessions${query}`, { cookie });
	expect(res.status).toBe(200);
	return (await res.json()) as { items: SessionListItem[]; nextCursor: string | null };
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
	const started = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - started };
};

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	const faux = fauxProvider();
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	const alice = await createUser(db, { username: "alice", kind: "member", password: "scale-password" });
	const bob = await createUser(db, { username: "bob", kind: "member", password: "scale-password" });
	await createUser(db, { username: "root", kind: "admin", password: "scale-password" });
	aliceId = alice.id;
	bobId = bob.id;
	aliceCookie = await login(app, "alice", "scale-password");
	adminCookie = await login(app, "root", "scale-password");
	const orgId = await defaultOrgId(db);
	const model = JSON.stringify({ provider: "faux", modelId: faux.getModel().id });
	const started = performance.now();
	for (let index = 0; index < COUNT; index++) {
		// Every tenth session belongs to bob; needles are spread over alice's sessions, plus the two
		// titles that pin down LIKE escaping.
		ids.push(idOf(index));
		owners.push(index % 10 === 0 ? bobId : aliceId);
		times.push(updatedAt(index));
		titles.push(
			index % 10_000 === 5
				? `needle ${index} in the haystack`
				: index === 1
					? "100% percent"
					: index === 2
						? "under_score"
						: `session ${index}`,
		);
	}
	await db.transaction().execute(async (trx) => {
		for (let start = 0; start < COUNT; start += 500) {
			const rows = [];
			for (let index = start; index < Math.min(start + 500, COUNT); index++) {
				rows.push({
					id: ids[index] as string,
					org_id: orgId,
					owner_user_id: owners[index] as string,
					conversation_id: `conv-${index}`,
					parent_session_id: null,
					schedule_id: null,
					title: titles[index] as string,
					model,
					status: "active" as const,
					created_at: times[index] as string,
					updated_at: times[index] as string,
					archived_at: null,
					last_submission_id: null,
					state: "active" as const,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: times[index] as string,
					quota_tokens: null,
				});
			}
			await trx.insertInto("sessions").values(rows).execute();
		}
	});
	console.log(`seeded ${COUNT} sessions in ${(performance.now() - started).toFixed(0)} ms`);
}, 600_000);

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("pages mine, all and a search correctly at 100,000 sessions, and reports the timings", async () => {
	const mine = await timed(() => list(aliceCookie, "?limit=50"));
	expect(mine.value.items).toHaveLength(50);
	expect(mine.value.nextCursor).not.toBeNull();
	expect(mine.value.items.map((item) => item.id)).toEqual(expected((index) => owners[index] === aliceId, 50));
	// A second page continues without repeating anything from the first.
	const mineSecond = await timed(() =>
		list(aliceCookie, `?limit=50&cursor=${encodeURIComponent(mine.value.nextCursor as string)}`),
	);
	expect(mineSecond.value.items).toHaveLength(50);
	expect(mineSecond.value.items.map((item) => item.id)).toEqual(
		expected((index) => owners[index] === aliceId, 100).slice(50),
	);
	expect(mineSecond.value.items.some((item) => mine.value.items.some((first) => first.id === item.id))).toBe(false);

	const all = await timed(() => list(adminCookie, "?scope=all&limit=50"));
	expect(all.value.items).toHaveLength(50);
	expect(all.value.items.map((item) => item.id)).toEqual(expected(() => true, 50));
	expect(all.value.items[0]?.id).toBe(idOf(COUNT - 1));

	const search = await timed(() => list(aliceCookie, "?q=needle&limit=50"));
	expect(search.value.items).toHaveLength(NEEDLES);
	expect(search.value.items.every((item) => item.title.includes("needle"))).toBe(true);
	expect(search.value.items.map((item) => item.id)).toEqual(expected((index) => index % 10_000 === 5, 50));

	const percent = await list(aliceCookie, `?q=${encodeURIComponent("%")}`);
	expect(percent.items.map((item) => item.title)).toEqual(["100% percent"]);
	const underscore = await list(aliceCookie, "?q=_");
	expect(underscore.items.map((item) => item.title)).toEqual(["under_score"]);

	console.log(
		`timings: mine ${mine.ms.toFixed(1)} ms, mine page 2 ${mineSecond.ms.toFixed(1)} ms, ` +
			`all ${all.ms.toFixed(1)} ms, search ${search.ms.toFixed(1)} ms (${COUNT} sessions)`,
	);
});
