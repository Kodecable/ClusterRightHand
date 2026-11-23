import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	DEFAULT_SESSION_PROMPT,
	SESSION_TOOL_GUIDE,
	SUBAGENT_NOTE,
	sessionSystemPrompt,
} from "../src/agent/extension.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { AGENTS_MD_MAX_BYTES } from "../src/library/agents-md.ts";
import { createLibraryBackend, type LibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload } from "../src/library/files.ts";
import { findLibraryByRef } from "../src/library/library.ts";
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
let backend: LibraryBackend;
let libraryRoot: string;

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
	libraryRoot = await mkdtemp(join(tmpdir(), "crhs-session-prompt-"));
	backend = createLibraryBackend({ backend: "local" }, libraryRoot);
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit, libraryBackend: backend });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		callRunner: new CallRunner(),
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
	await runtime.waitForIdle();
	await runtime.close();
	await db.destroy();
	await rm(libraryRoot, { recursive: true, force: true });
});

/** Who alice's sessions act for: no display name of her own and no user groups. */
const ALICE_NOTE =
	'You act for the user "alice" (display name "alice"; user groups: none). user:alice is that user\'s personal ' +
	"library; user_group:<name> is the library of one of those user groups.";

/** The same note for another member with no display name of their own and no user groups. */
function userNote(username: string): string {
	return (
		`You act for the user "${username}" (display name "${username}"; user groups: none). user:${username} is ` +
		"that user's personal library; user_group:<name> is the library of one of those user groups."
	);
}

/** Creates a member, who gets a personal library and can start sessions. */
async function member(username: string): Promise<SessionUser> {
	const user = await createUser(db, { username, kind: "member", password: "password-123" });
	return { sessionId: `prompt-${username}`, userId: user.id, username: user.username, kind: "member" };
}

/** Uploads a file into a library as its owner, the way the WebUI would. */
async function uploadToLibrary(ref: string, path: string, content: string | Uint8Array): Promise<void> {
	const record = await findLibraryByRef(db, ref);
	if (!record) throw new Error(`no library ${ref}`);
	const upload = beginLibraryUpload(db, backend, {
		library: record.row,
		path,
		overwrite: true,
		createdBy: record.row.owner_id,
	});
	await upload.write(typeof content === "string" ? Buffer.from(content) : content);
	await upload.commit();
}

/** The AGENTS.md section of the prompt for a member's personal library. */
function agentsBlock(username: string, text: string): string {
	return (
		`User instructions: the user keeps standing instructions for you in user:${username} at AGENTS.md. Follow them; ` +
		"the tool guide above and the user's messages in this session take precedence when they conflict.\n" +
		`<user_instructions>\n${text}\n</user_instructions>`
	);
}

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

