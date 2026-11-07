import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import type { RuntimeHost } from "../src/agent/runtime-core.ts";
import { createScheduledSession } from "../src/agent/runtime-sessions.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createSchedule } from "../src/scheduler/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

/** What the fake Harness's conversations record, so the test can see which one was aborted. */
interface FakeConversation {
	id: number;
	abort: ReturnType<typeof vi.fn>;
}

/**
 * A RuntimeHost with a fake Harness: createScheduledSession only needs conversations to exist and to be
 * abortable, and the test has to observe which one is aborted.
 */
function fakeHost(db: Db, models: ModelConfig, conversations: FakeConversation[]): RuntimeHost {
	let created = 0;
	let releaseBoth!: () => void;
	const bothCreated = new Promise<void>((resolve) => {
		releaseBoth = resolve;
	});
	const harness = {
		createConversation: async () => {
			const conversation: FakeConversation = { id: conversations.length + 1, abort: vi.fn(async () => {}) };
			conversations.push(conversation);
			// Both calls must have passed the getSession check before either transaction runs, so the insert
			// conflict is what the test exercises rather than an earlier return.
			if (++created === 2) releaseBoth();
			await bothCreated;
			return conversation;
		},
	};
	return {
		db,
		models,
		context: BACKGROUND_CONTEXT,
		audit: undefined,
		closing: () => false,
		harness: () => harness,
		sessionList: { publishSession: () => {} },
	} as unknown as RuntimeHost;
}

describeBackends("createScheduledSession", (backend) => {
	let db: Db;
	let models: ModelConfig;
	let owner: SessionUser;
	let scheduleId: string;

	beforeEach(async () => {
		db = await openTestDb(backend);
		models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		const user = await createUser(db, { username: `scheduled-${backend}`, kind: "member" });
		owner = { sessionId: "test", userId: user.id, username: user.username, kind: user.kind };
		const schedule = await createSchedule(db, owner.userId, {
			name: "nightly check",
			prompt: "Check the nodes",
			model: model(),
			rulePreset: "yolo",
			tokenBudget: null,
			cron: "*/5 * * * *",
			timezone: "UTC",
			catchUp: false,
			enabled: true,
		});
		scheduleId = schedule.id;
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("returns one session when two concurrent calls build the same derived id", async () => {
		const conversations: FakeConversation[] = [];
		const host = fakeHost(db, models, conversations);
		const input = {
			id: "scheduled-run-1",
			title: "nightly check",
			model: model(),
			budgetRemaining: null,
			scheduleId,
		};

		const [first, second] = await Promise.all([
			createScheduledSession(host, owner, input),
			createScheduledSession(host, owner, input),
		]);

		expect(first.id).toBe(input.id);
		expect(second.id).toBe(input.id);
		const rows = await db.selectFrom("sessions").selectAll().where("id", "=", input.id).execute();
		expect(rows).toHaveLength(1);
		// Both calls opened a conversation; the winner's is attached to the row, the loser's was aborted.
		expect(conversations).toHaveLength(2);
		const winner = conversations.find((conversation) => String(conversation.id) === rows[0]?.conversation_id);
		expect(winner).toBeDefined();
		const losers = conversations.filter((conversation) => conversation !== winner);
		expect(losers).toHaveLength(1);
		expect(losers[0]?.abort).toHaveBeenCalledTimes(1);
		expect(winner?.abort).not.toHaveBeenCalled();
		// The rule set belongs to the one session.
		const rules = await db.selectFrom("rule_sets").selectAll().where("scope_id", "=", input.id).execute();
		expect(rules).toHaveLength(1);
	});
});
