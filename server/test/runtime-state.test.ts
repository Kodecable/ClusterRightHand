import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHost } from "../src/agent/runtime-core.ts";
import { reconcileSessionStates } from "../src/agent/runtime-state.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

/**
 * Startup reconciliation watches a resumed run so its end is recorded. When the runtime is closing, the
 * Harness refuses that submission and the rejection is not an error worth a stack on every shutdown
 * (doc/design/agent-runtime.md "Session state").
 */

let db: Db;

async function seedRunningSession(): Promise<string> {
	db = await openTestDb("sqlite");
	const user = await createUser(db, { username: "resume-owner", kind: "member", password: "password-123" });
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("sessions")
		.values({
			id,
			org_id: await defaultOrgId(db),
			owner_user_id: user.id,
			conversation_id: `conversation-${id}`,
			root_session_id: id,
			model: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
			status: "active",
			created_at: now,
			updated_at: now,
			archived_at: null,
			state: "running",
			last_submission_id: "7",
		})
		.execute();
	return id;
}

function host(closing: boolean, waitError: Error): RuntimeHost {
	return {
		db,
		context: {},
		harness: () => ({
			inspect: async () => ({ submissions: [{ id: 7, type: "input" }] }),
			submission: async () => ({
				wait: async () => {
					throw waitError;
				},
				status: async () => ({ status: "running" }),
			}),
		}),
		closing: () => closing,
	} as unknown as RuntimeHost;
}

afterEach(async () => {
	await db.destroy();
	vi.restoreAllMocks();
});

describe("reconcileSessionStates", () => {
	it("does not log a resumed run's failed end while the runtime is closing", async () => {
		await seedRunningSession();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await reconcileSessionStates(host(true, new Error("Harness is closed")));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(error).not.toHaveBeenCalled();
	});

	it("still logs the failure when the runtime is not closing", async () => {
		await seedRunningSession();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await reconcileSessionStates(host(false, new Error("durable write failed")));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(error).toHaveBeenCalledWith(
			"agent runtime: recording a resumed run's end failed:",
			expect.objectContaining({ message: "durable write failed" }),
		);
	});
});
