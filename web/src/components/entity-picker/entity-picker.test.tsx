import { createHash } from "node:crypto";
import type { SshCredential, User } from "@crh/api";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { EntityPicker } from "./entity-picker";

const CREDENTIAL_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

/** The fingerprint OpenSSH prints for an authorized_keys line. */
function fingerprint(publicKey: string): string {
	const encoded = publicKey.trim().split(/\s+/)[1] ?? "";
	return `SHA256:${createHash("sha256").update(Buffer.from(encoded, "base64")).digest("base64").replace(/=+$/, "")}`;
}

const CREDENTIAL: SshCredential = {
	id: "cred-1",
	name: "laptop",
	publicKey: `ssh-ed25519 ${CREDENTIAL_KEY} crh:laptop`,
	createdAt: "2026-01-01T00:00:00.000Z",
	usedBy: [],
};

const UNNAMED_CREDENTIAL: SshCredential = {
	...CREDENTIAL,
	id: "cred-2",
	name: "",
};

const ALICE: User = {
	id: "u1",
	username: "alice",
	displayName: "Alice Smith",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const BOB: User = {
	id: "u2",
	username: "bob",
	displayName: "bob",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const OUTSIDE: User = {
	id: "u3",
	username: "outside",
	displayName: "Outside User",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const NODE_A = {
	id: "n1",
	name: "worker-01",
	hostname: "worker-01.example",
	status: "active",
	connected: true,
};

const NODE_B = {
	id: "n2",
	name: "worker-02",
	hostname: "worker-02.example",
	status: "active",
	connected: true,
};

const NODE_GROUP = {
	id: "ng1",
	name: "Ops fleet",
	memberIds: ["n1", "n2"],
};

interface Call {
	path: string;
	q: string;
	limit: string | null;
	ids: string | null;
}

function mockFetch(): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const q = url.searchParams.get("q") ?? "";
			const limit = url.searchParams.get("limit");
			const ids = url.searchParams.get("ids");
			calls.push({ path: url.pathname, q, limit, ids });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/directory") {
				return json({ users: [ALICE], userGroups: [{ id: "g1", name: "Ops" }] });
			}
			if (url.pathname === "/api/nodes") {
				if (ids !== null) {
					const wanted = new Set(ids.split(","));
					return json({ nodes: [NODE_A, NODE_B].filter((node) => wanted.has(node.id)) });
				}
				return json({ nodes: q === "zzz" ? [] : [NODE_A] });
			}
			if (url.pathname === "/api/node-groups") {
				if (ids !== null) {
					const wanted = new Set(ids.split(","));
					return json({ groups: wanted.has(NODE_GROUP.id) ? [NODE_GROUP] : [] });
				}
				return json({ groups: q === "zzz" ? [] : [NODE_GROUP] });
			}
			if (url.pathname === "/api/ssh-credentials") {
				// The endpoint returns the whole list; the picker filters by name or fingerprint.
				return json({ credentials: [CREDENTIAL, UNNAMED_CREDENTIAL] });
			}
			if (url.pathname !== "/api/users") return json({});
			if (ids !== null) {
				const wanted = new Set(ids.split(","));
				return json({ users: [ALICE, BOB, OUTSIDE].filter((user) => wanted.has(user.id)) });
			}
			if (q === "more") return json({ users: [ALICE], more: true });
			if (q === "zzz") return json({ users: [], more: false });
			const matched = [ALICE, BOB, OUTSIDE]
				.filter(
					(user) =>
						q === "" ||
						user.username.toLowerCase().includes(q.toLowerCase()) ||
						user.displayName.toLowerCase().includes(q.toLowerCase()),
				)
				.sort((a, b) => {
					const prefix = (user: User) => (user.username.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1);
					return prefix(a) - prefix(b) || a.username.localeCompare(b.username);
				});
			const size = limit === null ? matched.length : Number(limit);
			return json({ users: matched.slice(0, size), ...(limit === null ? {} : { more: matched.length > size }) });
		}),
	);
	return { calls };
}

function SingleHarness({
	initial = null,
	onPick,
	exclude,
}: {
	initial?: string | null;
	onPick?: (id: string | null) => void;
	exclude?: string[];
}) {
	const [value, setValue] = useState<string | null>(initial);
	return (
		<EntityPicker
			kind="user"
			label="User"
			value={value}
			exclude={exclude}
			onChange={(id) => {
				setValue(id);
				onPick?.(id);
			}}
		/>
	);
}

