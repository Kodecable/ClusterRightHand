import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { InProcessCrhs } from "./e2e/harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * A tool call that runs into an exhausted quota pauses and asks the owner; the owner grants tokens and the tool
 * runs (doc/agent-runtime.md#配额). This goes through the HTTP API and a real durable tool task.
 */
let dir = "";
let crhs: InProcessCrhs;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "crh-quota-api-"));
	crhs = await InProcessCrhs.create({}, {}, dir);
	await crhs.loginAdmin();
});

afterAll(async () => {
	await crhs.destroy();
	await rm(dir, { recursive: true, force: true });
});

const model = () => ({ provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id });

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

it("pauses a tool call for quota and resumes after the owner grants tokens", async () => {
	const created = await crhs.api("/api/sessions", { body: { model: model(), preset: "yolo", quota: 100 } });
	expect(created.status).toBe(201);
	const sessionId = created.json.session.id as string;

	// The first response asks for a tool; its usage is well above 100, so the tool call must pause first.
	crhs.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "q1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const sent = await crhs.api(`/api/sessions/${sessionId}/messages`, {
		body: { text: "list the nodes", requestId: "quota-run" },
	});
	expect(sent.status).toBe(202);
	const submissionId = sent.json.submissionId as string;

	const request = await waitFor("the owner's quota request", async () => {
		const list = await crhs.api("/api/quota-requests");
		return (
			list.json.requests as { id: string; sessionId: string; levelId: string; handlerSessionId: string | null }[]
		).find((r) => r.sessionId === sessionId);
	});
	expect(request.levelId).toBe(sessionId);
	expect(request.handlerSessionId).toBeNull();

	const granted = await crhs.api(`/api/quota-requests/${request.id}/grant`, { body: { tokens: 10_000 } });
	expect(granted.status).toBe(200);
	expect(granted.json.request).toMatchObject({ state: "granted", grantedTokens: 10_000 });

	expect(await crhs.runtime?.waitSubmission(sessionId, submissionId)).toEqual({ status: "done", answer: "done" });
	const view = await crhs.api(`/api/sessions/${sessionId}`);
	expect(view.json.session.quota).toBeLessThan(10_000);
});

it("denies a quota request and the paused run ends", async () => {
	const before = crhs.faux.state.callCount;
	const created = await crhs.api("/api/sessions", { body: { model: model(), preset: "yolo", quota: 100 } });
	const sessionId = created.json.session.id as string;
	crhs.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "q2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("should not run")]),
	]);
	const sent = await crhs.api(`/api/sessions/${sessionId}/messages`, {
		body: { text: "list the nodes", requestId: "quota-deny" },
	});
	const submissionId = sent.json.submissionId as string;
	const request = await waitFor("the owner's quota request", async () => {
		const list = await crhs.api("/api/quota-requests");
		return (list.json.requests as { id: string; sessionId: string }[]).find((r) => r.sessionId === sessionId);
	});
	expect((await crhs.api(`/api/quota-requests/${request.id}/deny`, { body: {} })).status).toBe(200);
	const result = await crhs.runtime?.waitSubmission(sessionId, submissionId);
	expect(result?.status).toBe("done");
	// The model was not asked again after the denied tool.
	expect(crhs.faux.state.callCount - before).toBe(1);
});
