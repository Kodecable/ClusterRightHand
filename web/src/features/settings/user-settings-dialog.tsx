import type { ModelRef, RulePreset, ThinkingLevel } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { ModelSelect } from "@/components/model-select";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { ThinkingLevelSelect } from "@/components/thinking-level-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatAccountsSection } from "@/features/channels/chat-accounts-section";
import { useModels } from "@/features/settings/api";
import { useSaveUserSettings, useUserSettings } from "@/hooks/use-user-settings";
import { useLocale } from "@/lib/i18n";
import { availableModel, supportedThinkingLevels, withThinkingLevel } from "@/lib/thinking-level";

/**
 * The signed-in user's settings (doc/design/webui.md "Settings dialog"): the language, the defaults for new
 * sessions and the chat account settings. A change is saved immediately; the dialog has no Save button.
 */
export function UserSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLingui();
	const { locale, setLocale, switching } = useLocale();
	const settings = useUserSettings();
	const save = useSaveUserSettings();
	const models = useModels();
	const available = models.data ?? [];

	const defaultModel = settings.data?.defaultModel ?? null;
	const defaultAvailableModel = availableModel(available, defaultModel ?? undefined);
	const thinkingLevels = supportedThinkingLevels(available, defaultModel ?? undefined);
	const thinkingLevel: ThinkingLevel =
		defaultModel?.thinkingLevel !== undefined && thinkingLevels.includes(defaultModel.thinkingLevel)
			? defaultModel.thinkingLevel
			: "off";

	const changeLocale = (next: "en" | "zh-CN") => {
		if (next === locale && settings.data?.locale === next) return;
		save.mutate(
			{ locale: next },
			{
				onSuccess: () => setLocale(next),
			},
		);
	};

	const changeModel = (model: ModelRef) => {
		// A level the new model does not support is not part of the default; start from off.
		save.mutate({ defaultModel: withThinkingLevel(model, "off") });
	};

	const changeThinkingLevel = (level: ThinkingLevel) => {
		if (defaultModel === null) return;
		save.mutate({ defaultModel: withThinkingLevel(defaultModel, level) });
	};

	const changeRulePreset = (rulePreset: RulePreset) => {
		save.mutate({ defaultRulePreset: rulePreset });
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl" data-testid="user-settings-dialog" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle>
						<Trans>Settings</Trans>
					</DialogTitle>
				</DialogHeader>

				<Tabs defaultValue="general" className="min-h-0">
					<TabsList className="w-full">
						<TabsTrigger value="general" data-testid="settings-tab-general">
							<Trans>General</Trans>
						</TabsTrigger>
						<TabsTrigger value="sessions" data-testid="settings-tab-sessions">
							<Trans>Sessions</Trans>
						</TabsTrigger>
						<TabsTrigger value="chat" data-testid="settings-tab-chat">
							<Trans>Chat</Trans>
						</TabsTrigger>
					</TabsList>

					<TabsContent value="general" className="max-h-[70vh] overflow-y-auto pt-2 pr-1">
						<section className="grid gap-2" aria-labelledby="settings-language-heading">
							<h3 id="settings-language-heading" className="text-sm font-medium">
								<Trans>Language</Trans>
							</h3>
							<RadioGroup
								value={locale}
								onValueChange={(value) => {
									if (value === "en" || value === "zh-CN") changeLocale(value);
								}}
								disabled={switching || save.isPending}
								className="gap-2"
							>
								<label htmlFor="settings-locale-en" className="flex items-center gap-2 text-sm">
									<RadioGroupItem id="settings-locale-en" value="en" data-testid="settings-language-en" />
									English
								</label>
								<label htmlFor="settings-locale-zh" className="flex items-center gap-2 text-sm">
									<RadioGroupItem id="settings-locale-zh" value="zh-CN" data-testid="settings-language-zh" />
									中文 (简体)
								</label>
							</RadioGroup>
						</section>
					</TabsContent>

					<TabsContent value="sessions" className="max-h-[70vh] overflow-y-auto pt-2 pr-1">
						<section className="grid gap-4" aria-labelledby="settings-sessions-heading">
							<h3 id="settings-sessions-heading" className="text-sm font-medium">
								<Trans>New session defaults</Trans>
							</h3>
							<div className="grid gap-1">
								<Label htmlFor="settings-default-model">
									<Trans>Default model</Trans>
								</Label>
								<ModelSelect
									id="settings-default-model"
									dataTestId="settings-default-model"
									models={available}
									value={defaultModel ?? undefined}
									placeholder={t`First available model`}
									disabled={save.isPending}
									onChange={changeModel}
								/>
								{defaultModel !== null && (
									<Button
										type="button"
										size="xs"
										variant="ghost"
										className="w-fit"
										disabled={save.isPending}
										onClick={() => save.mutate({ defaultModel: null })}
									>
										<Trans>Use the first available model</Trans>
									</Button>
								)}
							</div>
							<div className="grid gap-1">
								<Label htmlFor="settings-default-thinking">
									<Trans>Thinking level</Trans>
								</Label>
								<ThinkingLevelSelect
									id="settings-default-thinking"
									dataTestId="settings-default-thinking"
									model={defaultAvailableModel}
									levels={thinkingLevels}
									value={thinkingLevel}
									disabled={defaultModel === null || save.isPending}
									onChange={changeThinkingLevel}
								/>
							</div>
							<div className="grid gap-1">
								<Label htmlFor="settings-default-rule-preset">
									<Trans>Rule preset</Trans>
								</Label>
								<RulePresetSelect
									id="settings-default-rule-preset"
									dataTestId="settings-default-rule-preset"
									value={settings.data?.defaultRulePreset ?? "ask"}
									disabled={save.isPending}
									onChange={changeRulePreset}
								/>
							</div>
						</section>
					</TabsContent>

					<TabsContent value="chat" className="max-h-[70vh] overflow-y-auto pt-2 pr-1">
						<ChatAccountsSection />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
