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

async function submitAndCapture(sessionId: string, text: string, captured: TranscriptContext[]): Promise<void> {
	faux.setResponses([
		(context) => {
			captured.push(context);
			return fauxAssistantMessage([fauxText("ok")]);
		},
	]);
	const submissionId = await runtime.submit(sessionId, alice, text, `prompt-${captured.length}`);
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

it("appends the tool guide to the default prompt and to a custom prompt, exactly once", async () => {
	const session = await runtime.createSession(alice, { title: "prompt", model: model(), rulePreset: "ask" });
	const captured: TranscriptContext[] = [];

	// Without a custom prompt: the identity and the guide.
	await submitAndCapture(session.id, "hello", captured);
	const first = systemPromptOf(captured[0] as TranscriptContext);
	expect(first).toBe(sessionSystemPrompt(null));
	expect(first).toContain("You are ClusterRightHand");
	expect(first.split(SESSION_TOOL_GUIDE)).toHaveLength(2);
	expect(first.split("Start with list_nodes").length - 1).toBe(1);

	// A custom prompt replaces the default prompt but keeps the guide; it applies from the next request.
	await runtime.modelPresets.update("session", { systemPrompt: "CUSTOM SESSION PROMPT" });
	await submitAndCapture(session.id, "again", captured);
	const second = systemPromptOf(captured[1] as TranscriptContext);
	expect(second).toBe(sessionSystemPrompt("CUSTOM SESSION PROMPT"));
	expect(second).toContain("CUSTOM SESSION PROMPT");
	expect(second).not.toContain(DEFAULT_SESSION_PROMPT);
	expect(second.split(SESSION_TOOL_GUIDE)).toHaveLength(2);

	// Clearing it restores the default prompt on the request after that.
	await runtime.modelPresets.update("session", { systemPrompt: null });
	await submitAndCapture(session.id, "once more", captured);
	const third = systemPromptOf(captured[2] as TranscriptContext);
	expect(third).toBe(sessionSystemPrompt(null));
	expect(third).not.toContain("CUSTOM SESSION PROMPT");
	expect(third.split(SESSION_TOOL_GUIDE)).toHaveLength(2);
});
