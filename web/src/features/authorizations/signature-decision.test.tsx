import type { PendingAuthorization, PendingPasskey, TaskGroupView, TaskView } from "@crh/api";
import { startAuthentication } from "@simplewebauthn/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SubmitAuthorizationInput } from "@/features/authorizations/api";
import { grantCommand, sshKeygenRecipe } from "@/features/authorizations/authorization";
import { copyText } from "@/lib/clipboard";
import { renderWithRouter } from "@/test/render";
import { SignatureDecision } from "./signature-decision";

vi.mock("@simplewebauthn/browser", () => ({
	startAuthentication: vi.fn(async () => ({ id: "credential-1", response: { clientDataJSON: "x" } })),
}));

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

const PAYLOAD = "o2dub2RlcwFhZ3JvdXA6d2Vi";
const OPERATION = "systemctl restart nginx";

const pending = (overrides: Partial<PendingAuthorization> = {}): PendingAuthorization => ({
	id: "a".repeat(64),
	payload: PAYLOAD,
	challenge: "challenge-b64url",
	deadline: "2026-10-31T12:00:00.000Z",
	taskIds: ["task-1"],
	attempt: 2,
	passkeys: [],
	localRequested: false,
	lastRejection: null,
	tried: ["crhs"],
	decoded: {
		nodes: ["node-1"],
		command: {
			method: "exec",
			match: "exact",
			target: OPERATION,
			specSha256: "b".repeat(64),
		},
		issuedAt: "2026-10-30T12:00:00.000Z",
		deadline: "2026-10-31T12:00:00.000Z",
		taskIds: ["task-1"],
		attempt: 2,
		note: "",
	},
	...overrides,
});

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: OPERATION,
		operation: { method: "exec", target: OPERATION },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "awaiting_authorization",
		privileged: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as TaskView;

const nodeNames = new Map([["node-1", "worker-01"]]);

const passkey = (overrides: Partial<PendingPasskey> = {}): PendingPasskey => ({
	credentialId: "Y3JlZA",
	name: "YubiKey",
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
	requireUv: true,
	entry: "yubikey",
	...overrides,
});

function renderDecision(overrides: {
	pending?: PendingAuthorization;
	item?: { kind: "task"; task: TaskView } | { kind: "task_group"; taskGroup: TaskGroupView };
	onSubmit?: (input: SubmitAuthorizationInput) => Promise<unknown>;
	onReject?: (reason: string) => void;
}) {
	return renderWithRouter(
		<SignatureDecision
			item={overrides.item ?? { kind: "task", task: task() }}
			pending={overrides.pending ?? pending()}
			nodeNames={nodeNames}
			onSubmit={overrides.onSubmit ?? (async () => {})}
			onReject={overrides.onReject ?? (() => {})}
		/>,
	);
}

describe("SignatureDecision", () => {
	test("defaults to crha grant when no trusted Passkey exists", async () => {
		await renderDecision({});
		expect(screen.getByRole("region", { name: "Sign to approve" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("crha grant");
		expect(screen.queryByRole("tab", { name: "Passkey" })).not.toBeInTheDocument();
		expect(screen.getByTestId("decision-operation").textContent).toBe(`exec  ${OPERATION}`);
		expect(screen.getByRole("link", { name: "worker-01" })).toBeInTheDocument();
	});

	test("the copy button copies the full crha grant command", async () => {
		await renderDecision({});
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
		await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(grantCommand(PAYLOAD)));
		// The visible line truncates; the full command stays in the title.
		expect(screen.getByTestId("decision-command")).toHaveAttribute("title", grantCommand(PAYLOAD));
	});

	test("the ssh-keygen tab copies the full manual recipe", async () => {
		await renderDecision({});
		fireEvent.click(screen.getByRole("tab", { name: "ssh-keygen" }));
		// The old panel stays mounted for its exit transition; wait until only the new one is visible.
		await waitFor(() => expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
		await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(sshKeygenRecipe(PAYLOAD)));
	});

	test("a trusted Passkey is the default tab, one button per credential", async () => {
		const onSubmit = vi.fn(async (_input: SubmitAuthorizationInput) => {});
		await renderDecision({
			pending: pending({
				passkeys: [passkey(), passkey({ credentialId: "b3RoZXI", name: "Backup", rpId: "other.example.com" })],
			}),
			onSubmit,
		});
		await waitFor(() => expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Passkey"));
		fireEvent.click(screen.getByRole("button", { name: "Sign with Passkey “YubiKey”" }));
		await waitFor(() => expect(startAuthentication).toHaveBeenCalled());
		expect(startAuthentication).toHaveBeenCalledWith({
			optionsJSON: expect.objectContaining({
				rpId: "crh.example.com",
				challenge: "challenge-b64url",
				userVerification: "required",
			}),
		});
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				payloadId: "a".repeat(64),
				webauthn: { id: "credential-1", response: { clientDataJSON: "x" } },
			}),
		);
		// The second credential keeps its own RP: task groups can mix RPs.
		expect(screen.getByRole("button", { name: "Sign with Passkey “Backup”" })).toBeInTheDocument();
	});

	test("the pasted authorization is submitted from the crha grant tab", async () => {
		const onSubmit = vi.fn(async (_input: SubmitAuthorizationInput) => {});
		await renderDecision({ onSubmit });
		fireEvent.change(screen.getByLabelText("Signature"), {
			target: { value: "  signed-payload  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Submit authorization" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ authorization: "signed-payload" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Authorization submitted.");
	});

	test("no Local approval tab is offered when the payload does not allow one", async () => {
		await renderDecision({});
		expect(screen.queryByRole("tab", { name: "Local approval" })).not.toBeInTheDocument();
	});

	test("the Local approval tab shows the crha approve command when it is available", async () => {
		await renderDecision({ pending: pending({ localRequested: true }) });
		fireEvent.click(screen.getByRole("tab", { name: "Local approval" }));
		await waitFor(() => expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1));
		expect(screen.getByText(/crha approve task-1/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
	});

	test("Reject sends the trimmed reason to the shared reject tab", async () => {
		const onReject = vi.fn<(reason: string) => void>();
		await renderDecision({ onReject });
		fireEvent.click(screen.getByRole("tab", { name: "Reject" }));
		fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  not signing  " } });
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onReject).toHaveBeenCalledWith("not signing");
	});

	test("a task group shows its target names, not the stored UUIDs", async () => {
		const taskGroup = {
			id: "group-1",
			kind: "exec",
			summary: "restart",
			targets: ["node-1", "node-2"],
			refs: { "node-1": { kind: "node", name: "worker-01" }, "node-2": { kind: "node", name: "worker-02" } },
			privileged: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			actorType: "user",
			actorId: "u1",
			operation: { method: "exec", target: "systemctl restart nginx" },
			tasks: [],
		} as unknown as TaskGroupView;
		await renderDecision({ item: { kind: "task_group", taskGroup } });
		expect(screen.getAllByRole("link", { name: "worker-01" }).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("link", { name: "worker-02" }).length).toBeGreaterThan(0);
		expect(screen.queryByText(/node-2/)).not.toBeInTheDocument();
	});

	test("without a payload the waiting message is shown but Reject is still available", async () => {
		await renderWithRouter(
			<SignatureDecision
				item={{ kind: "task", task: task() }}
				nodeNames={nodeNames}
				onSubmit={async () => {}}
				onReject={() => {}}
			/>,
		);
		expect(screen.getByText("Preparing the payload to sign…")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Reject" })).toBeInTheDocument();
	});
});
