import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { externalCallId } from "../src/extensions/external-calls.ts";
import type { JobRow } from "../src/jobs/types.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { defaultSystemSettings, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Completion notices (doc/design/jobs.md "Completion notices"): a job that settles uncollected is `pending`, a
 * busy owner gets it in its next tool result, an idle owner is woken with a `crh.notice` entry, `job_wait`
 * collects it, and the wake cap counts wakes since the last user message.
 */
let db: Db;
let cluster: Cluster;
let taskGroups: TaskGroups;
let runtime: AgentRuntime;
let models: ModelConfig;
let store: SettingsStore;
let owner: SessionUser;
let root = "";
let storagePath = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const openStorage = () => openNodeSqliteStorage(storagePath, { prefix: "pi_" });

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function openRuntime(): Promise<void> {
	db = await openTestDb("sqlite");
	root = await mkdtemp(join(tmpdir(), "crhs-job-notices-"));
	storagePath = join(root, "durable.sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
	taskGroups = new TaskGroups(db, cluster, { audit });
	models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	store = SettingsStore.fromSystemSettings(defaultSystemSettings());
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	runtime = await AgentRuntime.open({
		callRunner: new CallRunner(),
		db,
		storage: openStorage,
		models,
		cluster,
		taskGroups,
		audit,
		settings: store,
	});
}

beforeEach(openRuntime);

afterEach(async () => {
	await runtime.close();
	await cluster.close();
	await taskGroups.close();
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	return session.id;
}

/** A `call` job over an external call row; `settle` moves the row and projects the job. */
async function callJob(sessionId: string, callKey = newId()): Promise<{ job: JobRow; callKey: string }> {
	const id = externalCallId(callKey);
	const now = new Date().toISOString();
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: await defaultOrgId(db),
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: owner.userId,
			extension_name: "fake",
			tool_name: "echo",
			arguments: JSON.stringify({ message: "secret-output" }),
			operation: JSON.stringify({ method: "ext.read", target: "fake/echo" }),
			annotations: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
			state: "running",
			created_at: now,
			finished_at: null,
			source_tool_task: null,
			tool_rev: null,
		})
		.execute();
	const job = await runtime.jobs?.ensure({
		kind: "call",
		callKey,
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
		sessionId,
		resourceType: "external_call",
		resourceId: id,
		action: { type: "extension_tool", extension: "fake", tool: "echo" },
	});
	if (!job) throw new Error("the job service is missing");
	return { job, callKey };
}

async function settle(job: JobRow, callKey: string, state: "succeeded" | "failed" = "succeeded"): Promise<void> {
	await db
		.updateTable("external_calls")
		.set({ state, finished_at: new Date().toISOString() })
		.where("id", "=", job.resource_id)
		.execute();
	await runtime.jobs?.callChanged(callKey);
}

const noticesOf = async (sessionId: string): Promise<{ kind: string; data?: unknown; text: string }[]> => {
	const page = await runtime.entriesPage(sessionId, undefined, 100);
	return page.entries
		.filter((entry) => entry.kind === "crh.notice")
		.map((entry) => ({
			kind: entry.kind,
			data: entry.data,
			text: (entry.model ?? [])
				.flatMap((message) => {
					if (message.role !== "user") return [];
					if (typeof message.content === "string") return [message.content];
					return Array.isArray(message.content)
						? message.content.flatMap((block) =>
								block.type === "text" && typeof block.text === "string" ? [block.text] : [],
							)
						: [];
				})
				.join("\n"),
		}));
};

const noticeWakes = async (sessionId: string): Promise<number> =>
	(await db.selectFrom("sessions").select("notice_wakes").where("id", "=", sessionId).executeTakeFirst())
		?.notice_wakes ?? -1;

