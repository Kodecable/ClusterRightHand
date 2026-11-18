import type { ApprovalRequest, PendingAuthorization, PendingPasskey, PendingSignOption } from "@crh/api";
import { startAuthentication } from "@simplewebauthn/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { grantCommand, sshKeygenRecipe } from "@/lib/authorization";
import { copyText } from "@/lib/clipboard";
import { renderWithRouter } from "@/test/render";
import { SignaturePanel, type SubmitSignature } from "./signature-panel";

vi.mock("@simplewebauthn/browser", () => ({
	startAuthentication: vi.fn(async () => ({ id: "credential-1", response: { clientDataJSON: "x" } })),
}));

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

const trust = vi.hoisted(() => ({
	window: null as
		| null
		| { kind: "open"; openedAtMs: number; openedByUid: number; untilMs: number }
		| { kind: "closed" },
}));

const PAYLOAD = "o2dub2RlcwFhZ3JvdXA6d2Vi";
const OPERATION = "systemctl restart nginx";

const signPayload = (overrides: Partial<PendingSignOption["payload"]> = {}): PendingSignOption["payload"] => ({
	id: "a".repeat(64),
	payload: PAYLOAD,
	challenge: "challenge-b64url",
	deadline: "2026-10-31T12:00:00.000Z",
	taskIds: ["task-1"],
	attempt: 2,
	passkeys: [],
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

const signOption = (overrides: Partial<PendingSignOption> = {}): PendingSignOption => ({
	kind: "sign",
	entries: [{ name: "alice", role: "user", credential: "sshsig" }],
	ttlMs: 86_400_000,
	payload: signPayload(),
	...overrides,
});

const pending = (overrides: Partial<PendingAuthorization> = {}): PendingAuthorization => ({
	options: [signOption()],
	lastRejection: null,
	...overrides,
});

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task",
	id: "task-1",
	phase: "awaiting_signature",
	source: { type: "session", sessionId: "root-1", title: "Clean up" },
	action: { type: "exec", command: OPERATION },
	nodes: ["worker-01"],
	privileged: true,
	alwaysAllow: [],
	...overrides,
});

const passkey = (overrides: Partial<PendingPasskey> = {}): PendingPasskey => ({
	credentialId: "Y3JlZA",
	name: "YubiKey",
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
	requireUv: true,
	entry: "yubikey",
	...overrides,
});

function renderPanel(overrides: {
	pending?: PendingAuthorization;
	request?: ApprovalRequest;
	onSubmit?: (input: SubmitSignature) => Promise<unknown>;
	onReject?: (reason: string) => void;
	variant?: "inline" | "page";
}) {
	return renderWithRouter(
		<SignaturePanel
			request={overrides.request ?? request()}
			variant={overrides.variant}
			pending={overrides.pending ?? pending()}
			onSubmit={overrides.onSubmit ?? (async () => {})}
			onReject={overrides.onReject ?? (() => {})}
		/>,
	);
}

