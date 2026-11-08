import type { ModelRef, RulePreset, ThinkingLevel } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/session";
import { useModels } from "@/features/settings/api";
import { errorMessage } from "@/lib/api/client";
import { readStorage, writeStorage } from "@/lib/storage";
import { supportedThinkingLevels, withThinkingLevel } from "@/lib/thinking-level";
import { insertSessionIntoListCaches, useCreateSession } from "./api";
import { ComposerFooter, type ComposerFooterState } from "./composer-footer";
import { ComposerShell, handleComposerKey, UnknownCommandHint, useTextareaAutosize } from "./composer-input";
import { isUnknownSlashCommand, parseSlashCommand } from "./slash-commands";

/** Where the draft remembers the model of the last session it created (D117). */
export const NEW_SESSION_MODEL_STORAGE_KEY = "crh.newSession.model";

function readStoredModel(): ModelRef | undefined {
	const raw = readStorage(NEW_SESSION_MODEL_STORAGE_KEY);
	if (raw === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.modelId !== "string") return undefined;
	return { provider: record.provider, modelId: record.modelId };
}

/** `writeStorage` never throws: a disabled or full localStorage must not stop a session from being created. */
function writeStoredModel(model: ModelRef): void {
	writeStorage(NEW_SESSION_MODEL_STORAGE_KEY, JSON.stringify({ provider: model.provider, modelId: model.modelId }));
}

/** The draft's textarea grows up to half of the window. */
const halfWindowHeight = (): number => Math.floor(window.innerHeight / 2);

const sameModel = (a: ModelRef | undefined, b: ModelRef): boolean =>
	a !== undefined && a.provider === b.provider && a.modelId === b.modelId;

/**
 * The blank draft page (D117, doc/webui.md#新建会话): no transcript and no session yet, just the centred
 * prompt and the composer. Its footer is the session footer fed from local state; the first send creates the
 * session and submits the message in one request, then replaces the route with the new session's page.
 */
export function NewSessionPage() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const auth = useAuth();
	const queryClient = useQueryClient();
	const models = useModels();
	const create = useCreateSession();
	const available = useMemo(() => models.data ?? [], [models.data]);
	const [model, setModel] = useState<ModelRef | undefined>(() => readStoredModel());
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [rulePreset, setRulePreset] = useState<RulePreset>("ask");
	const [budgetRemaining, setBudgetRemaining] = useState<number | null>(null);
	const [text, setText] = useState("");
	const [sendError, setSendError] = useState<string>();
	// One id for the draft's lifetime (D117): a retry after a lost response returns the session the first
	// attempt made instead of creating a second one.
	const [requestId] = useState(() => crypto.randomUUID());
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const chosen = useMemo(() => {
		if (model !== undefined && available.some((candidate) => sameModel(model, candidate))) return model;
		const first = available[0];
		return first === undefined ? undefined : { provider: first.provider, modelId: first.modelId };
	}, [model, available]);
	const levels = useMemo(() => supportedThinkingLevels(available, chosen), [available, chosen]);

	// The stored model may not be offered, and a model change may not support the current level. The list
	// always includes `off`; falling back to it keeps the draft valid.
	useEffect(() => {
		if (levels.includes(thinkingLevel)) return;
		setThinkingLevel(levels.includes("off") ? "off" : (levels[0] ?? "off"));
	}, [levels, thinkingLevel]);

	useTextareaAutosize(textareaRef, text, halfWindowHeight);

	const parsedCommand = parseSlashCommand(text);
	// The session does not exist yet, so there is nothing to compact. `/compact` stays a draft that is not
	// sent; the hint says why rather than silently posting it as a message.
	const compactUnavailable = parsedCommand?.command.name === "compact";
	const unknownCommand = isUnknownSlashCommand(text);
	const canSend = chosen !== undefined && text.trim() !== "" && !create.isPending && !compactUnavailable;

	const submit = async () => {
		if (compactUnavailable) {
			setSendError(t`Compaction is not available before the session exists.`);
			return;
		}
		if (!canSend || chosen === undefined) return;
		const value = text.trim();
		setSendError(undefined);
		try {
			const session = await create.mutateAsync({
				requestId,
				message: value,
				model: withThinkingLevel(chosen, thinkingLevel),
				rulePreset,
				budgetRemaining,
			});
			writeStoredModel(chosen);
			if (auth.user !== null) {
				insertSessionIntoListCaches(queryClient, session, {
					id: auth.user.id,
					isAdmin: auth.user.kind === "admin",
				});
			}
			void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id }, replace: true });
		} catch (err) {
			// Stay on the draft with the text and the same request id: the retry is deduplicated by the server.
			setSendError(errorMessage(err));
		}
	};

	const footer: ComposerFooterState = {
		model: chosen,
		thinkingLevel,
		rulePreset,
		budgetRemaining,
		configure: true,
		isRoot: true,
		ruleCount: 0,
		pending: false,
		onModelChange: (next) => {
			setModel(next);
			// A level the new model does not support is not part of the request; start from off as the
			// session footer does when a model is picked.
			setThinkingLevel("off");
		},
		onThinkingLevelChange: setThinkingLevel,
		onRulePresetChange: setRulePreset,
		onBudgetChange: setBudgetRemaining,
	};

	const noModels = models.data !== undefined && available.length === 0;

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="new-session-page">
			<div className="relative min-h-0 flex-1" data-slot="transcript" data-testid="new-session-transcript">
				{/* No header row: below `lg` the list is behind this button, as on the session page. */}
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t`Back to the session list`}
					title={t`Back to the session list`}
					className="absolute top-2 left-2 lg:hidden"
					data-testid="session-back"
					onClick={() => void navigate({ to: "/sessions" })}
				>
					<ChevronLeftIcon />
				</Button>
				<div className="flex h-full items-center justify-center px-6">
					<h1 className="text-center text-2xl font-medium text-foreground" data-testid="new-session-prompt">
						<Trans>What's on your plan today?</Trans>
					</h1>
				</div>
			</div>
			<ComposerShell inputId="new-session-input" onSubmit={() => void submit()}>
				<Textarea
					ref={textareaRef}
					id="new-session-input"
					data-testid="new-session-input"
					rows={1}
					value={text}
					disabled={create.isPending}
					style={{ maxHeight: "50vh", fieldSizing: "fixed" }}
					placeholder={t`Ask the agent to do something. Enter sends, Shift+Enter adds a line.`}
					onKeyDown={(event) => handleComposerKey(event, () => void submit())}
					onChange={(event) => {
						// Editing does not start a new request id: the draft's id lasts until the session exists.
						setText(event.target.value);
						setSendError(undefined);
					}}
					className="min-h-9 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				{compactUnavailable && (
					<p className="px-3 pb-1 text-xs text-warn" data-testid="slash-hint">
						<Trans>Compaction is not available before the session exists.</Trans>
					</p>
				)}
				{unknownCommand && !compactUnavailable && <UnknownCommandHint />}
				{sendError !== undefined && (
					<div className="px-3 pb-1" data-testid="new-session-error">
						<ErrorText error={new Error(sendError)} />
					</div>
				)}
				{noModels && (
					<p className="px-3 pb-1 text-xs text-warn" role="status">
						<Trans>No models are configured, so sessions cannot start.</Trans>
					</p>
				)}
				<div className="px-2 pb-1.5">
					<ComposerFooter
						state={footer}
						stoppable={false}
						sending={create.isPending}
						sendDisabled={!canSend}
						onStop={() => {}}
						stopPending={false}
					/>
				</div>
			</ComposerShell>
		</div>
	);
}
