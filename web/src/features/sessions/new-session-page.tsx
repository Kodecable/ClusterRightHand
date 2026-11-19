import type { AvailableModel, ModelRef, RulePreset, ThinkingLevel, UserSettings } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useModels, useSessionModelPreset } from "@/features/settings/api";
import { useSaveUserSettings, useUserSettings } from "@/hooks/use-user-settings";
import { errorMessage } from "@/lib/api/client";
import { useAuth } from "@/lib/session";
import { supportedThinkingLevels, withThinkingLevel } from "@/lib/thinking-level";
import { insertSessionIntoListCaches, useAvailableExtensions, useCreateSession } from "./api";
import { AttachmentChips, AttachmentMenu, AttachmentPickerDialog, useComposerAttachments } from "./attachments";
import { ComposerFooter, type ComposerFooterState } from "./composer-footer";
import { ComposerShell, handleComposerKey, UnknownCommandHint, useTextareaAutosize } from "./composer-input";
import { ExtensionsButton, ExtensionsDialog } from "./extensions-dialog";
import { isUnknownSlashCommand, parseSlashCommand } from "./slash-commands";

/** The draft's textarea grows up to half of the window. */
const halfWindowHeight = (): number => Math.floor(window.innerHeight / 2);

const sameModel = (a: ModelRef | undefined, b: ModelRef): boolean =>
	a !== undefined && a.provider === b.provider && a.modelId === b.modelId;

interface ResolvedDefaults {
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
}

/**
 * A new session's defaults (doc/design/webui.md "New session"): the user's default model, then the session
 * model preset, then the first offered model. A default a provider no longer offers falls through to the next
 * step; the thinking level comes with the model it belonged to and is dropped when that model changed levels.
 */
export function resolveNewSessionDefaults(
	available: readonly AvailableModel[],
	settings: UserSettings | null,
	sessionModel: ModelRef | null,
): ResolvedDefaults {
	const offered = (candidate: ModelRef | null | undefined): AvailableModel | undefined =>
		candidate === null || candidate === undefined
			? undefined
			: available.find((model) => model.provider === candidate.provider && model.modelId === candidate.modelId);
	for (const candidate of [settings?.defaultModel, sessionModel]) {
		const found = offered(candidate);
		if (found === undefined || candidate === null || candidate === undefined) continue;
		const level =
			candidate.thinkingLevel !== undefined && found.thinkingLevels.includes(candidate.thinkingLevel)
				? candidate.thinkingLevel
				: "off";
		return { model: { provider: found.provider, modelId: found.modelId }, thinkingLevel: level };
	}
	const first = available[0];
	return {
		model: first === undefined ? undefined : { provider: first.provider, modelId: first.modelId },
		thinkingLevel: "off",
	};
}

/**
 * The blank draft page (doc/design/webui.md "New session"): no transcript and no session yet, just the centred
 * prompt and the composer. Its footer is the session footer fed from local state; the first send creates the
 * session and submits the message in one request, then replaces the route with the new session's page.
 */
