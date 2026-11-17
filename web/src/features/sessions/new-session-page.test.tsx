import type { AvailableModel, ModelRef, SessionExtension, SessionView, User, UserSettings } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useParams,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { authStore } from "@/lib/session";
import { activateLocale } from "@/test/render";
import { sessionKeys } from "./api";
import { NewSessionPage } from "./new-session-page";

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const MODELS: AvailableModel[] = [
	{
		provider: "faux",
		providerName: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off", "high"],
		input: ["text"],
	},
	{
		provider: "faux",
		providerName: "faux",
		modelId: "faux-2",
		name: "Faux Two",
		contextWindow: 128_000,
		thinkingLevels: ["off", "low"],
		input: ["text"],
	},
];

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "s-new",
		title: null,
		ownerUserId: ADMIN.id,
		parentSessionId: null,
		scheduleId: null,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		rules: null,
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, createShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
		stats: {
			turns: 0,
			steps: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
		},
		forkedFrom: null,
		...overrides,
	};
}

type Post = { path: string; body: Record<string, unknown> };

function SessionTarget() {
	const params = useParams({ strict: false }) as { sessionId?: string };
	return <div data-testid="session-target">{params.sessionId}</div>;
}

const DEFAULT_SETTINGS: UserSettings = {
	locale: null,
	defaultModel: null,
	defaultRulePreset: null,
	showProgress: true,
	defaultChannelAccountId: null,
};

const EXTENSIONS: SessionExtension[] = [
	{
		name: "alpha",
		kind: "mcp",
		description: "Alpha tools",
		enabled: true,
		available: true,
		listDirectly: false,
	},
	{
		name: "beta",
		kind: "builtin",
		description: null,
		enabled: true,
		available: true,
		listDirectly: true,
	},
];