beforeEach(() => {
	trust.window = { kind: "closed" };
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ trust: { summary: { localWindow: trust.window } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SignaturePanel", () => {
	test("renders the compact ApprovalRequest as its summary and defaults to crhu sign", async () => {
		await renderPanel({});
		const card = screen.getByRole("region", { name: "Your signature is needed" });
		expect(within(card).getByTestId("decision-detail")).toHaveTextContent(OPERATION);
		expect(within(card).getByTestId("decision-meta")).toHaveTextContent("Nodes: worker-01");
		expect(within(card).getByText("Privileged")).toBeInTheDocument();
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("crhu sign");
		expect(screen.queryByRole("tab", { name: "Passkey" })).not.toBeInTheDocument();
		// An inline signature wait never shows the source.
		expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
	});

	test("the page variant links the requesting session", async () => {
		await renderPanel({ variant: "page" });
		expect(screen.getByRole("link", { name: "Clean up" })).toHaveAttribute("href", "/sessions/root-1");
	});

	test("the copy button copies the full crhu sign command", async () => {
		await renderPanel({});
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
		await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(grantCommand(PAYLOAD)));
		// The visible line truncates; the full command stays in the title.
		expect(screen.getByTestId("decision-command")).toHaveAttribute("title", grantCommand(PAYLOAD));
	});

	test("the copied command carries the matching credential fingerprints as hints", async () => {
		const fingerprints = ["SHA256:one", "SHA256:two"];
		await renderPanel({ pending: pending({ options: [signOption({ fingerprints })] }) });
		const command = grantCommand(PAYLOAD, fingerprints);
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
		await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(command));
		expect(screen.getByTestId("decision-command")).toHaveAttribute("title", command);
	});

	test("the ssh-keygen tab copies the full manual recipe", async () => {
		await renderPanel({});
		fireEvent.click(screen.getByRole("tab", { name: "ssh-keygen" }));
		// The old panel stays mounted for its exit transition; wait until only the new one is visible.
		await waitFor(() => expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
		await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(sshKeygenRecipe(PAYLOAD)));
	});

	test("a trusted Passkey is the default tab, one button per credential", async () => {
		const onSubmit = vi.fn(async (_input: SubmitSignature) => {});
		await renderPanel({
			pending: pending({
				options: [
					signOption({
						payload: signPayload({
							passkeys: [passkey(), passkey({ credentialId: "b3RoZXI", name: "Backup", rpId: "other.example.com" })],
						}),
					}),
				],
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
				payload: PAYLOAD,
				webauthn: { id: "credential-1", response: { clientDataJSON: "x" } },
			}),
		);
		// The second credential keeps its own RP: task groups can mix RPs.
		expect(screen.getByRole("button", { name: "Sign with Passkey “Backup”" })).toBeInTheDocument();
	});

	test("a task the owner already signed says it waits for its node", async () => {
		renderPanel({ pending: pending({ options: [{ kind: "awaiting_node" }] }) });
		expect(await screen.findByText("Signed. The task is sent when its node is back online.")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Reject" })).toBeInTheDocument();
	});

	test("the pasted authorization is submitted from the crhu sign tab", async () => {
		const onSubmit = vi.fn(async (_input: SubmitSignature) => {});
		await renderPanel({ onSubmit });
		fireEvent.change(screen.getByLabelText("Signature"), {
			target: { value: "  signed-payload  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Submit authorization" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ authorization: "signed-payload" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Authorization submitted.");
	});

	test("no Local window tab is offered when the plan has only a sign option", async () => {
		await renderPanel({});
		expect(screen.queryByRole("tab", { name: "Local window" })).not.toBeInTheDocument();
	});

	test("the Local window tab shows the command and the node", async () => {
		await renderPanel({
			pending: pending({
				options: [signOption(), { kind: "local_window", nodeId: "node-1", nodeName: "worker-01" }],
			}),
		});
		trust.window = { kind: "closed" };
		fireEvent.click(screen.getByRole("tab", { name: "Local window" }));
		await waitFor(() => expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1));
		expect(screen.getByText("sudo crha approve --for 30m")).toBeInTheDocument();
		expect(screen.getByText(/Run this on worker-01/)).toBeInTheDocument();
	});

	test("the Local window tab reports a window that is already open", async () => {
		trust.window = {
			kind: "open",
			openedAtMs: Date.now() - 60_000,
			openedByUid: 1000,
			untilMs: Date.parse("2026-10-31T12:00:00.000Z"),
		};
		await renderPanel({
			pending: pending({ options: [{ kind: "local_window", nodeId: "node-1", nodeName: "worker-01" }] }),
		});
		fireEvent.click(screen.getByRole("tab", { name: "Local window" }));
		expect(await screen.findByText(/A local approval window is open on worker-01/)).toBeInTheDocument();
		// The command stays visible, so the owner can still open a fresh window.
		expect(screen.getByText("sudo crha approve --for 30m")).toBeInTheDocument();
	});

	test("a task group's signature request names its nodes, not the stored UUIDs", async () => {
		await renderPanel({
			request: request({
				kind: "task_group",
				id: "group-1",
				nodes: ["worker-01", "worker-02"],
			}),
		});
		expect(screen.getByTestId("decision-meta")).toHaveTextContent("Nodes: worker-01, worker-02");
		expect(screen.queryByText(/node-2/)).not.toBeInTheDocument();
	});

	test("Reject sends the trimmed reason to the shared reject tab", async () => {
		const onReject = vi.fn<(reason: string) => void>();
		await renderPanel({ onReject });
		fireEvent.click(screen.getByRole("tab", { name: "Reject" }));
		fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  not signing  " } });
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onReject).toHaveBeenCalledWith("not signing");
	});

	test("without a plan yet the preparing message is shown but Reject is still available", async () => {
		await renderWithRouter(<SignaturePanel request={request()} onSubmit={async () => {}} onReject={() => {}} />);
		expect(screen.getByText("Preparing the payload to sign…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
	});
});
