import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../src/agent/models.ts";
import type { AgentRuntime, SessionEvent } from "../src/agent/runtime.ts";
import type { Audit } from "../src/audit/audit.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import type { Cluster } from "../src/cluster/cluster.ts";
import type { TaskGroups } from "../src/cluster/task-groups.ts";
import type { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type WatchCallback = (events: SessionEvent[]) => Promise<void> | void;

let db: Db;
let manager: ChannelManager;
let sessionId: string;
let callbacks: Map<string, WatchCallback>;
let stopped: string[];

/** The event-watch callback the manager gave the runtime, as the runtime would hold it. */
const watched = (): WatchCallback => {
	const callback = callbacks.get(sessionId);
	if (!callback) throw new Error("the manager did not watch the thread's session");
	return callback;
};

beforeEach(async () => {
	db = await openTestDb("sqlite");
	const channelId = newId();
	sessionId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("channels")
		.values({
			id: channelId,
			org_id: "org-watch-test",
			name: "watch-bot",
			kind: "telegram",
			enabled: 0,
			credentials_secret_id: null,
			config: null,
			link_instructions: null,
			cursor: null,
			created_at: now,
			updated_at: now,
		})
		.execute();
	await db
		.insertInto("channel_threads")
		.values({
			id: newId(),
			channel_id: channelId,
			platform: "telegram",
			chat_id: "4242",
			topic_id: null,
			session_id: sessionId,
			draft: null,
			current: 1,
			created_at: now,
			updated_at: now,
		})
		.execute();
	callbacks = new Map();
	stopped = [];
	const runtime = {
		closing: false,
		onSessionStateChanged: () => {},
		watch: async (id: string, callback: WatchCallback) => {
			callbacks.set(id, callback);
			return () => {
				stopped.push(id);
			};
		},
	} as unknown as AgentRuntime;
	manager = new ChannelManager({
		db,
		masterKey: {} as MasterKey,
		runtime,
		models: {} as ModelConfig,
		cluster: {} as Cluster,
		taskGroups: {} as TaskGroups,
		audit: { record: async () => {} } as unknown as Audit,
	});
	await manager.start();
});

afterEach(async () => {
	await manager.stop();
	await db.destroy();
});

describe("channel session watch", () => {
	it("keeps handling a batch when one event throws, so run_end cleanup still runs", async () => {
		await db.deleteFrom("channel_threads").where("session_id", "=", sessionId).execute();
		// A malformed message_end makes its handler throw; the run_end that follows must still release the watch.
		await watched()([{ type: "message_end" } as SessionEvent, { type: "run_end" } as SessionEvent]);
		await manager.sessionEventsSettled(sessionId);
		expect(manager.watchesSession(sessionId)).toBe(false);
		expect(stopped).toEqual([sessionId]);
	});

	it("handles a session's batches in order without making the runtime wait", async () => {
		// The callback returns at once, so a slow send never holds up the watch (which would replace pending
		// batches with a snapshot), while the manager's own queue keeps the batches in order.
		expect(watched()([{ type: "run_start" } as SessionEvent])).toBeUndefined();
		await db.deleteFrom("channel_threads").where("session_id", "=", sessionId).execute();
		expect(watched()([{ type: "run_end" } as SessionEvent])).toBeUndefined();
		await manager.sessionEventsSettled(sessionId);
		expect(manager.watchesSession(sessionId)).toBe(false);
	});
});
