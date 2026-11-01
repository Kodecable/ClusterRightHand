import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PresetSelect } from "@/components/preset-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ApiTokenView, Preset, Rule } from "@/lib/api/types";
import { useSetTokenRules } from "./api";
import { PresetHelp } from "./preset-help";

/** A token's preset and its extra rules (a JSON list, edited as text). */
export function RulesDialog({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const save = useSetTokenRules();
	const [preset, setPreset] = useState<Preset>(token.rules?.preset ?? "ask");
	const [text, setText] = useState(() => JSON.stringify({ rules: token.rules?.rules ?? [] }, null, 2));
	const [error, setError] = useState<string>();

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
							<Label htmlFor={`${prefix}-preset`}>{t`Preset`}</Label>
							<PresetSelect id={`${prefix}-preset`} className="w-40" value={preset} onChange={setPreset} />
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={save.isPending || preset === token.rules?.preset}
							onClick={() =>
								save.mutate({ id: token.id, body: { preset } }, { onSuccess: () => toast.success(t`Preset saved.`) })
							}
						>
							<Trans>Save preset</Trans>
						</Button>
						<span className="text-xs text-muted-foreground">
							<PresetHelp preset={preset} />
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
								Each rule: action (allow, deny, require-approval), optional method (exec, file.read, file.write), nodes,
								and exact or prefix.
							</Trans>
						</p>
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
