import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_PROMPT, SESSION_TOOL_GUIDE, sessionSystemPrompt } from "../src/agent/extension.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let runtime: AgentRuntime;
let alice: SessionUser;

/** The text of the leading system message pi-ai normalizes a Context into. */
function systemPromptOf(context: TranscriptContext): string {
	// Durable appends a system entry per changed section; replaying them yields the request's prompt.
	const message = getCurrentSystemMessage(context.messages);
	// Sections are stored by key; a plain prompt is `content`.
	const section = message?.sections?.crh;
	if (typeof section === "string") return section;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function submitAndCapture(
	sessionId: string,
	text: string,
	captured: TranscriptContext[],
	options: { by?: SessionUser; timeZone?: string } = {},
): Promise<void> {
	faux.setResponses([
		(context) => {
			captured.push(context);
			return fauxAssistantMessage([fauxText("ok")]);
		},
	]);
	const submissionId = await runtime.submit(
		sessionId,
		options.by ?? alice,
		text,
		`prompt-${captured.length}`,
		options.timeZone === undefined ? {} : { timeZone: options.timeZone },
	);
	const settled = await waitSubmission(runtime, sessionId, submissionId);
	expect(settled.status).toBe("done");
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	const user = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
	alice = { sessionId: "prompt", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

/** Who alice's sessions act for: no display name of her own and no user groups. */
const ALICE_NOTE =
	'You act for the user "alice" (display name "alice"; user groups: none). user:alice is that user\'s personal ' +
	"library; user_group:<name> is the library of one of those user groups.";

/** The content blocks of the latest user message in a captured request. */
function lastUserContent(context: TranscriptContext): { type: string; text?: string }[] {
	const users = context.messages.filter((message) => message.role === "user");
	const content = users[users.length - 1]?.content;
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: ((content ?? []) as { type: string; text?: string }[]);
}

/** The extension list the session guide appends: both built-ins are available to everyone. */
const BUILTIN_GUIDE =
	"\n\nExtensions you can use with search_tools and call_tool:" +
	"\n- crhs-api: The crhs API as the session owner, through the same routes and rules as the WebUI (1 tool)" +
	"\n- crhs-docs: The documentation and the API reference of this crhs version (2 tools)";

it("appends the tool guide to the default prompt and to a custom prompt, exactly once", async () => {
	const session = await runtime.createSession(alice, { title: "prompt", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];

	// Without a custom prompt: the identity and the guide.
	await submitAndCapture(session.id, "hello", captured);
	const first = systemPromptOf(captured[0] as TranscriptContext);
	// The section also names the user the session acts for, so the model knows whose user: library is whose.
	expect(first).toBe(`${sessionSystemPrompt(null)}\n\n${ALICE_NOTE}${BUILTIN_GUIDE}`);
	expect(first).toContain("You are a helpful assistant running inside ClusterRightHand Server (crhs)");
	expect(first.split(SESSION_TOOL_GUIDE)).toHaveLength(2);
	expect(first.split("Start with list_nodes").length - 1).toBe(1);

	// A custom prompt replaces the default prompt but keeps the guide; it applies from the next request.
	await runtime.modelPresets.update("session", { systemPrompt: "CUSTOM SESSION PROMPT" });
	await submitAndCapture(session.id, "again", captured);
	const second = systemPromptOf(captured[1] as TranscriptContext);
	expect(second).toBe(`${sessionSystemPrompt("CUSTOM SESSION PROMPT")}\n\n${ALICE_NOTE}${BUILTIN_GUIDE}`);
	expect(second).toContain("CUSTOM SESSION PROMPT");
	expect(second).not.toContain(DEFAULT_SESSION_PROMPT);
	expect(second.split(SESSION_TOOL_GUIDE)).toHaveLength(2);

	// Clearing it restores the default prompt on the request after that.
	await runtime.modelPresets.update("session", { systemPrompt: null });
	await submitAndCapture(session.id, "once more", captured);
	const third = systemPromptOf(captured[2] as TranscriptContext);
	expect(third).toBe(`${sessionSystemPrompt(null)}\n\n${ALICE_NOTE}${BUILTIN_GUIDE}`);
	expect(third).not.toContain("CUSTOM SESSION PROMPT");
	expect(third.split(SESSION_TOOL_GUIDE)).toHaveLength(2);
});

it("names the user's display name and user groups as quoted data", async () => {
	const user = await createUser(db, {
		username: "bob",
		displayName: 'Bob "B"',
		kind: "member",
		password: "password-123",
	});
	const bob: SessionUser = { sessionId: "prompt-bob", userId: user.id, username: user.username, kind: "member" };
	for (const name of ["ops", "dba"]) {
		const group = await createUserGroup(db, name);
		await addUserGroupMember(db, group.id, user.id);
	}
	const session = await runtime.createSession(bob, { title: "bob", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "hello", captured, { by: bob });
	expect(systemPromptOf(captured[0] as TranscriptContext)).toContain(
		'You act for the user "bob" (display name "Bob \\"B\\""; user groups: "dba", "ops").',
	);
});

it("ends each user message with its sent time in the sender's zone, and falls back to the server's", async () => {
	const session = await runtime.createSession(alice, { title: "time", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "what day is it", captured, { timeZone: "Asia/Shanghai" });
	const content = lastUserContent(captured[0] as TranscriptContext);
	expect(content).toHaveLength(2);
	expect(content[0]).toMatchObject({ type: "text", text: "what day is it" });
	expect(content[1]?.text).toMatch(
		/^\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}, [A-Z][a-z]+day, Asia\/Shanghai \(UTC\+08:00\), the user's time zone\]$/,
	);
	// The time stays out of the system prompt, so the prompt cache prefix does not change between requests.
	expect(systemPromptOf(captured[0] as TranscriptContext)).not.toContain(content[1]?.text ?? "");

	await submitAndCapture(session.id, "and now", captured, { timeZone: "Not/A_Zone" });
	const fallback = lastUserContent(captured[1] as TranscriptContext);
	expect(fallback[1]?.text).toMatch(/, the server's time zone\]$/);
	// The earlier message is sent again exactly as stored.
	const again = (captured[1] as TranscriptContext).messages.filter((message) => message.role === "user")[0];
	expect(again?.content).toEqual(content);
});
