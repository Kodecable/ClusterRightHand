import type { Context } from "@earendil-works/chord/context";
import type {
	AgentEvent,
	CompactionSettings,
	Conversation,
	ConversationId,
	Harness,
	Storage,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Audit } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { StoredRuleSet } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError } from "../users/service.ts";
import type { ModelConfig, ModelRef } from "./models.ts";
import type { SessionRow } from "./session-chain.ts";
import type { SessionListHub } from "./session-list.ts";
import type { SessionState, WaitingKind } from "./session-state.ts";

/**
 * The pieces every runtime module shares: the services, the open Harness and the runtime's caches. One
 * instance per `AgentRuntime`, which delegates its public API to the modules that take it (doc/agent-runtime.md).
 * pi-durable types stay inside these modules; the facade's public API has none.
 */

export interface SessionView {
	id: string;
	title: string;
	ownerUserId: string;
	parentSessionId: string | null;
	/** The schedule whose run created this session; null for every other session (doc/scheduling.md). */
	scheduleId: string | null;
	model: ModelRef;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	rules: StoredRuleSet | null;
	/** The session's own run state (doc/agent-runtime.md#会话状态). */
	state: SessionState;
	/** Why the session waits; null unless `state` is `awaiting`. */
	waitingKind: WaitingKind | null;
	/** While awaiting a quota: the exhausted level to top up. */
	waitingLevelId: string | null;
	/** Remaining budget tokens; null: unlimited. Signed: a response may overspend it (D92). */
	budgetRemaining: number | null;
	/** The budget measure: output tokens spent by this session and its subagents (D92, D101). */
	budgetUsedTokens: number;
	/** The statistics measure: input + output tokens of this session and its subagents (D101). */
	usageTokens: number;
	/** The input size of this session's own last main-agent call; null before the first (D101). */
	contextTokens: number | null;
}

/** An approval handed to an ancestor session's agent (doc/agent-runtime.md#处理子会话的请求). */
export interface AgentRequestView {
	kind: "task" | "group" | "quota";
	id: string;
	/** The subagent session whose task waits. */
	sessionId: string;
	summary: string;
	nodeId: string | null;
	createdAt: string;
}

/** What a UI receives: a snapshot to start from, then batches of events (pi-durable's agent events, for now). */
export type SessionEvent = AgentEvent;

/** The session a conversation belongs to, for the tools' per-call lookups (the mapping never changes). */
export interface SessionInfo {
	id: string;
	ownerUserId: string;
	orgId: string;
	parentSessionId: string | null;
}

/** Requests waiting for one handler's agent, loaded from the database and invalidated on approval changes. */
export interface Inbox {
	requests: Map<string, AgentRequestView>;
	loaded: boolean;
	/** Resolved when the pending set may have changed; `waitSubagent` uses this instead of polling. */
	waiters: Set<() => void>;
}

export interface AgentRuntimeOptions {
	db: Db;
	/**
	 * The durable storage, or a function that opens it. With a function, a Harness that fails (a storage error
	 * closes it, doc/agent-runtime.md#测试策略) is reopened on fresh storage, with backoff.
	 */
	storage: Storage | (() => Promise<Storage>);
	models: ModelConfig;
	cluster: Cluster;
	groups: TaskGroups;
	audit?: Audit;
	/**
	 * How long idle conversations keep their context and documents in memory (durable's default: 10 minutes).
	 * Memory grows with what was active within this window (doc/agent-runtime.md#2-性能和内存回归).
	 */
	retentionMs?: number;
	/** Set by clusterExtension; removed from a conversation that has reached the subagent depth limit. */
	subagentTool?: ToolRegistration;
	/**
	 * Compaction policy override; the pi defaults when omitted (doc/agent-runtime.md#默认值). Tests use it to
	 * make a compaction happen with a few messages.
	 */
	compaction?: CompactionSettings;
	/** How long session-list writes are coalesced before one SSE upsert; 150 ms by default. */
	sessionList?: { coalesceMs?: number };
}

/** What every runtime module works with; `AgentRuntime` fills it in and owns it. */
export interface RuntimeHost {
	readonly db: Db;
	readonly options: AgentRuntimeOptions;
	readonly models: ModelConfig;
	readonly audit: Audit | undefined;
	readonly cluster: Cluster;
	readonly groups: TaskGroups;
	readonly context: Context;
	readonly sessionList: SessionListHub;
	/** The open Harness; a failed one is replaced on reopen, so always read it through here. */
	harness(): Harness;
	/** Whether close() has begun: the Harness refuses every new operation from here on. */
	closing(): boolean;
	/** Sessions being stopped: their run ends during the stop, and the stop, not the run end, ends their waits. */
	readonly stopping: Set<string>;
	/** conversation id -> session, for the tools' per-call lookups (the mapping never changes). */
	readonly sessionsByConversation: Map<string, SessionInfo>;
	/** Sessions known to have subagents; checked once per session, then cheap. */
	readonly subagentParents: Set<string>;
	/** Pending requests by handler, a cache over tasks/task_groups/quota waits. */
	readonly inboxes: Map<string, Inbox>;
	/** Waiters for a quota wait's session; grant/deny/abort/quota edit wakes them. */
	readonly quotaWaiters: Map<string, Set<() => void>>;
	/** Sessions whose state is being recomputed, and whether a request arrived while it ran (doc/agent-runtime.md#会话状态). */
	readonly refreshes: Map<string, { again: boolean; done: Promise<SessionState> }>;
	/** Sessions whose paused call was denied but whose tool has not ended yet: their wait must not be re-created. */
	readonly deniedWaits: Set<string>;
	/** Provider session id -> session, so a compaction's summarization is charged to its conversation (D92). */
	readonly providerSessions: Map<string, string>;
	/** Conversations whose provider document was already read. */
	readonly learnedProviders: Set<string>;
	/** Follow-up inputs held while the handler runs; flushed once it is idle. */
	readonly pendingWakes: Map<string, Map<string, string>>;
	/** Handlers with a `waitForIdle` observer attached. */
	readonly idleWatchers: Set<string>;
}

/** The session's row; `missing` words the NotFoundError (callers name what the user asked for). */
export async function loadSession(
	host: RuntimeHost,
	sessionId: string,
	missing = "no such session",
): Promise<SessionRow> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
	if (!row) throw new NotFoundError(missing);
	return row;
}

/** The conversation behind a session row, or undefined when the Harness no longer has it. */
export function conversationOf(
	host: RuntimeHost,
	row: Pick<SessionRow, "conversation_id">,
): Promise<Conversation | undefined> {
	return host.harness().conversation(Number(row.conversation_id) as unknown as ConversationId, host.context);
}

/** The session and its conversation; `missing` and `noConversation` word the two NotFoundErrors. */
export async function loadConversation(
	host: RuntimeHost,
	sessionId: string,
	messages: { missing?: string; noConversation?: string } = {},
): Promise<{ row: SessionRow; conversation: Conversation }> {
	const row = await loadSession(host, sessionId, messages.missing);
	const conversation = await conversationOf(host, row);
	if (!conversation) throw new NotFoundError(messages.noConversation ?? "the session's conversation is missing");
	return { row, conversation };
}