/** The draft page at /sessions/new with a dummy session page that shows which id it was given. */
async function renderDraft(
	options: {
		posts?: Post[];
		patches?: Post[];
		settings?: Partial<UserSettings>;
		sessionModel?: ModelRef | null;
		availableExtensions?: SessionExtension[];
		createResponse?: () => Response;
		initialPath?: string;
	} = {},
) {
	const posts = options.posts ?? [];
	const patches = options.patches ?? [];
	let settings: UserSettings = { ...DEFAULT_SETTINGS, ...options.settings };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/me") return json({ user: ADMIN });
			if (url.pathname === "/api/models") {
				return json({ models: MODELS, sessionModel: options.sessionModel ?? null });
			}
			if (url.pathname === "/api/me/settings") {
				if (init?.method === "PATCH") {
					const body = JSON.parse(String(init.body)) as Partial<UserSettings>;
					patches.push({ path: url.pathname, body });
					settings = { ...settings, ...body };
				}
				return json({ settings });
			}
			if (url.pathname === "/api/sessions/extensions") {
				return json({ extensions: options.availableExtensions ?? [] });
			}
			if (url.pathname === "/api/sessions" && init?.method === "POST") {
				posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
				return options.createResponse?.() ?? json({ session: sessionView() }, 201);
			}
			return json({ items: [], nextCursor: null });
		}),
	);
	await authStore.load();
	activateLocale("en");
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	const rootRoute = createRootRoute();
	const draftRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/new",
		component: NewSessionPage,
	});
	const sessionRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/$sessionId",
		component: SessionTarget,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([draftRoute, sessionRoute]),
		history: createMemoryHistory({ initialEntries: [options.initialPath ?? "/sessions/new"] }),
	});
	await router.load();
	render(
		<LocaleProvider initialLocale="en">
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LocaleProvider>,
	);
	return { client, router };
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	authStore.clear();
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe("NewSessionPage", () => {
	test("initialises the model, thinking level and rule preset from the user's settings", async () => {
		const patches: Post[] = [];
		await renderDraft({
			patches,
			settings: {
				defaultModel: { provider: "faux", modelId: "faux-2", thinkingLevel: "low" },
				defaultRulePreset: "yolo",
			},
		});
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux Two"));
		expect(screen.getByTestId("composer-thinking")).toHaveTextContent("low");
		expect(screen.getByTestId("composer-rules")).toHaveTextContent("Yolo");
		expect(screen.getByTestId("composer-budget")).toHaveTextContent("∞");
		// Opening the draft applies the settings but does not save them again.
		expect(patches).toHaveLength(0);
		// No header row: the empty transcript holds the centred prompt, and below `lg` the back button.
		expect(screen.queryByTestId("session-header")).not.toBeInTheDocument();
		expect(screen.getByTestId("new-session-prompt")).toHaveTextContent("What's on your plan today?");
		expect(screen.getByTestId("session-back")).toBeInTheDocument();
		expect(screen.getByTestId("new-session-transcript")).toContainElement(screen.getByTestId("new-session-prompt"));
		// The draft page has no run to stop and no editable title.
		expect(screen.queryByTestId("abort-session")).not.toBeInTheDocument();
		expect(screen.queryByTestId("session-title")).not.toBeInTheDocument();
	});

	test("falls back from a default no longer offered to the session model preset, then the first model", async () => {
		await renderDraft({
			settings: { defaultModel: { provider: "gone", modelId: "nope" } },
			sessionModel: { provider: "faux", modelId: "faux-2" },
		});
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux Two"));
	});

	test("uses the first available model when there is no default", async () => {
		await renderDraft();
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux One"));
	});

	test("clamps the thinking level to off when the model changes", async () => {
		await renderDraft();
		const user = userEvent.setup();
		await waitFor(() => expect(screen.getByTestId("composer-thinking")).toHaveTextContent("off"));
		await user.click(screen.getByTestId("composer-thinking"));
		await user.click(await screen.findByRole("option", { name: "high" }));
		await waitFor(() => expect(screen.getByTestId("composer-thinking")).toHaveTextContent("high"));

		await user.click(screen.getByTestId("composer-model"));
		await user.click(await screen.findByRole("option", { name: "Faux Two" }));
		await waitFor(() => expect(screen.getByTestId("composer-thinking")).toHaveTextContent("off"));
	});

	test("saves every default changed on the draft", async () => {
		const patches: Post[] = [];
		const user = userEvent.setup();
		await renderDraft({ patches });
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux One"));
		expect(patches).toHaveLength(0);

		await user.click(screen.getByTestId("composer-thinking"));
		await user.click(await screen.findByRole("option", { name: "high" }));
		await waitFor(() => expect(patches).toHaveLength(1));
		expect(patches[0]?.body).toEqual({
			defaultModel: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" },
		});

		await user.click(screen.getByTestId("composer-model"));
		await user.click(await screen.findByRole("option", { name: "Faux Two" }));
		await waitFor(() => expect(patches).toHaveLength(2));
		expect(patches[1]?.body).toEqual({ defaultModel: { provider: "faux", modelId: "faux-2" } });

		await user.click(screen.getByTestId("composer-rules"));
		await user.click(await screen.findByRole("option", { name: "Yolo" }));
		await waitFor(() => expect(patches).toHaveLength(3));
		expect(patches[2]?.body).toEqual({ defaultRulePreset: "yolo" });
	});

	test("turns a draft extension off locally and sends the list with the first message", async () => {
		const posts: Post[] = [];
		const patches: Post[] = [];
		await renderDraft({ posts, patches, availableExtensions: EXTENSIONS });
		const user = userEvent.setup();
		const button = await screen.findByTestId("new-session-extensions");
		expect(button).toHaveAttribute("aria-label", "Extensions: 2/2");
		expect(button).toHaveAttribute("title", "Extensions: 2/2");

		await user.click(button);
		const dialog = await screen.findByTestId("extensions-dialog");
		expect(dialog).toHaveTextContent("Alpha tools");
		// The draft has no session to PATCH: the second extension is turned off in local state only.
		await user.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
		await waitFor(() => expect(button).toHaveAttribute("aria-label", "Extensions: 1/2"));
		expect(patches).toHaveLength(0);

		await user.keyboard("{Escape}");
		await waitFor(() => expect(dialog).not.toBeVisible());
		await user.type(screen.getByTestId("new-session-input"), "hello there");
		await user.click(screen.getByTestId("composer-send"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]?.body).toMatchObject({ message: "hello there", disabledExtensions: ["beta"] });
	});

	test("has no extensions button when nothing is available", async () => {
		await renderDraft();
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux One"));
		expect(screen.queryByTestId("new-session-extensions")).not.toBeInTheDocument();
	});

	test("sends the footer's model, thinking level, rule preset and budget with the message", async () => {
		const posts: Post[] = [];
		const { client, router } = await renderDraft({ posts });
		client.setQueryData(sessionKeys.listPage("visible", ""), {
			pages: [{ items: [], nextCursor: null }],
			pageParams: [null],
		});
		const user = userEvent.setup();
		await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("Faux One"));

		await user.click(screen.getByTestId("composer-thinking"));
		await user.click(await screen.findByRole("option", { name: "high" }));
		await user.click(screen.getByTestId("composer-rules"));
		await user.click(await screen.findByRole("option", { name: "Yolo" }));
		await user.click(screen.getByTestId("composer-budget"));
		await user.clear(screen.getByLabelText("Remaining budget tokens (empty = unlimited)"));
		await user.type(screen.getByLabelText("Remaining budget tokens (empty = unlimited)"), "1000");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await user.type(screen.getByTestId("new-session-input"), "hello there");
		await user.click(screen.getByTestId("composer-send"));

		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]?.body).toMatchObject({
			message: "hello there",
			model: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" },
			rulePreset: "yolo",
			budgetRemaining: 1000,
		});
		expect(typeof posts[0]?.body.requestId).toBe("string");
		await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/s-new"));
		expect(screen.getByTestId("session-target")).toHaveTextContent("s-new");
		const list = client.getQueryData<{ pages: { items: { id: string }[] }[] }>(sessionKeys.listPage("visible", ""));
		expect(list?.pages[0]?.items.map((item) => item.id)).toContain("s-new");
	});

	test("failure keeps the text and reuses the same requestId on retry", async () => {
		const posts: Post[] = [];
		let attempts = 0;
		await renderDraft({
			posts,
			createResponse: () => {
				attempts += 1;
				if (attempts === 1) {
					return new Response(JSON.stringify({ error: "model is not configured" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ session: sessionView() }), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const user = userEvent.setup();
		await user.type(screen.getByTestId("new-session-input"), "try me");
		await user.click(screen.getByTestId("composer-send"));
		await waitFor(() => expect(screen.getByTestId("new-session-error")).toHaveTextContent("model is not configured"));
		expect(screen.getByTestId("new-session-input")).toHaveValue("try me");

		// The draft id is kept across the failure: a lost response must not create a second session.
		await user.click(screen.getByTestId("composer-send"));
		await waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1]?.body.requestId).toBe(posts[0]?.body.requestId);
	});

	test("treats /compact as unavailable and sends nothing", async () => {
		const posts: Post[] = [];
		await renderDraft({ posts });
		const user = userEvent.setup();
		await user.type(screen.getByTestId("new-session-input"), "/compact anything");
		expect(screen.getByTestId("slash-hint")).toHaveTextContent("not available before the session exists");
		fireEvent.keyDown(screen.getByTestId("new-session-input"), { key: "Enter" });
		await waitFor(() =>
			expect(screen.getByTestId("new-session-error")).toHaveTextContent("not available before the session exists"),
		);
		expect(posts).toHaveLength(0);
	});
});
