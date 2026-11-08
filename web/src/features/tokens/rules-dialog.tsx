import type { ApiTokenView, Rule, RulePreset } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { toast } from "sonner";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { refNames, rulesWithNames } from "@/lib/refs";
import { useSetTokenRules } from "./api";
import { RulePresetHelp } from "./rule-preset-help";

/** A token's rule preset and its extra rules (a JSON list, edited as text). */
export function RulesDialog({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const save = useSetTokenRules();
	const [rulePreset, setRulePreset] = useState<RulePreset>(token.rules?.rulePreset ?? "ask");
	// Show names rather than the stored UUIDs; the server accepts names on write (D109).
	const [text, setText] = useState(() =>
		JSON.stringify({ rules: rulesWithNames(token.rules?.rules ?? [], refNames(token.refs)) }, null, 2),
	);
	const [error, setError] = useState<string>();
	const deletedRef = (token.rules?.rules ?? [])
		.flatMap((rule) => rule.nodes ?? [])
		.some((ref) => token.refs[ref] === null);

	const parseRules = (): Rule[] | undefined => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (failure) {
			setError(t`Not valid JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
			return undefined;
		}
		const rules = (parsed as { rules?: unknown } | null)?.rules;
		if (!Array.isArray(rules)) {
			setError(t`Expected an object like {"rules": [...]}.`);
			return undefined;
		}
		setError(undefined);
		return rules as Rule[];
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-xl" data-testid="token-rules-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Rules of {token.name}</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>What this token may do without approval; anything else waits for you.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor={`${prefix}-rulePreset`}>{t`Rule preset`}</Label>
							<RulePresetSelect
								id={`${prefix}-rulePreset`}
								className="w-40"
								value={rulePreset}
								onChange={setRulePreset}
							/>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={save.isPending || rulePreset === token.rules?.rulePreset}
							onClick={() =>
								save.mutate(
									{ id: token.id, body: { rulePreset } },
									{ onSuccess: () => toast.success(t`Rule preset saved.`) },
								)
							}
						>
							<Trans>Save rule preset</Trans>
						</Button>
						<span className="text-xs text-muted-foreground">
							<RulePresetHelp rulePreset={rulePreset} />
						</span>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor={`${prefix}-rules`}>{t`Added rules (JSON)`}</Label>
						<Textarea
							id={`${prefix}-rules`}
							rows={10}
							className="font-mono text-xs"
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							<Trans>
								Each rule: action (allow, deny, require-approval), optional method (exec, file.read, file.write), nodes
								(names or ids of nodes and node groups, or _all), and exact or prefix.
							</Trans>
						</p>
						{deletedRef && (
							<p className="text-xs text-warn">
								<Trans>
									Some rules reference deleted nodes or node groups. Remove or replace those references before saving.
								</Trans>
							</p>
						)}
					</div>
					{error !== undefined && (
						<p role="alert" className="text-sm text-danger">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Close</Trans>
						</Button>
						<Button
							type="button"
							disabled={save.isPending}
							onClick={() => {
								const rules = parseRules();
								if (rules === undefined) return;
								save.mutate(
									{ id: token.id, body: { rules } },
									{
										onSuccess: () => {
											toast.success(t`Rules saved.`);
											onClose();
										},
									},
								);
							}}
						>
							<Trans>Save rules</Trans>
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
