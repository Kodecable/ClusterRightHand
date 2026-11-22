import type { SessionView as ApiSessionView, ExtensionToolAnnotations, Operation, SessionEvent } from "@crh/api";
import type { Context } from "@earendil-works/chord/context";
import type {
	CompactionSettings,
	Conversation,
	ConversationId,
	Extension,
	Harness,
	Storage,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Audit } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { CallRunner } from "../extensions/call-runner.ts";
import type { McpConnections } from "../extensions/connections.ts";
import type { Jobs } from "../jobs/jobs.ts";
import type { ImageCache } from "../library/image-cache.ts";
import type { RuleRef } from "../policy/store.ts";
import type { SessionRow } from "../sessions/session-chain.ts";
import type { SettingsStore } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import type { TodoLists } from "../todos/todos.ts";
import { NotFoundError } from "../util/errors.ts";
import type { KeyedQueue } from "../util/keyed-queue.ts";
import type { GenerationTimings } from "./latency.ts";
import type { ModelPresets } from "./model-presets.ts";
import type { ModelConfig } from "./models.ts";
import type { HandlerWakes } from "./runtime-host/handler-wakes.ts";
import type { Inboxes } from "./runtime-host/inboxes.ts";
import type { NoticeActivity } from "./runtime-host/notice-activity.ts";
import type { QuotaWaits } from "./runtime-host/quota-waits.ts";
import type { SessionCaches } from "./runtime-host/session-caches.ts";
import type { SessionFlags } from "./runtime-host/session-flags.ts";
import type { StateRefreshes } from "./runtime-host/state-refreshes.ts";
import type { SessionListHub } from "./session-list-hub.ts";

/**
 * The pieces every runtime module shares: the services, the open Harness and the runtime's caches. One
 * instance per `AgentRuntime`, which delegates its public API to the modules that take it (doc/design/agent-runtime.md).
 * pi packages stay inside this directory and the storage adapters in server/src/storage/ (in server/src); the
 * facade's public API has none (test/pi-boundary.test.ts).
 */

/**
 * The session row without the per-caller decorations the API adds (relationship, capabilities, owner name) and
 * with `forkedFrom` carrying only the stored ids. Its source title and visibility are caller-specific, so the
 * API resolves them into the view it returns (doc/design/agent-runtime.md "Forking").
 */
export type SessionView = Omit<
	ApiSessionView,
	"relationship" | "capabilities" | "ownerUsername" | "shares" | "forkedFrom"
> & {
	forkedFrom: { sessionId: string; entryId: number } | null;
};

/** An external call as an ancestor agent decides it: the extension, tool, operation, annotations and arguments. */
export interface AgentRequestExternalCall {
	extension: string;
	tool: string;
	operation: Operation;
	annotations: ExtensionToolAnnotations | null;
	arguments: Record<string, unknown>;
}

/** An approval handed to an ancestor session's agent (doc/design/agent-runtime.md "Handling subagent requests"). */
export interface AgentRequestView {
	kind: "task" | "task_group" | "quota" | "external_call";
	id: string;
	/** The subagent session whose task waits. */
	sessionId: string;
	summary: string;
	nodeId: string | null;
	createdAt: string;
	/** The call's details; only for an external call. */
	externalCall?: AgentRequestExternalCall;
}

/** What a UI receives: a snapshot to start from, then batches of the `@crh/api` session events (never pi's). */
export type { SessionEvent };

/** The session a conversation belongs to, for the tools' per-call lookups (the mapping never changes). */
export interface SessionInfo {
	id: string;
	ownerUserId: string;
	orgId: string;
	parentSessionId: string | null;
}