describe("completion notices: state and wake", () => {
	it("wakes an idle owner with one crh.notice entry naming the job, and no output", async () => {
		const sessionId = await newSession();
		// A notice is not a user message: the source and the sent-time note stay as they were.
		await db.updateTable("sessions").set({ last_used_from: "web" }).where("id", "=", sessionId).execute();
		faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
		const { job, callKey } = await callJob(sessionId);
		await settle(job, callKey);

		const notices = await waitFor("the notice entry", async () => {
			const entries = await noticesOf(sessionId);
			return entries.length > 0 ? entries : undefined;
		});
		expect(notices).toHaveLength(1);
		const data = notices[0]?.data as { type: string; jobs: Record<string, unknown>[] };
		expect(data.type).toBe("jobs");
		expect(data.jobs).toEqual([
			{
				jobId: job.id,
				kind: "call",
				action: { type: "extension_tool", extension: "fake", tool: "echo" },
				outcome: { kind: "succeeded", failed: false },
				woke: true,
			},
		]);
		// Metadata only: the action and outcome, never the call's output.
		expect(notices[0]?.text).toContain("fake/echo");
		expect(notices[0]?.text).not.toContain("secret-output");
		expect(notices[0]?.text).toContain(`job ${job.id}`);
		expect(await noticeWakes(sessionId)).toBe(1);
		expect((await runtime.jobs?.get(job.id))?.notice).toBe("delivered");
		const source = await db
			.selectFrom("sessions")
			.select("last_used_from")
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();
		expect(source.last_used_from).toBe("web");
	});

	it("attaches a busy owner's pending notices to the next tool result and marks them delivered", async () => {
		const sessionId = await newSession();
		faux.setResponses([
			async () => {
				await sleep(200);
				return fauxAssistantMessage([fauxToolCall("job_list", {}, { id: "list-1" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("done")]),
		]);
		const submission = await runtime.submit(sessionId, owner, "go", "busy-1");
		const { job, callKey } = await callJob(sessionId);
		await settle(job, callKey);
		expect((await runtime.jobs?.get(job.id))?.notice).toBe("pending");
		expect(await runtime.waitForSubmission(submission)).toEqual({ status: "done" });

		const page = await runtime.entriesPage(sessionId, undefined, 100);
		const results = page.entries.flatMap((entry) =>
			(entry.model ?? []).flatMap((message) =>
				message.role === "toolResult"
					? message.content.flatMap((block) =>
							block.type === "text" && typeof block.text === "string" ? [block.text] : [],
						)
					: [],
			),
		);
		const block = results.find((text) => text.includes("<job-notices>")) ?? "";
		expect(block).not.toBe("");
		expect(block).toContain(`"job_id":"${job.id}"`);
		expect(block).toContain('"action":"fake/echo"');
		expect(block).not.toContain("secret-output");
		expect((await runtime.jobs?.get(job.id))?.notice).toBe("delivered");
		// The notice came with the tool result, not as a later wake input.
		expect(await noticesOf(sessionId)).toHaveLength(0);
	});

	it("collects a settled job read by job_wait and withdraws its notice", async () => {
		const sessionId = await newSession();
		faux.setResponses([
			async () => {
				await sleep(200);
				return fauxAssistantMessage([fauxText("turn answer")]);
			},
			fauxAssistantMessage([fauxText("wake answer")]),
		]);
		const submission = await runtime.submit(sessionId, owner, "go", "collect-1");
		const { job, callKey } = await callJob(sessionId);
		await settle(job, callKey);
		expect((await runtime.jobs?.get(job.id))?.notice).toBe("pending");
		// job_wait reads the settled job while the owner is busy: collected, so the queued wake has nothing left.
		await runtime.jobs?.waitJob(job, 0, { attention: true });
		expect((await runtime.jobs?.get(job.id))?.notice).toBe("collected");
		expect(await runtime.waitForSubmission(submission)).toEqual({ status: "done" });
		await sleep(100);
		expect(await noticesOf(sessionId)).toHaveLength(0);
		expect(await noticeWakes(sessionId)).toBe(0);
	});

	it("delivers several settles as one wake entry", async () => {
		const sessionId = await newSession();
		faux.setResponses([
			async () => {
				await sleep(250);
				return fauxAssistantMessage([fauxText("first turn")]);
			},
			fauxAssistantMessage([fauxText("woken")]),
		]);
		const submission = await runtime.submit(sessionId, owner, "go", "batch-1");
		const first = await callJob(sessionId);
		const second = await callJob(sessionId);
		await settle(first.job, first.callKey);
		await settle(second.job, second.callKey);
		expect(await runtime.waitForSubmission(submission)).toEqual({ status: "done" });
		const notices = await waitFor("the batched notice", async () => {
			const entries = await noticesOf(sessionId);
			return entries.length > 0 ? entries : undefined;
		});
		expect(notices).toHaveLength(1);
		const data = notices[0]?.data as { type: string; jobs: Record<string, unknown>[] };
		expect(data.jobs.map((job) => job.jobId).sort()).toEqual([first.job.id, second.job.id].sort());
		expect(await noticeWakes(sessionId)).toBe(1);
	});

	it("delivers two concurrent settles as one wake entry listing both", async () => {
		const sessionId = await newSession();
		faux.setResponses([fauxAssistantMessage([fauxText("woken once")])]);
		const first = await callJob(sessionId);
		const second = await callJob(sessionId);
		// Settle both rows first, then let both projections run together: absent per-session serialization, both
		// deliveries read the same pending set and submit duplicate wakes.
		await db
			.updateTable("external_calls")
			.set({ state: "succeeded", finished_at: new Date().toISOString() })
			.where("id", "in", [first.job.resource_id, second.job.resource_id])
			.execute();
		await Promise.all([runtime.jobs?.callChanged(first.callKey), runtime.jobs?.callChanged(second.callKey)]);
		const notices = await waitFor("the batched notice", async () => {
			const entries = await noticesOf(sessionId);
			return entries.length > 0 ? entries : undefined;
		});
		expect(notices).toHaveLength(1);
		const data = notices[0]?.data as { type: string; jobs: Record<string, unknown>[] };
		expect(data.jobs.map((job) => job.jobId).sort()).toEqual([first.job.id, second.job.id].sort());
		expect(await noticeWakes(sessionId)).toBe(1);
	});

	it("does not wake past jobs.max_consecutive_wakes, resets on a user message, and keeps the count across a restart", async () => {
		await store.patch(db, { jobs: { maxConsecutiveWakes: 2 } }, null);
		const sessionId = await newSession();
		for (let i = 0; i < 2; i++) {
			faux.setResponses([fauxAssistantMessage([fauxText(`wake ${i}`)])]);
			const { job, callKey } = await callJob(sessionId);
			await settle(job, callKey);
			await waitFor("the wake run to end", async () =>
				(await sessionStateOf(db, sessionId)) === "idle" && (await noticesOf(sessionId)).length === i + 1
					? true
					: undefined,
			);
		}
		expect(await noticeWakes(sessionId)).toBe(2);

		// Past the cap: the third settle stays pending and is not woken.
		const capped = await callJob(sessionId);
		await settle(capped.job, capped.callKey);
		await sleep(150);
		expect((await runtime.jobs?.get(capped.job.id))?.notice).toBe("pending");
		expect(await noticesOf(sessionId)).toHaveLength(2);
		expect(await noticeWakes(sessionId)).toBe(2);

		// A user-authored input resets the count, so the next settle wakes again.
		faux.setResponses([
			fauxAssistantMessage([fauxText("user answer")]),
			fauxAssistantMessage([fauxText("woken again")]),
		]);
		await runtime.submit(sessionId, owner, "hello again", "reset-1");
		expect(await noticeWakes(sessionId)).toBe(0);
		await waitFor("the user run to end", async () =>
			(await sessionStateOf(db, sessionId)) === "idle" ? true : undefined,
		);
		// The next turn's tool results may deliver the old pending notice first; settle a fresh job to see a wake.
		const afterReset = await callJob(sessionId);
		await settle(afterReset.job, afterReset.callKey);
		await waitFor("the post-reset wake", async () => ((await noticeWakes(sessionId)) === 1 ? true : undefined));

		// Reach the cap again, then restart: startup delivery and the next settle both respect the stored count.
		faux.setResponses([fauxAssistantMessage([fauxText("second wake")])]);
		const second = await callJob(sessionId);
		await settle(second.job, second.callKey);
		await waitFor("the second wake in the new chain", async () =>
			(await noticeWakes(sessionId)) === 2 ? true : undefined,
		);
		await runtime.close();
		runtime = await AgentRuntime.open({
			callRunner: new CallRunner(),
			db,
			storage: openStorage,
			models,
			cluster,
			taskGroups,
			audit: new Audit(db),
			settings: store,
		});
		faux.setResponses([fauxAssistantMessage([fauxText("unused")])]);
		const afterRestart = await callJob(sessionId);
		await settle(afterRestart.job, afterRestart.callKey);
		await sleep(150);
		expect((await runtime.jobs?.get(afterRestart.job.id))?.notice).toBe("pending");
		expect(await noticeWakes(sessionId)).toBe(2);
	});
});

describe("completion notices: startup and title", () => {
	it("delivers pending notices of settled jobs after a restart and skips collected ones", async () => {
		const sessionId = await newSession();
		const pending = await callJob(sessionId);
		const collected = await callJob(sessionId);
		const now = new Date().toISOString();
		for (const { job, notice } of [
			{ job: pending.job, notice: "pending" as const },
			{ job: collected.job, notice: "collected" as const },
		]) {
			await db
				.updateTable("jobs")
				.set({
					state: "settled",
					outcome: JSON.stringify({ kind: "succeeded", failed: false }),
					settled_at: now,
					notice,
				})
				.where("id", "=", job.id)
				.execute();
			await db
				.updateTable("external_calls")
				.set({ state: "succeeded", finished_at: now })
				.where("id", "=", job.resource_id)
				.execute();
		}
		await runtime.close();
		faux.setResponses([fauxAssistantMessage([fauxText("after restart")])]);
		runtime = await AgentRuntime.open({
			callRunner: new CallRunner(),
			db,
			storage: openStorage,
			models,
			cluster,
			taskGroups,
			audit: new Audit(db),
			settings: store,
		});
		const notices = await waitFor("the startup notice", async () => {
			const entries = await noticesOf(sessionId);
			return entries.length > 0 ? entries : undefined;
		});
		expect(notices).toHaveLength(1);
		const data = notices[0]?.data as { type: string; jobs: Record<string, unknown>[] };
		expect(data.jobs.map((job) => job.jobId)).toEqual([pending.job.id]);
		expect((await runtime.jobs?.get(pending.job.id))?.notice).toBe("delivered");
		expect((await runtime.jobs?.get(collected.job.id))?.notice).toBe("collected");
	});

	it("does not title a session from a notice wake", async () => {
		const sessionId = await newSession();
		faux.setResponses([fauxAssistantMessage([fauxText("wake answer")])]);
		const { job, callKey } = await callJob(sessionId);
		await settle(job, callKey);
		await waitFor("the wake run to end", async () =>
			(await noticesOf(sessionId)).length > 0 && (await sessionStateOf(db, sessionId)) === "idle" ? true : undefined,
		);
		// Title generation is background; give a wrong one time to run too.
		await sleep(150);
		const row = await db
			.selectFrom("sessions")
			.select(["title", "title_pending"])
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();
		expect(row.title).toBeNull();
		expect(row.title_pending).toBe(1);
		expect(faux.getPendingResponseCount()).toBe(0);
	});
});