function MultiHarness({ initial = [], onPick }: { initial?: string[]; onPick?: (ids: string[]) => void }) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<EntityPicker
			kind="user"
			label="Users"
			multiple
			value={value}
			onChange={(ids) => {
				setValue(ids);
				onPick?.(ids);
			}}
		/>
	);
}

function DirectoryHarness({ onPick }: { onPick?: (id: string | null, kind: string | undefined) => void }) {
	const [value, setValue] = useState<string | null>(null);
	return (
		<EntityPicker
			kind="directory"
			label="Grantee"
			value={value}
			onChange={(id, option) => {
				setValue(id);
				onPick?.(id, option?.kind);
			}}
		/>
	);
}

function NodeTargetHarness({
	initial = null,
	onPick,
}: {
	initial?: string | null;
	onPick?: (id: string | null, kind: string | undefined) => void;
}) {
	const [value, setValue] = useState<string | null>(initial);
	return (
		<EntityPicker
			kind="nodeTarget"
			label="Target"
			value={value}
			onChange={(id, option) => {
				setValue(id);
				onPick?.(id, option?.kind);
			}}
		/>
	);
}

function SshCredentialHarness({ onPick }: { onPick?: (id: string | null) => void }) {
	const [value, setValue] = useState<string | null>(null);
	return (
		<EntityPicker
			kind="sshCredential"
			label="Credential"
			value={value}
			onChange={(id) => {
				setValue(id);
				onPick?.(id);
			}}
		/>
	);
}

