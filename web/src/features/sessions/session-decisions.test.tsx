import type {
	ApprovalList,
	ApprovalRequest,
	ExternalCallView,
	PendingAuthorization,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { type SessionDecision, SessionDecisionDock, sessionDecisions } from "./session-decisions";

const task = (id: string, createdAt: string, rootSessionId: string | null = "root"): TaskView =>
	({
		id,
		createdAt,
		rootSessionId,
		approval: null,
		kind: "exec",
		summary: `echo ${id}`,
		action: { type: "exec", command: `echo ${id}` },
		source: { type: "session", sessionId: "root", title: "root" },
		outcome: null,
		operation: { method: "exec", target: `echo ${id}` },
		nodeId: "node-1",
		privileged: false,
		phase: "awaiting_user",
	}) as TaskView;

const group = (id: string, createdAt: string): TaskGroupView =>
	({
		id,
		createdAt,
		rootSessionId: "root",
		phase: "awaiting_user",
		action: { type: "exec", command: "restart all" },
		source: { type: "session", sessionId: "root", title: "root" },
		outcome: null,
	}) as TaskGroupView;

const externalCall = (id: string, createdAt: string, rootSessionId = "root"): ExternalCallView =>
	({
		id,
		createdAt,
		rootSessionId,
		extension: "github",
		tool: "create_issue",
		arguments: { title: "Bug" },
		operation: { method: "ext.write", target: "github/create_issue" },
		annotations: null,
		state: "awaiting_approval",
		approval: { evaluation: { result: "require-approval", levels: [] } },
		actorType: "session",
		actorId: "s1",
		source: { type: "session", sessionId: "root", title: "root" },
		onBehalfOfUserId: "u1",
		handlerType: "user",
		handlerSessionId: null,
		phase: "awaiting_user",
		finishedAt: null,
	}) as ExternalCallView;

const apiRequestCall = (id: string) =>
	({
		...externalCall(id, "2026-01-01T00:00:00.000Z"),
		extension: "crhs-api",
		tool: "api_request",
		arguments: {
			method: "POST",
			path: "/api/sessions",
			query: { scope: "mine" },
			body: { title: "Bug" },
		},
		operation: { method: "api.write", target: "POST /api/sessions" },
	}) as ExternalCallView;

const quota = (sessionId: string, since: string) => ({
	sessionId,
	levelId: sessionId,
	title: null,
	since,
	budgetRemaining: 0,
	budgetUsedTokens: 1,
});

const taskRequest = (id: string, review?: ApprovalRequest["review"]): ApprovalRequest => ({
	kind: "task",
	id,
	phase: "awaiting_user",
	source: { type: "session", sessionId: "root", title: `Session ${id}` },
	action: { type: "exec", command: `echo ${id}` },
	nodes: ["worker-01"],
	privileged: false,
	...(review === undefined ? {} : { review }),
	alwaysAllow: [
		{ option: "exact", rule: { action: "allow", method: "exec", exact: `echo ${id}` } },
		{ option: "prefix", rule: { action: "allow", method: "exec", prefix: `echo ${id}` } },
	],
});

const callRequest = (
	id: string,
	action: ApprovalRequest["action"],
	review?: ApprovalRequest["review"],
): ApprovalRequest => ({
	kind: "external_call",
	id,
	phase: "awaiting_user",
	source: { type: "session", sessionId: "root", title: "Clean up" },
	action,
	privileged: false,
	...(review === undefined ? {} : { review }),
	alwaysAllow:
		action.type === "api_request"
			? [
					{ option: "request", rule: { action: "allow", method: "api.write", exact: "POST /api/sessions" } },
					{ option: "route", rule: { action: "allow", method: "api.write", prefix: "POST /api/sessions" } },
				]
			: [
					{ option: "tool", rule: { action: "allow", method: "ext.write", exact: "github/create_issue" } },
					{ option: "extension", rule: { action: "allow", method: "ext.write", prefix: "github/" } },
				],
});

const data = (): ApprovalList => ({
	tasks: [task("later", "2026-01-02T00:00:00.000Z"), task("older", "2026-01-01T00:00:00.000Z")],
	taskGroups: [group("group", "2026-01-03T00:00:00.000Z")],
	authorizations: {
		tasks: [task("sign-older", "2026-01-01T00:00:00.000Z"), task("sign-later", "2026-01-02T00:00:00.000Z")],
		taskGroups: [group("sign-group", "2026-01-04T00:00:00.000Z")],
	},
	quotas: [quota("other", "2026-01-01T00:00:00.000Z"), quota("root", "2026-01-02T00:00:00.000Z")],
	externalCalls: [
		externalCall("call-later", "2026-01-02T00:00:00.000Z"),
		externalCall("call-older", "2026-01-01T00:00:00.000Z"),
		externalCall("call-other", "2026-01-01T00:00:00.000Z", "another-root"),
	],
	requests: [
		taskRequest("later"),
		taskRequest("older"),
		callRequest("call-later", { type: "extension_tool", extension: "github", tool: "create_issue" }),
		callRequest("call-older", { type: "extension_tool", extension: "github", tool: "create_issue" }),
	],
});

describe("sessionDecisions", () => {
	test("orders quota, approvals, task-group approvals and signatures, oldest first", () => {
		const decisions = sessionDecisions(data(), "root");
		expect(decisions.map((decision) => decision.kind)).toEqual([
			"quota",
			"approval_task",
			"approval_task",
			"approval_external_call",
			"approval_external_call",
			"approval_task_group",
			"signature_task",
			"signature_task",
			"signature_task_group",
		]);
		expect(decisions[0]).toMatchObject({ kind: "quota", wait: { sessionId: "root" } });
		expect(decisions[1]).toMatchObject({ kind: "approval_task", task: { id: "older" }, request: { id: "older" } });
		expect(decisions[2]).toMatchObject({ kind: "approval_task", task: { id: "later" }, request: { id: "later" } });
		expect(decisions[3]).toMatchObject({ kind: "approval_external_call", call: { id: "call-older" } });
		expect(decisions[4]).toMatchObject({ kind: "approval_external_call", call: { id: "call-later" } });
		expect(decisions[6]).toMatchObject({ kind: "signature_task", task: { id: "sign-older" } });
		expect(decisions[7]).toMatchObject({ kind: "signature_task", task: { id: "sign-later" } });
	});

	test("keeps only what belongs to the given session tree", () => {
		const list = data();
		list.tasks.push(task("elsewhere", "2026-01-01T00:00:00.000Z", "another-root"));
		const decisions = sessionDecisions(list, "root");
		expect(decisions.some((decision) => decision.kind === "approval_task" && decision.task.id === "elsewhere")).toBe(
			false,
		);
		expect(decisions.some((decision) => decision.kind === "quota" && decision.wait.sessionId === "other")).toBe(false);
	});

	test("an unloaded approvals list has no decisions", () => {
		expect(sessionDecisions(undefined, "root")).toEqual([]);
	});

	test("the inline dock shows neither the source nor the rule chain evaluation", async () => {
		mockLookups();
		const waiting = task("inline", "2026-01-01T00:00:00.000Z");
		const request = taskRequest("inline", { risk: "low", reason: "a read" });
		await renderWithRouter(<SessionDecisionDock decisions={[{ kind: "approval_task", task: waiting, request }]} />);
		const dock = await screen.findByTestId("session-decisions");
		const meta = within(dock).getByTestId("decision-meta");
		expect(meta).toHaveTextContent("Nodes: worker-01");
		expect(meta).not.toHaveTextContent("Source:");
		expect(within(dock).queryByText("Rule chain evaluation")).not.toBeInTheDocument();
		expect(within(dock).queryByText(/Session inline/)).not.toBeInTheDocument();
	});

	test("a request Auto Review is still judging never becomes a decision panel", () => {
		const list = data();
		list.tasks.push({ ...task("reviewing-task", "2026-01-01T00:00:00.000Z"), phase: "reviewing" });
		list.taskGroups.push({ ...group("reviewing-group", "2026-01-01T00:00:00.000Z"), phase: "reviewing" });
		list.externalCalls.push({
			...externalCall("reviewing-call", "2026-01-01T00:00:00.000Z"),
			phase: "reviewing",
		});
		const decisions = sessionDecisions(list, "root");
		expect(
			decisions.some(
				(decision) =>
					(decision.kind === "approval_task" && decision.task.id === "reviewing-task") ||
					(decision.kind === "approval_task_group" && decision.taskGroup.id === "reviewing-group") ||
					(decision.kind === "approval_external_call" && decision.call.id === "reviewing-call"),
			),
		).toBe(false);
		expect(decisions).toHaveLength(9);
	});
});

/** Answers the name lookups the dock's decision components read. */
function mockLookups(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const body =
				path === "/api/nodes"
					? { nodes: [{ id: "node-1", name: "worker-01" }] }
					: path === "/api/node-groups"
						? { groups: [] }
						: path === "/api/api-tokens"
							? { tokens: [] }
							: path === "/api/directory"
								? { users: [], userGroups: [] }
								: {};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

const signatureRequest = (id: string): ApprovalRequest => ({
	...taskRequest(id),
	phase: "awaiting_signature",
	privileged: true,
	alwaysAllow: [],
});

const pendingSignature = (id: string): PendingAuthorization => ({
	options: [
		{
			kind: "sign",
			entries: [{ name: "alice", role: "user", credential: "sshsig" }],
			ttlMs: 86_400_000,
			payload: {
				id: "a".repeat(64),
				payload: `payload-${id}`,
				spec: `spec-${id}`,
				challenge: "challenge",
				deadline: "2026-10-31T12:00:00.000Z",
				taskIds: [id],
				attempt: 1,
				passkeys: [],
				decoded: {
					nodes: ["node-1"],
					command: { match: "spec", specSha256: "b".repeat(64) },
					issuedAt: "2026-10-30T12:00:00.000Z",
					deadline: "2026-10-31T12:00:00.000Z",
					taskIds: [id],
					attempt: 1,
					note: "",
				},
			},
		},
	],
	lastRejection: null,
});

/** The lookups plus each task's pending signature options and the authorization submit. */
function mockSignatureApi(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const waiting = /^\/api\/tasks\/([^/]+)\/authorization$/.exec(path);
			const body =
				waiting !== null
					? { authorization: pendingSignature(waiting[1] ?? "") }
					: path === "/api/authorizations"
						? { authorization: { id: "auth-1" } }
						: path === "/api/nodes"
							? { nodes: [{ id: "node-1", name: "worker-01" }] }
							: path === "/api/node-groups"
								? { groups: [] }
								: path === "/api/api-tokens"
									? { tokens: [] }
									: path === "/api/directory"
										? { users: [], userGroups: [] }
										: {};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

function Harness({ decisions, next }: { decisions: SessionDecision[]; next: SessionDecision[] }) {
	const [current, setCurrent] = useState(decisions);
	return (
		<>
			<button type="button" onClick={() => setCurrent(next)}>
				resolve first
			</button>
			<SessionDecisionDock decisions={current} />
		</>
	);
}

describe("SessionDecisionDock", () => {
	test("shows Auto Review's verdict compactly on a waiting task card", async () => {
		mockLookups();
		const reviewed = {
			...task("reviewed", "2026-01-01T00:00:00.000Z"),
			approval: {
				evaluation: { result: "require-approval", levels: [] },
				review: { decision: "escalate", risk: "high", reason: "sends a credential", model: "test/reviewer" },
			},
		} as TaskView;
		const request = taskRequest("reviewed", { risk: "high", reason: "sends a credential" });
		await renderWithRouter(<SessionDecisionDock decisions={[{ kind: "approval_task", task: reviewed, request }]} />);
		const dock = await screen.findByTestId("session-decisions");
		// The dock draws Auto Review's risk and reason from the compact request, not from the view's review record.
		expect(within(dock).getByTestId("decision-risk")).toHaveTextContent("High risk");
		expect(within(dock).getByTestId("decision-reason")).toHaveTextContent("sends a credential");
		expect(within(dock).queryByTestId("request-review")).not.toBeInTheDocument();
	});

	test("shows the first decision, its count, and the next one after it is resolved", async () => {
		mockLookups();
		const first: SessionDecision = {
			kind: "approval_task",
			task: task("first", "2026-01-01T00:00:00.000Z"),
			request: taskRequest("first"),
		};
		const second: SessionDecision = {
			kind: "approval_task",
			task: task("second", "2026-01-02T00:00:00.000Z"),
			request: taskRequest("second"),
		};
		await renderWithRouter(<Harness decisions={[first, second]} next={[second]} />);
		const dock = await screen.findByTestId("session-decisions");
		expect(dock).toHaveAttribute("data-decision", "approval_task");
		expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("echo first");
		expect(within(dock).getByText("1 of 2")).toBeInTheDocument();
		expect(within(dock).queryByText("echo second")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "resolve first" }));
		await waitFor(() => expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("echo second"));
		expect(within(dock).queryByText("1 of 2")).not.toBeInTheDocument();
	});

	test("the next signature wait starts clean after the first is signed", async () => {
		mockSignatureApi();
		const first: SessionDecision = {
			kind: "signature_task",
			task: task("first", "2026-01-01T00:00:00.000Z"),
			request: signatureRequest("first"),
		};
		const second: SessionDecision = {
			kind: "signature_task",
			task: task("second", "2026-01-02T00:00:00.000Z"),
			request: signatureRequest("second"),
		};
		await renderWithRouter(<Harness decisions={[first, second]} next={[second]} />);
		const dock = await screen.findByTestId("session-decisions");
		fireEvent.click(await within(dock).findByRole("tab", { name: "crhu sign" }));
		fireEvent.change(within(dock).getByLabelText("Signature"), { target: { value: "signed-first" } });
		fireEvent.click(within(dock).getByRole("button", { name: "Submit authorization" }));
		expect(await within(dock).findByRole("status")).toHaveTextContent("Authorization submitted.");
		// Text typed after the submit belongs to the first wait too.
		fireEvent.change(within(dock).getByLabelText("Signature"), { target: { value: "left over" } });

		fireEvent.click(screen.getByRole("button", { name: "resolve first" }));
		await waitFor(() => expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("echo second"));
		expect(within(dock).queryByRole("status")).not.toBeInTheDocument();
		expect(within(dock).queryByText("Authorization submitted.")).not.toBeInTheDocument();
		fireEvent.click(await within(dock).findByRole("tab", { name: "crhu sign" }));
		expect(within(dock).getByLabelText("Signature")).toHaveValue("");
	});

	test("the next approval starts with its own Always allow rule", async () => {
		mockLookups();
		const first: SessionDecision = {
			kind: "approval_task",
			task: task("first", "2026-01-01T00:00:00.000Z"),
			request: taskRequest("first"),
		};
		const second: SessionDecision = {
			kind: "approval_task",
			task: task("second", "2026-01-02T00:00:00.000Z"),
			request: taskRequest("second"),
		};
		await renderWithRouter(<Harness decisions={[first, second]} next={[second]} />);
		const dock = await screen.findByTestId("session-decisions");
		fireEvent.click(within(dock).getByRole("tab", { name: "Always allow" }));
		const rule = () => within(dock).getByLabelText("Rule to add to the caller's rule set") as HTMLTextAreaElement;
		expect(rule().value).toContain('"exact": "echo first"');

		fireEvent.click(screen.getByRole("button", { name: "resolve first" }));
		await waitFor(() => expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("echo second"));
		// The tab and the rule text of the first approval do not carry over.
		expect(within(dock).queryByLabelText("Rule to add to the caller's rule set")).not.toBeInTheDocument();
		fireEvent.click(within(dock).getByRole("tab", { name: "Always allow" }));
		expect(rule().value).toContain('"exact": "echo second"');
	});
});

describe("external call decision", () => {
	test("shows the extension, tool and arguments in the dock", async () => {
		mockLookups();
		const call = externalCall("call-1", "2026-01-01T00:00:00.000Z");
		const request = callRequest("call-1", { type: "extension_tool", extension: "github", tool: "create_issue" });
		await renderWithRouter(<SessionDecisionDock decisions={[{ kind: "approval_external_call", call, request }]} />);
		const dock = await screen.findByTestId("session-decisions");
		expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("github/create_issue");
		expect(within(dock).getByRole("button", { name: "Approve" })).toBeInTheDocument();
	});

	test("shows Auto Review's verdict compactly on a waiting external call", async () => {
		mockLookups();
		const call = {
			...externalCall("call-review", "2026-01-01T00:00:00.000Z"),
			approval: {
				evaluation: { result: "require-approval", levels: [] },
				review: { decision: "approve", risk: "low", reason: "a read", model: "test/reviewer" },
			},
		} as ExternalCallView;
		const request = callRequest(
			"call-review",
			{ type: "extension_tool", extension: "github", tool: "create_issue" },
			{ risk: "low", reason: "a read" },
		);
		await renderWithRouter(<SessionDecisionDock decisions={[{ kind: "approval_external_call", call, request }]} />);
		const dock = await screen.findByTestId("session-decisions");
		expect(within(dock).getByTestId("decision-risk")).toHaveTextContent("Low risk");
		expect(within(dock).getByTestId("decision-reason")).toHaveTextContent("a read");
	});

	test("shows an api_request's method, path, query and body, and offers the route rule", async () => {
		mockLookups();
		const call = apiRequestCall("api-1");
		const request = callRequest("api-1", { type: "api_request", method: "POST", path: "/api/sessions" });
		await renderWithRouter(<SessionDecisionDock decisions={[{ kind: "approval_external_call", call, request }]} />);
		const dock = await screen.findByTestId("session-decisions");
		expect(within(dock).getByTestId("decision-detail")).toHaveTextContent("POST /api/sessions");
		// The request's query and body belong to the detail page, not the dock.
		expect(within(dock).queryByTestId("request-content")).not.toBeInTheDocument();
		fireEvent.click(within(dock).getByRole("tab", { name: "Always allow" }));
		const rule = within(dock).getByLabelText("Rule to add to the caller's rule set") as HTMLTextAreaElement;
		expect(rule.value).toContain('"exact": "POST /api/sessions"');
		fireEvent.click(within(dock).getByRole("radio", { name: "This route" }));
		expect(rule.value).toContain('"prefix": "POST /api/sessions"');
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});
