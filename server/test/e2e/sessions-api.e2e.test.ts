import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../../src/users/service.ts";
import { waitSubmission as waitSubmissionOf } from "../helpers/runtime.ts";
import { buildCrha, Env, goAvailable, pkill, waitFor } from "./harness.ts";

const hasGo = await goAvailable();

type SseMessage = { event: string; data: string };

describe.skipIf(!hasGo)("sessions api against a real crha", () => {
	let tmp = "";
	let env: Env;
	let nodeName = "";
	let member = "";
	let member2 = "";
	let seq = 0;
	const crhs = () => env.crhs;
	const model = () => ({ provider: crhs().faux.provider.id, modelId: crhs().faux.getModel().id });

	const as = async (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) => {
		const headers: Record<string, string> = { cookie };
		if (init.body !== undefined) headers["content-type"] = "application/json";
		const res = await fetch(crhs().url + path, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	};
	const loginAs = async (username: string) => {
		await createUser(crhs().db, { username, kind: "member", password: "member-password" });
		const res = await fetch(`${crhs().url}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, password: "member-password" }),
		});
		return res.headers.get("set-cookie")?.match(/crh_session=([^;]+)/)?.[0] as string;
	};
	const newSession = async (preset?: string, cookie = crhs().cookie) => {
		const res = await as(cookie, "/api/sessions", {
			body: { model: model(), ...(preset ? { preset } : {}), title: `s${++seq}` },
		});
		expect(res.status).toBe(201);
		return res.json.session as { id: string; title: string; rules: { preset: string } | null };
	};
	const send = (id: string, text: string, requestId = `req-${++seq}`, cookie = crhs().cookie) =>
		as(cookie, `/api/sessions/${id}/messages`, { body: { text, requestId } });
	const tasksOf = (sessionId: string) =>
		crhs().db.selectFrom("tasks").selectAll().where("actor_id", "=", sessionId).execute();
	const idle = () => crhs().runtime?.waitForIdle() as Promise<void>;
	const waitSubmission = (sessionId: string, submissionId: string) => {
		const runtime = crhs().runtime;
		if (!runtime) throw new Error("the agent runtime is not running");
		return waitSubmissionOf(runtime, sessionId, submissionId);
	};
	const execCall = (cmd: string, id = "c1") =>
		fauxAssistantMessage([fauxToolCall("exec", { targets: [nodeName], cmd }, { id })], { stopReason: "toolUse" });
	const auditOf = async (action: string, targetId: string) => {
		await crhs().audit.flush();
		const r = await crhs().api(`/api/audit?action=${action}&targetId=${targetId}`);
		return r.json.items as { actorType: string; actorId: string; detail: Record<string, unknown> }[];
	};

	/** Opens the SSE stream; `next` yields the next message, `close` aborts the stream. */
	const openEvents = async (id: string, cookie = crhs().cookie) => {
		const ctl = new AbortController();
		const res = await fetch(`${crhs().url}/api/sessions/${id}/events`, { headers: { cookie }, signal: ctl.signal });
		if (!res.ok || !res.body) {
			ctl.abort();
			return { res, next: async () => undefined, close: () => {} };
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const next = async (timeoutMs = 15_000): Promise<SseMessage | undefined> => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const i = buf.indexOf("\n\n");
				if (i >= 0) {
					const raw = buf.slice(0, i);
					buf = buf.slice(i + 2);
					let event = "message";
					const data: string[] = [];
					for (const line of raw.split("\n")) {
						if (line.startsWith("event:")) event = line.slice(6).trim();
						else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
					}
					return { event, data: data.join("\n") };
				}
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("timed out reading the event stream");
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out reading the event stream")), left)),
				]);
				if (chunk.done) return undefined;
				buf += decoder.decode(chunk.value, { stream: true });
			}
		};
		return { res, next, close: () => ctl.abort() };
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-sessions-api-"));
		env = await Env.create(await buildCrha(tmp), tmp, {}, {}, { agent: true });
		await env.bringUp();
		nodeName = (await crhs().api(`/api/nodes/${env.nodeId}`)).json.node.name;
		member = await loginAs("member1");
		member2 = await loginAs("member2");
	}, 180_000);

	afterAll(async () => {
		await pkill("crh-sessions-api-sleep");
		await env?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	describe("models and creation", () => {
		it("lists the faux model", async () => {
			const res = await crhs().api("/api/models");
			expect(res.status).toBe(200);
			expect(res.json.models).toContainEqual(expect.objectContaining(model()));
			// Members may see it too.
			expect((await as(member, "/api/models")).json.models).toContainEqual(expect.objectContaining(model()));
		});

		it("refuses an unknown or malformed model", async () => {
			const bad = [
				{ model: { provider: "nope", modelId: "x" } },
				{ model: { provider: model().provider, modelId: "nope" } },
				{ model: { provider: model().provider } },
				{},
				{ model: { ...model(), thinkingLevel: "extreme" } },
			];
			for (const body of bad) expect((await as(crhs().cookie, "/api/sessions", { body })).status).toBe(400);
		});

		it("refuses an unknown preset", async () => {
			const res = await as(crhs().cookie, "/api/sessions", { body: { model: model(), preset: "chaos" } });
			expect(res.status).toBe(400);
		});

		it("creates a yolo session that shows up in the list", async () => {
			const s = await newSession("yolo");
			expect(s.rules?.preset).toBe("yolo");
			const list = (await crhs().api("/api/sessions")).json.items as { id: string }[];
			expect(list.map((x) => x.id)).toContain(s.id);
			const got = await crhs().api(`/api/sessions/${s.id}`);
			expect(got.status).toBe(200);
			expect(got.json.session).toMatchObject({ id: s.id, status: "active", model: model() });
		});

		it("defaults the preset to ask", async () => {
			const res = await as(crhs().cookie, "/api/sessions", { body: { model: model() } });
			expect(res.status).toBe(201);
			expect(res.json.session.rules.preset).toBe("ask");
			expect(res.json.session.title).toBe("New session");
		});

		it("patches the title and rejects a bad preset", async () => {
			const s = await newSession();
			const ok = await crhs().api(`/api/sessions/${s.id}`, { method: "PATCH", body: { title: "renamed" } });
			expect(ok.json.session.title).toBe("renamed");
			expect((await crhs().api(`/api/sessions/${s.id}`, { method: "PATCH", body: { preset: "chaos" } })).status).toBe(
				400,
			);
			expect(
				(
					await crhs().api(`/api/sessions/${s.id}`, {
						method: "PATCH",
						body: { model: { provider: "x", modelId: "y" } },
					})
				).status,
			).toBe(400);
			expect((await crhs().api("/api/sessions/does-not-exist")).status).toBe(404);
		});
	});

	describe("messages", () => {
		it("requires text and requestId", async () => {
			const s = await newSession();
			const post = (body: unknown) => crhs().api(`/api/sessions/${s.id}/messages`, { body });
			expect((await post({ requestId: "r" })).status).toBe(400);
			expect((await post({ text: "   ", requestId: "r" })).status).toBe(400);
			expect((await post({ text: "hi" })).status).toBe(400);
			expect((await post({ text: "hi", requestId: "" })).status).toBe(400);
			expect((await post({ text: 5, requestId: "r" })).status).toBe(400);
			expect((await post({})).status).toBe(400);
		});

		it("a message makes the model answer; the same requestId lands once", async () => {
			const s = await newSession("ask");
			crhs().faux.setResponses([fauxAssistantMessage([fauxText("hello there")])]);
			const before = crhs().faux.state.callCount;
			const first = await send(s.id, "hi", "same-request");
			expect(first.status).toBe(202);
			expect(first.json.submissionId).toBeTruthy();
			const wait = await waitSubmission(s.id, first.json.submissionId);
			expect(wait).toEqual({ status: "done", answer: "hello there" });
			const again = await send(s.id, "hi", "same-request");
			expect(again.status).toBe(202);
			expect(again.json.submissionId).toBe(first.json.submissionId);
			await idle();
			expect(crhs().faux.state.callCount - before).toBe(1);
		});

		it("a different requestId is a new submission", async () => {
			const s = await newSession("ask");
			crhs().faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
			const a = await send(s.id, "a", "ra");
			await waitSubmission(s.id, a.json.submissionId);
			const b = await send(s.id, "b", "rb");
			expect(b.json.submissionId).not.toBe(a.json.submissionId);
			expect(await waitSubmission(s.id, b.json.submissionId)).toEqual({
				status: "done",
				answer: "two",
			});
		});
	});

	describe("tool calls", () => {
		it("a scripted exec under yolo runs on the node as the session", async () => {
			const s = await newSession("yolo");
			crhs().faux.setResponses([execCall("echo via-api"), fauxAssistantMessage([fauxText("finished")])]);
			const sub = await send(s.id, "run it");
			expect(await waitSubmission(s.id, sub.json.submissionId)).toEqual({
				status: "done",
				answer: "finished",
			});
			const rows = await tasksOf(s.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ actor_type: "session", actor_id: s.id, state: "exited" });
		});

		it("under ask an exec waits for approval; switching to yolo runs it without a decision", async () => {
			const s = await newSession("ask");
			crhs().faux.setResponses([execCall("echo after-preset"), fauxAssistantMessage([fauxText("ran")])]);
			const sub = await send(s.id, "run it");
			const waiting = await waitFor("a waiting task", async () => {
				const { tasks } = (await crhs().api("/api/approvals")).json;
				return tasks.find((t: { actorId: string }) => t.actorId === s.id);
			});
			expect(waiting).toMatchObject({ actorType: "session", state: "awaiting_approval" });
			// The session's owner sees it; another member does not.
			expect((await as(member, "/api/approvals")).json.tasks).toEqual([]);
			const patch = await crhs().api(`/api/sessions/${s.id}`, { method: "PATCH", body: { preset: "yolo" } });
			expect(patch.status).toBe(200);
			expect(patch.json.session.rules.preset).toBe("yolo");
			expect(await waitSubmission(s.id, sub.json.submissionId)).toEqual({
				status: "done",
				answer: "ran",
			});
			const rows = await tasksOf(s.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: waiting.id, state: "exited" });
			// No explicit approval was recorded; the rules let it through.
			expect(await auditOf("task.approved", waiting.id)).toEqual([]);
			const changed = await auditOf("rules.changed", s.id);
			expect(changed).toHaveLength(1);
			expect(changed[0]?.detail).toMatchObject({ preset: "yolo" });
		});
	});

	describe("abort", () => {
		it("ends a long exec, and the session takes a new message afterwards", async () => {
			const s = await newSession("yolo");
			crhs().faux.setResponses([execCall("sleep 30; echo crh-sessions-api-sleep")]);
			const sub = await send(s.id, "sleep a while");
			const running = await waitFor("the task running", async () => {
				const rows = await tasksOf(s.id);
				return rows.find((r) => r.state === "running");
			});
			const res = await crhs().api(`/api/sessions/${s.id}/abort`, { method: "POST", body: {} });
			expect(res.status).toBe(200);
			expect(res.json).toEqual({ ok: true });
			// The run ends promptly, far before the sleep would.
			const t0 = Date.now();
			await idle();
			expect(Date.now() - t0).toBeLessThan(20_000);
			const settled = await waitSubmission(s.id, sub.json.submissionId);
			expect(settled?.status).toBe("unanswered");
			// Stopping the session stops the node's process too.
			const task = await waitFor("the task cancelled", async () => {
				const row = (await tasksOf(s.id)).find((r) => r.id === running.id);
				return row && row.state !== "running" ? row : undefined;
			});
			expect(task.state).toBe("exited");
			expect((await crhs().getTask(running.id)).cancelled).toBe(true);
			await pkill("crh-sessions-api-sleep");
			// And the session still works.
			crhs().faux.setResponses([fauxAssistantMessage([fauxText("back again")])]);
			const next = await send(s.id, "are you there?");
			expect(next.status).toBe(202);
			expect(await waitSubmission(s.id, next.json.submissionId)).toEqual({
				status: "done",
				answer: "back again",
			});
		}, 60_000);
	});

	describe("events", () => {
		it("streams a snapshot first, then events for new messages", async () => {
			const s = await newSession("ask");
			const stream = await openEvents(s.id);
			try {
				expect(stream.res.status).toBe(200);
				expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
				const first = await stream.next();
				expect(first?.event).toBe("events");
				const events = JSON.parse(first?.data ?? "[]") as { type: string }[];
				expect(events.map((e) => e.type)).toContain("snapshot");

				crhs().faux.setResponses([fauxAssistantMessage([fauxText("streamed answer")])]);
				await send(s.id, "stream please");
				const seen: string[] = [];
				for (let i = 0; i < 50 && !seen.includes("message_end"); i++) {
					const msg = await stream.next();
					if (!msg) break;
					if (msg.event !== "events") continue;
					for (const e of JSON.parse(msg.data) as { type: string }[]) seen.push(e.type);
				}
				expect(seen).toContain("message_end");
			} finally {
				stream.close();
			}
		});

		it("is 404 for a session that does not exist", async () => {
			const res = await fetch(`${crhs().url}/api/sessions/nope/events`, { headers: { cookie: crhs().cookie } });
			expect(res.status).toBe(404);
		});
	});

	describe("access", () => {
		it("another member cannot see or drive a session, and lists none", async () => {
			const s = await newSession("ask");
			expect((await as(member, `/api/sessions/${s.id}`)).status).toBe(404);
			expect((await as(member, `/api/sessions/${s.id}`, { method: "PATCH", body: { title: "x" } })).status).toBe(404);
			expect((await send(s.id, "hi", "r-m", member)).status).toBe(404);
			expect((await as(member, `/api/sessions/${s.id}/abort`, { method: "POST", body: {} })).status).toBe(404);
			const stream = await openEvents(s.id, member);
			expect(stream.res.status).toBe(404);
			stream.close();
			expect((await as(member, "/api/sessions")).json.items).toEqual([]);
			// Nothing changed.
			expect((await crhs().api(`/api/sessions/${s.id}`)).json.session.title).toBe(s.title);
		});

		it("an administrator sees a member's session but cannot drive it", async () => {
			const s = await newSession("ask", member);
			expect((await as(member, "/api/sessions")).json.items.map((x: { id: string }) => x.id)).toEqual([s.id]);
			expect((await as(member2, "/api/sessions")).json.items).toEqual([]);
			const got = await crhs().api(`/api/sessions/${s.id}`);
			expect(got.status).toBe(200);
			expect((await crhs().api("/api/sessions?scope=all")).json.items.map((x: { id: string }) => x.id)).toContain(s.id);
			// Visible, but looking in does not drive it (doc/access-control.md#归属与分享).
			expect((await send(s.id, "hi", "r-a")).status).toBe(403);
			expect((await crhs().api(`/api/sessions/${s.id}`, { method: "PATCH", body: { preset: "yolo" } })).status).toBe(
				403,
			);
			expect((await crhs().api(`/api/sessions/${s.id}/abort`, { method: "POST", body: {} })).status).toBe(403);
			expect((await as(member, `/api/sessions/${s.id}`)).json.session.rules.preset).toBe("ask");
			// Watching is allowed for the administrator.
			const stream = await openEvents(s.id);
			try {
				expect(stream.res.status).toBe(200);
				expect((await stream.next())?.event).toBe("events");
			} finally {
				stream.close();
			}
		});

		it("a member session works for its owner", async () => {
			const s = await newSession("yolo", member);
			crhs().faux.setResponses([fauxAssistantMessage([fauxText("member ok")])]);
			const sub = await send(s.id, "hi", "r-own", member);
			expect(sub.status).toBe(202);
			expect(await waitSubmission(s.id, sub.json.submissionId)).toEqual({
				status: "done",
				answer: "member ok",
			});
		});

		it("requires a login", async () => {
			expect((await as("", "/api/sessions")).status).toBe(401);
			expect((await as("", "/api/models")).status).toBe(401);
		});
	});

	describe("audit", () => {
		it("records session.created, session.message and tool.call via session", async () => {
			const s = await newSession("yolo");
			crhs().faux.setResponses([execCall("echo audited"), fauxAssistantMessage([fauxText("done")])]);
			const sub = await send(s.id, "audit me");
			await waitSubmission(s.id, sub.json.submissionId);
			const created = await auditOf("session.created", s.id);
			expect(created).toHaveLength(1);
			expect(created[0]?.detail).toMatchObject({ preset: "yolo", model: model() });
			const messages = await auditOf("session.message", s.id);
			expect(messages).toHaveLength(1);
			expect(messages[0]?.detail).toMatchObject({ submission_id: sub.json.submissionId, chars: "audit me".length });
			await crhs().audit.flush();
			const calls = (await crhs().api("/api/audit?action=tool.call&targetId=exec")).json.items as {
				actorType: string;
				actorId: string;
				detail: Record<string, unknown>;
			}[];
			expect(calls.some((e) => e.actorId === s.id && e.actorType === "session" && e.detail.via === "session")).toBe(
				true,
			);
		});
	});
});