async function openPicker(name = "User"): Promise<HTMLInputElement> {
	const user = userEvent.setup();
	await user.click(screen.getByRole("combobox", { name }));
	return (await screen.findByPlaceholderText("Search users…")) as HTMLInputElement;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("EntityPicker", () => {
	test("searches with the debounced query and limit", async () => {
		const { calls } = mockFetch();
		renderWithI18n(<SingleHarness />);
		const input = await openPicker();
		expect(input).toHaveFocus();
		await waitFor(() => expect(calls.some((call) => call.limit === "50")).toBe(true));

		const user = userEvent.setup();
		await user.type(input, "ali");
		await waitFor(() => expect(calls.some((call) => call.q === "ali" && call.limit === "50")).toBe(true));
		// One request per settled query, not one per keystroke.
		expect(calls.filter((call) => call.q === "ali")).toHaveLength(1);
	});

	test("navigates with the keyboard and selects a single value", async () => {
		mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<SingleHarness onPick={onPick} />);
		const input = await openPicker();
		await screen.findByRole("option", { name: /Alice Smith/ });

		const user = userEvent.setup();
		await user.type(input, "{ArrowDown}{Enter}");

		await waitFor(() => expect(onPick).toHaveBeenCalledWith("u1"));
		expect(screen.getByRole("combobox", { name: "User" })).toHaveTextContent("Alice Smith");
	});

	test("Home and End move the highlight through the list", async () => {
		mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<SingleHarness onPick={onPick} />);
		const input = await openPicker();
		await screen.findByRole("option", { name: /Alice Smith/ });

		const user = userEvent.setup();
		await user.type(input, "{End}{Enter}");
		await waitFor(() => expect(onPick).toHaveBeenCalledWith("u3"));

		await user.click(screen.getByRole("combobox", { name: "User" }));
		await user.type(await screen.findByPlaceholderText("Search users…"), "{Home}{Enter}");
		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith("u1"));
	});

	test("Escape closes the popup", async () => {
		mockFetch();
		renderWithI18n(<SingleHarness />);
		const input = await openPicker();
		await screen.findByRole("option", { name: /Alice Smith/ });
		const user = userEvent.setup();
		await user.type(input, "{Escape}");
		await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
	});

	test("multiple mode keeps the popup open and removes chips", async () => {
		mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<MultiHarness onPick={onPick} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("combobox", { name: "Users" }));
		await screen.findByRole("option", { name: /Alice Smith/ });
		await user.click(screen.getByRole("option", { name: /Alice Smith/ }));
		await user.click(screen.getByRole("option", { name: /bob/ }));

		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(["u1", "u2"]));
		expect(screen.getByRole("combobox", { name: "Users" })).toHaveTextContent("2 selected");
		expect(screen.getByRole("listbox")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Remove Alice Smith" }));
		await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(["u2"]));
		expect(screen.queryByRole("button", { name: "Remove Alice Smith" })).not.toBeInTheDocument();
	});

	test("resolves the labels of selected values with ids", async () => {
		const { calls } = mockFetch();
		renderWithI18n(<SingleHarness initial="u3" />);
		await waitFor(() => expect(screen.getByRole("combobox", { name: "User" })).toHaveTextContent("Outside User"));
		expect(calls.some((call) => call.ids === "u3")).toBe(true);
	});

	test("excludes ids from the results", async () => {
		mockFetch();
		renderWithI18n(<SingleHarness exclude={["u2"]} />);
		await openPicker();
		expect(await screen.findByRole("option", { name: /Alice Smith/ })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /bob/ })).not.toBeInTheDocument();
	});

	test("directory mode searches both kinds and reports the option kind", async () => {
		const { calls } = mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<DirectoryHarness onPick={onPick} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("combobox", { name: "Grantee" }));
		expect(await screen.findByPlaceholderText("Search users and groups…")).toBeInTheDocument();
		expect(calls.some((call) => call.path === "/api/directory" && call.limit === "50")).toBe(true);
		const groupOption = await screen.findByRole("option", { name: /Ops/ });
		expect(within(groupOption).getByText("User group")).toBeInTheDocument();
		await user.click(groupOption);
		await waitFor(() => expect(onPick).toHaveBeenCalledWith("g1", "userGroup"));
	});

	test("nodeTarget merges nodes and node groups with type badges", async () => {
		const { calls } = mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<NodeTargetHarness onPick={onPick} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("combobox", { name: "Target" }));
		expect(await screen.findByPlaceholderText("Search nodes and node groups…")).toBeInTheDocument();
		// Both list endpoints are searched with the same fixed page size.
		expect(calls.some((call) => call.path === "/api/nodes" && call.limit === "50")).toBe(true);
		expect(calls.some((call) => call.path === "/api/node-groups" && call.limit === "50")).toBe(true);

		const node = await screen.findByRole("option", { name: /worker-01/ });
		expect(within(node).getByText("worker-01.example")).toBeInTheDocument();
		expect(within(node).getByText("Node")).toBeInTheDocument();
		const group = await screen.findByRole("option", { name: /Ops fleet/ });
		expect(within(group).getByText("2 members")).toBeInTheDocument();
		expect(within(group).getByText("Node group")).toBeInTheDocument();

		await user.click(group);
		await waitFor(() => expect(onPick).toHaveBeenCalledWith("ng1", "nodeGroup"));
		expect(screen.getByRole("combobox", { name: "Target" })).toHaveTextContent("Ops fleet");
	});

	test("nodeTarget resolves a selected label through both ids lookups", async () => {
		const { calls } = mockFetch();
		renderWithI18n(<NodeTargetHarness initial="n2" />);
		await waitFor(() => expect(screen.getByRole("combobox", { name: "Target" })).toHaveTextContent("worker-02"));
		expect(calls.some((call) => call.path === "/api/nodes" && call.ids === "n2")).toBe(true);
		expect(calls.some((call) => call.path === "/api/node-groups" && call.ids === "n2")).toBe(true);
	});

	test("sshCredential lists names over key fingerprints and picks one", async () => {
		const { calls } = mockFetch();
		const onPick = vi.fn();
		renderWithI18n(<SshCredentialHarness onPick={onPick} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("combobox", { name: "Credential" }));
		expect(await screen.findByPlaceholderText("Search SSH credentials…")).toBeInTheDocument();
		expect(calls.some((call) => call.path === "/api/ssh-credentials")).toBe(true);

		const expected = fingerprint(CREDENTIAL.publicKey);
		const laptop = await screen.findByRole("option", { name: /laptop/ });
		expect(within(laptop).getByText(expected)).toBeInTheDocument();
		// An unnamed credential is shown by its fingerprint.
		const options = await screen.findAllByRole("option");
		const unnamed = options.find((option) => option.textContent?.startsWith(expected));
		expect(unnamed).toBeInTheDocument();

		await user.click(laptop);
		await waitFor(() => expect(onPick).toHaveBeenCalledWith("cred-1"));
		expect(screen.getByRole("combobox", { name: "Credential" })).toHaveTextContent("laptop");
	});

	test("shows the more-results hint and the empty state", async () => {
		mockFetch();
		renderWithI18n(<SingleHarness />);
		const input = await openPicker();
		const user = userEvent.setup();
		await user.type(input, "more");
		expect(await screen.findByText("More results — keep typing to narrow down")).toBeInTheDocument();

		await user.clear(input);
		await user.type(input, "zzz");
		expect(await screen.findByText("No matches")).toBeInTheDocument();
	});
});