export interface AgentRuntimeOptions {
	db: Db;
	/**
	 * The durable storage, or a function that opens it. With a function, a Harness that fails (a storage error
	 * closes it, doc/design/testing/server.md "Agent runtime tests") is reopened on fresh storage, with backoff.
	 */
	storage: Storage | (() => Promise<Storage>);
	models: ModelConfig;
	cluster: Cluster;
	taskGroups: TaskGroups;
	audit?: Audit;
	/** The image cache behind `view_image` (doc/design/library.md "Image cache"); required to use that tool. */
	imageCache?: ImageCache;
	/** The MCP client connections behind `search_tools` and `call_tool` (doc/design/extensions.md). */
	mcp?: McpConnections;
	/** The job service; AgentRuntime makes one when the caller did not (doc/design/jobs.md). */
	jobs?: Jobs;
	/** The todo change bus; AgentRuntime makes one when the caller did not (doc/design/todo.md). */
	todoLists?: TodoLists;
	/** The crhs-owned extension calls, shared with the job service and the MCP surface. */
	callRunner: CallRunner;
	/** System settings: the skill limit and the directory copy limits; the defaults without it. */
	settings?: SettingsStore;
	/** Auto Review for one waiting external call; set by AgentRuntime. */
	reviewExternalCall?: (id: string, signal?: AbortSignal) => Promise<void>;
	/** Whether Auto Review will judge a request on this chain; set by AgentRuntime for the marker at creation. */
	willReview?: (chain: RuleRef[] | null) => Promise<boolean>;
	/** A session's wait may have changed (an external call entered or left a wait); set by AgentRuntime. */
	approvalChanged?: (actorId: string) => void;
	/** Routes a waiting external call up the rule chain; set by AgentRuntime. */
	routeExternalCall?: (id: string) => Promise<boolean>;
	/**
	 * How long idle conversations keep their context and documents in memory (durable's default: 10 minutes).
	 * Memory grows with what was active within this window (doc/design/testing/server.md "Server performance").
	 */
	retentionMs?: number;
	/** Set by clusterExtension; removed from a conversation that has reached the subagent depth limit. */
	subagentTool?: ToolRegistration;
	/**
	 * Set by clusterExtension: tools a subagent conversation must not offer (doc/design/todo.md "Scope").
	 * Removed when the child is created and before every child run, so an older child loses them too.
	 */
	rootSessionTools?: readonly ToolRegistration[];
	/**
	 * In-flight generation timings keyed by provider session id, filled in by `AgentRuntime`
	 * (doc/design/agent-runtime.md "Session statistics"). `meteredModels` records an attempt as it streams; the extension takes
	 * it when the message ends.
	 */
	generationTimings?: GenerationTimings;
	/**
	 * Compaction policy override; the pi defaults when omitted (doc/design/agent-runtime.md "Defaults"). Tests use it to
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
	readonly taskGroups: TaskGroups;
	/** The job service, so session-state changes project the subagent jobs watching them. */
	readonly jobs: Jobs | undefined;
	/** The crhs-owned extension calls a stopped session must abort (doc/design/jobs.md "Lifecycle"). */
	readonly callRunner: CallRunner;
	readonly imageCache: ImageCache | undefined;
	readonly context: Context;
	readonly sessionList: SessionListHub;
	/** The cached model presets: prompt sections, Auto Review and title generation read them. */
	readonly modelPresets: ModelPresets;
	/** The extensions a session selects: the crh extension and the extension tools it may use. */
	extensionsFor(extensionNames: readonly string[]): Extension[];
	/** The open Harness; a failed one is replaced on reopen, so always read it through here. */
	harness(): Harness;
	/** Whether close() has begun: the Harness refuses every new operation from here on. */
	closing(): boolean;
	/** What the runtime remembers about sessions: conversation, subagent and provider-session lookups. */
	readonly sessionCaches: SessionCaches;
	/** Recomputations of session state in flight, coalesced per session. */
	readonly refreshes: StateRefreshes;
	/** Pending requests by handler, a cache over tasks/task_groups/quota waits. */
	readonly inboxes: Inboxes;
	/** Waiters for a quota wait's session; grant/deny/abort/quota edit wakes them, and denials are marked here. */
	readonly quotaWaits: QuotaWaits;
	/** Follow-up inputs held while a handler runs, flushed once it is idle. */
	readonly wakes: HandlerWakes;
	/** Serializes a session's notice delivery with the afterTool read, so two settles cannot both place a wake. */
	readonly noticeDelivery: KeyedQueue;
	/** Completion-notice deliveries in flight, so a scheduled run waits for them (doc/design/jobs.md "Scheduled runs"). */
	readonly noticeActivity: NoticeActivity;
	/** Stops and title generations in flight (memory only). */
	readonly sessionFlags: SessionFlags;
	/** The in-flight generation attempts, by provider session id (doc/design/agent-runtime.md "Session statistics"). */
	readonly generationTimings: GenerationTimings;
	/** Called after a session's run state changes, for hosts that follow waits (chat channels). */
	stateChanged?: (sessionId: string) => void;
	/**
	 * Called when a `crh.notice` jobs entry is placed in a session, with the compact notices it carries; chat
	 * channels send the notice line from it (doc/design/channels.md "Notifications").
	 */
	jobNoticePlaced?: (sessionId: string, notices: readonly import("@crh/api").JobNotice[]) => void;
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
