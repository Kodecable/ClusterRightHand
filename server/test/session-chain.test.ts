import { afterAll, expect, it, vi } from "vitest";
import { MAX_SESSION_TREE_DEPTH, sessionAncestors, sessionChain } from "../src/sessions/session-chain.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** The upward walk stops on a corrupt parent cycle and at the tree depth bound. */
const db: Db = await openTestDb("sqlite");
const user = await createUser(db, { username: "owner", kind: "member" });
const orgId = await defaultOrgId(db);
const now = new Date().toISOString();

const addSession = async (id: string, parentSessionId: string | null): Promise<void> => {
	await db
		.insertInto("sessions")
		.values({
			id,
			org_id: orgId,
			owner_user_id: user.id,
			conversation_id: `conv-${id}`,
			parent_session_id: parentSessionId,
			root_session_id: "root",
			title: id,
			model: JSON.stringify({ provider: "test", modelId: "test" }),
			status: "active",
			created_at: now,
			updated_at: now,
			archived_at: null,
			last_submission_id: null,
			state: "idle",
			waiting_kind: null,
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: now,
			quota_tokens: null,
		})
		.execute();
};

afterAll(async () => {
	await db.destroy();
});

it("stops when a parent cycle would repeat a session", async () => {
	await addSession("cycle-a", "cycle-b");
	await addSession("cycle-b", "cycle-a");

	const chain: string[] = [];
	for await (const row of sessionAncestors(db, "cycle-a")) chain.push(row.id);
	expect(chain).toEqual(["cycle-a", "cycle-b"]);
});

it("stops after MAX_SESSION_TREE_DEPTH rows", async () => {
	const length = MAX_SESSION_TREE_DEPTH + 5;
	for (let index = 0; index < length; index++) {
		await addSession(`deep-${index}`, index === 0 ? null : `deep-${index - 1}`);
	}
	expect(await sessionChain(db, `deep-${length - 1}`)).toHaveLength(MAX_SESSION_TREE_DEPTH);
});