it("appends the tool guide to the default prompt and to a custom prompt once, and keeps a session's prompt", async () => {
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

	// The prompt is the session's: a preset change keeps it, so the provider's cache keeps the prefix.
	await runtime.modelPresets.update("session", { systemPrompt: "CUSTOM SESSION PROMPT" });
	await submitAndCapture(session.id, "again", captured);
	expect(systemPromptOf(captured[1] as TranscriptContext)).toBe(first);

	// A custom prompt replaces the default prompt in a new session but keeps the guide.
	const custom = await runtime.createSession(alice, { title: "custom", model: model(), rulePreset: "ask" });
	await submitAndCapture(custom.id, "hello", captured);
	const second = systemPromptOf(captured[2] as TranscriptContext);
	expect(second).toBe(`${sessionSystemPrompt("CUSTOM SESSION PROMPT")}\n\n${ALICE_NOTE}${BUILTIN_GUIDE}`);
	expect(second).not.toContain(DEFAULT_SESSION_PROMPT);
	expect(second.split(SESSION_TOOL_GUIDE)).toHaveLength(2);
	await runtime.modelPresets.update("session", { systemPrompt: null });
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

it("appends the owner's AGENTS.md after the skills section and keeps it for that session", async () => {
	const owner = await member("agents-owner");
	await uploadToLibrary(
		`user:${owner.username}`,
		"skills/briefing/SKILL.md",
		"---\nname: briefing\ndescription: Turn notes into a briefing.\n---\nWrite the briefing in three lines.\n",
	);
	await uploadToLibrary(`user:${owner.username}`, "AGENTS.md", "Standing: answer in haiku.\n\n");
	const session = await runtime.createSession(owner, { title: "agents", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "hello", captured, { by: owner });
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(prompt.endsWith(`\n\n${agentsBlock(owner.username, "Standing: answer in haiku.")}`)).toBe(true);
	expect(prompt.indexOf("Skills:")).toBeGreaterThan(-1);
	expect(prompt.indexOf("Skills:")).toBeLessThan(prompt.indexOf("User instructions:"));
	const stored = await db
		.selectFrom("sessions")
		.select("system_prompt")
		.where("id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(stored.system_prompt).toBe(prompt);

	// A changed AGENTS.md applies to sessions started afterwards, like a skill.
	await uploadToLibrary(`user:${owner.username}`, "AGENTS.md", "Standing: answer in sonnet.\n");
	await submitAndCapture(session.id, "again", captured, { by: owner });
	expect(systemPromptOf(captured[1] as TranscriptContext)).toBe(prompt);

	const fresh = await runtime.createSession(owner, { title: "agents-new", model: model(), rulePreset: "ask" });
	await submitAndCapture(fresh.id, "hello", captured, { by: owner });
	const freshPrompt = systemPromptOf(captured[2] as TranscriptContext);
	expect(freshPrompt).toContain(agentsBlock(owner.username, "Standing: answer in sonnet."));
	expect(freshPrompt).not.toContain("haiku");
});

it("names an AGENTS.md larger than 32 KiB and includes none of its content", async () => {
	const owner = await member("agents-large");
	const content = Buffer.alloc(AGENTS_MD_MAX_BYTES + 1, "x");
	await uploadToLibrary(`user:${owner.username}`, "AGENTS.md", content);
	const session = await runtime.createSession(owner, { title: "agents-large", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "hello", captured, { by: owner });
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(
		prompt.endsWith(
			`\n\nUser instructions: user:${owner.username} holds AGENTS.md (${content.length} bytes), larger than the ` +
				"32 KiB that is included here. Read it with read_file (library " +
				`user:${owner.username}, path AGENTS.md) before acting, and follow it.`,
		),
	).toBe(true);
	expect(prompt).not.toContain("<user_instructions>");
	expect(prompt).not.toContain("xxxx");
});

it("leaves invalid UTF-8 out of the prompt and warns once", async () => {
	const owner = await member("agents-invalid");
	await uploadToLibrary(`user:${owner.username}`, "AGENTS.md", Buffer.from([0xff, 0xfe, 0x41]));
	const session = await runtime.createSession(owner, { title: "agents-invalid", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	const warnings: unknown[][] = [];
	const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args);
	});
	try {
		await submitAndCapture(session.id, "hello", captured, { by: owner });
	} finally {
		warn.mockRestore();
	}
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(prompt).toBe(`${sessionSystemPrompt(null)}\n\n${userNote(owner.username)}${BUILTIN_GUIDE}`);
	expect(prompt).not.toContain("User instructions:");
	expect(warnings.filter(([message]) => String(message).includes("AGENTS.md"))).toHaveLength(1);
});

it("adds nothing when the owner has no AGENTS.md", async () => {
	const owner = await member("agents-none");
	const session = await runtime.createSession(owner, { title: "agents-none", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "hello", captured, { by: owner });
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(prompt).toBe(`${sessionSystemPrompt(null)}\n\n${userNote(owner.username)}${BUILTIN_GUIDE}`);
	expect(prompt).not.toContain("User instructions:");
});

it("gives a subagent session of the same owner the owner's AGENTS.md", async () => {
	const owner = await member("agents-child");
	await uploadToLibrary(`user:${owner.username}`, "AGENTS.md", "Standing: mention the ticket id.\n");
	const parent = await runtime.createSession(owner, { title: "agents-parent", model: model(), rulePreset: "ask" });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "agents-child",
		task: "look around",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	const captured: TranscriptContext[] = [];
	await submitAndCapture(child.id, "the delegated task", captured, { by: owner });
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(prompt).toContain(SUBAGENT_NOTE);
	expect(prompt.endsWith(`\n\n${agentsBlock(owner.username, "Standing: mention the ticket id.")}`)).toBe(true);
});

it("ignores AGENTS.md in a group library", async () => {
	const owner = await member("agents-group");
	const group = await createUserGroup(db, "agents-team", {
		library: { files: 10, fileBytes: 1024, totalBytes: 4096 },
	});
	await addUserGroupMember(db, group.id, owner.userId);
	await uploadToLibrary("user_group:agents-team", "AGENTS.md", "Group standing instructions.\n");
	const session = await runtime.createSession(owner, { title: "agents-group", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];
	await submitAndCapture(session.id, "hello", captured, { by: owner });
	const prompt = systemPromptOf(captured[0] as TranscriptContext);
	expect(prompt).not.toContain("User instructions:");
	expect(prompt).not.toContain("Group standing instructions");
});