export function NewSessionPage() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const auth = useAuth();
	const queryClient = useQueryClient();
	const models = useModels();
	const settings = useUserSettings();
	const sessionPreset = useSessionModelPreset();
	const saveSettings = useSaveUserSettings();
	const create = useCreateSession();
	const availableExtensions = useAvailableExtensions();
	const available = useMemo(() => models.data ?? [], [models.data]);
	const [model, setModel] = useState<ModelRef | undefined>();
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [rulePreset, setRulePreset] = useState<RulePreset>("ask");
	const [budgetRemaining, setBudgetRemaining] = useState<number | null>(null);
	// The draft's own off switches (doc/design/extensions.md "Extensions"): a new session has all available
	// extensions on, and the local list goes with the create request. It resets with the page's state.
	const extensions = useMemo(() => availableExtensions.data ?? [], [availableExtensions.data]);
	const [disabledExtensions, setDisabledExtensions] = useState<string[]>([]);
	const [extensionsOpen, setExtensionsOpen] = useState(false);
	// A refetched list may drop an extension (a revoked grant); only names the draft still shows are sent.
	const offExtensions = useMemo(
		() => disabledExtensions.filter((name) => extensions.some((extension) => extension.name === name)),
		[disabledExtensions, extensions],
	);
	const [text, setText] = useState("");
	const [sendError, setSendError] = useState<string>();
	const attachments = useComposerAttachments(auth.user?.username);
	const [pickerOpen, setPickerOpen] = useState(false);
	// One id for the draft's lifetime: a retry after a lost response returns the session the first
	// attempt made instead of creating a second one.
	const [requestId] = useState(() => crypto.randomUUID());
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// The draft starts from the settings once, not again whenever a settings change arrives.
	const initialised = useRef(false);
	// A model change also resets the thinking level, and the level picker may report that reset as a
	// change of its own; skip the duplicate save so one action is one request.
	const lastSavedModel = useRef<string | undefined>(undefined);

	const chosen = useMemo(() => {
		if (model !== undefined && available.some((candidate) => sameModel(model, candidate))) return model;
		const first = available[0];
		return first === undefined ? undefined : { provider: first.provider, modelId: first.modelId };
	}, [model, available]);
	const levels = useMemo(() => supportedThinkingLevels(available, chosen), [available, chosen]);

	// Opening the page applies the user's defaults; a failed settings request just leaves the first model.
	useEffect(() => {
		if (initialised.current || models.data === undefined) return;
		if (settings.isPending || sessionPreset.isPending) return;
		initialised.current = true;
		const resolved = resolveNewSessionDefaults(available, settings.data ?? null, sessionPreset.data ?? null);
		setModel(resolved.model);
		setThinkingLevel(resolved.thinkingLevel);
		setRulePreset(settings.data?.defaultRulePreset ?? "ask");
	}, [available, models.data, settings.data, settings.isPending, sessionPreset.data, sessionPreset.isPending]);

	// A model change may not support the current level. The list always includes `off`; falling back to it
	// keeps the draft valid.
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
	const canSend =
		chosen !== undefined &&
		text.trim() !== "" &&
		!create.isPending &&
		!compactUnavailable &&
		!attachments.busy &&
		attachments.failures === 0;

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
				...(attachments.sendable.length > 0 ? { attachments: attachments.sendable } : {}),
				model: withThinkingLevel(chosen, thinkingLevel),
				rulePreset,
				budgetRemaining,
				...(offExtensions.length > 0 ? { disabledExtensions: offExtensions } : {}),
			});
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

	const saveDefaultModel = (next: ModelRef) => {
		const key = JSON.stringify(next);
		if (lastSavedModel.current === key) return;
		lastSavedModel.current = key;
		saveSettings.mutate({ defaultModel: next });
	};

	const footer: ComposerFooterState = {
		model: chosen,
		thinkingLevel,
		rulePreset,
		budgetRemaining,
		budgetUsedTokens: 0,
		configure: true,
		isRoot: true,
		ruleCount: 0,
		pending: false,
		onModelChange: (next) => {
			setModel(next);
			// A level the new model does not support is not part of the request; start from off as the
			// session footer does when a model is picked.
			setThinkingLevel("off");
			saveDefaultModel(withThinkingLevel(next, "off"));
		},
		onThinkingLevelChange: (level) => {
			setThinkingLevel(level);
			if (chosen !== undefined) saveDefaultModel(withThinkingLevel(chosen, level));
		},
		onRulePresetChange: (next) => {
			setRulePreset(next);
			saveSettings.mutate({ defaultRulePreset: next });
		},
		onBudgetChange: setBudgetRemaining,
	};

	const noModels = models.data !== undefined && available.length === 0;
	const extensionsOn = extensions.length - offExtensions.length;

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
				{/* The draft's extensions button sits where the session header shows its own, clear of the back button. */}
				{extensions.length > 0 && (
					<div className="absolute top-2 right-3">
						<ExtensionsButton
							enabled={extensionsOn}
							total={extensions.length}
							testId="new-session-extensions"
							onClick={() => setExtensionsOpen(true)}
						/>
					</div>
				)}
				<div className="flex h-full items-center justify-center px-6">
					<h1 className="text-center text-2xl font-medium text-foreground" data-testid="new-session-prompt">
						<Trans>What's on your plan today?</Trans>
					</h1>
				</div>
			</div>
			<ComposerShell
				inputId="new-session-input"
				onSubmit={() => void submit()}
				onDropFiles={auth.user === null ? undefined : attachments.addFiles}
			>
				<AttachmentChips attachments={attachments} />
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
					onPaste={(event) => {
						const files = [...event.clipboardData.files];
						if (files.length === 0) return;
						event.preventDefault();
						attachments.addFiles(files);
					}}
					onChange={(event) => {
						// Editing does not start a new request id: the draft's id lasts until the session exists.
						setText(event.target.value);
						setSendError(undefined);
					}}
					className="min-h-9 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent disabled:bg-transparent dark:disabled:bg-transparent"
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
						attach={<AttachmentMenu attachments={attachments} onChooseLibrary={() => setPickerOpen(true)} />}
					/>
				</div>
			</ComposerShell>
			<AttachmentPickerDialog
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={(files) => attachments.addLibraryFiles(files)}
			/>
			{extensions.length > 0 && (
				<ExtensionsDialog
					open={extensionsOpen}
					onOpenChange={setExtensionsOpen}
					extensions={extensions}
					disabled={offExtensions}
					onChange={setDisabledExtensions}
				/>
			)}
		</div>
	);
}
