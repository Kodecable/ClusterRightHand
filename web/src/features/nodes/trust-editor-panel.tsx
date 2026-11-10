import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { FieldShell } from "@/components/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
	buildTrustBlock,
	defaultDraft,
	formatGuardLines,
	type GuardLinesError,
	parseGuardLines,
	type TrustDraft,
	type TrustKeySource,
} from "./trust-editor";

const GUARD_ERRORS: Record<GuardLinesError, MessageDescriptor> = {
	"unknown-method": msg`Each rule starts with exec, file.read or file.write.`,
	"missing-target": msg`Each rule needs a target after the method.`,
};

/** The select label of a key source; Passkey is the credential kind, not the name. */
function sourceLabel(source: TrustKeySource, passkeyLabel: string): string {
	if (source.kind === "crhs") return "crhs";
	if (source.kind === "webauthn") return `${source.name} (${passkeyLabel})`;
	return source.name;
}

/**
 * The trust configuration editor of a node (doc/design/privilege.md "Trust configuration"): pick a
 * signing key, narrow the allow/deny rules and export the `[[trust]]` block for
 * the node's privileged.toml. The node enforces it; the console only builds it.
 */
export function TrustEditor({ sources }: { sources: TrustKeySource[] }) {
	const { t, i18n } = useLingui();
	const prefix = useId();
	const id = (key: string) => `${prefix}-${key}`;
	const [sourceIndex, setSourceIndex] = useState(0);
	const source = sources[sourceIndex];
	const [draft, setDraft] = useState<TrustDraft>(() => defaultDraft(sources[0] as TrustKeySource));
	const [allowText, setAllowText] = useState(() => formatGuardLines(draft.allow));
	const [denyText, setDenyText] = useState(() => formatGuardLines(draft.deny));

	const allow = useMemo(() => parseGuardLines(allowText), [allowText]);
	const deny = useMemo(() => parseGuardLines(denyText), [denyText]);
	const preview = useMemo(
		() =>
			buildTrustBlock({
				...draft,
				allow: "lines" in allow ? allow.lines : draft.allow,
				deny: "lines" in deny ? deny.lines : draft.deny,
			}),
		[allow, deny, draft],
	);

	if (source === undefined) return null;

	const choose = (index: number) => {
		const next = sources[index];
		if (next === undefined) return;
		const fresh = defaultDraft(next);
		setSourceIndex(index);
		setDraft(fresh);
		setAllowText(formatGuardLines(fresh.allow));
		setDenyText(formatGuardLines(fresh.deny));
	};

	const set = <K extends keyof TrustDraft>(key: K, value: TrustDraft[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));

	return (
		<div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" data-testid="trust-editor">
			<div className="grid content-start gap-3">
				<div className="grid gap-1.5">
					<Label htmlFor={id("source")}>{t`Signing key`}</Label>
					<Select
						value={String(sourceIndex)}
						onValueChange={(value) => choose(Number(value))}
						disabled={sources.length <= 1}
					>
						<SelectTrigger id={id("source")} className="w-full" data-testid="trust-source">
							<SelectValue>
								{(current: string | null) => sourceLabel(sources[Number(current ?? 0)] ?? source, t`Passkey`)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{sources.map((entry, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: sources are the keys themselves; their order is stable within a dialog
								<SelectItem key={`${entry.kind}-${index}`} value={String(index)}>
									{sourceLabel(entry, t`Passkey`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						<Trans>
							Narrow the rules before trusting a key: anything not allowed here is refused on the node even when it was
							authorized.
						</Trans>
					</p>
				</div>

				<FieldShell id={id("name")} label={t`Entry name`}>
					<Input
						id={id("name")}
						value={draft.name}
						maxLength={100}
						onChange={(event) => set("name", event.target.value)}
					/>
				</FieldShell>

				<div className="flex items-center gap-2">
					<Checkbox
						id={id("exact")}
						checked={draft.requireExact}
						onCheckedChange={(checked) => set("requireExact", Boolean(checked))}
					/>
					<Label htmlFor={id("exact")}>
						<Trans>Require the exact command</Trans>
					</Label>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id={id("uv")}
						checked={draft.requireUv}
						onCheckedChange={(checked) => set("requireUv", Boolean(checked))}
					/>
					<Label htmlFor={id("uv")}>
						<Trans>Require user verification</Trans>
					</Label>
				</div>
				<FieldShell
					id={id("ttl")}
					label={t`Max TTL`}
					description={t`A duration such as 5m or 24h. Empty means no limit.`}
				>
					<Input
						id={id("ttl")}
						value={draft.maxTtl}
						placeholder="5m"
						onChange={(event) => set("maxTtl", event.target.value)}
					/>
				</FieldShell>

				<FieldShell
					id={id("allow")}
					label={t`Allow`}
					description={t`One rule per line: method and a target prefix. Empty allows any method and target.`}
					error={"error" in allow ? i18n._(GUARD_ERRORS[allow.error]) : undefined}
				>
					<Textarea
						id={id("allow")}
						rows={4}
						className="font-mono text-xs"
						value={allowText}
						onChange={(event) => setAllowText(event.target.value)}
					/>
				</FieldShell>
				<FieldShell
					id={id("deny")}
					label={t`Deny`}
					description={t`One rule per line: method and a target prefix.`}
					error={"error" in deny ? i18n._(GUARD_ERRORS[deny.error]) : undefined}
				>
					<Textarea
						id={id("deny")}
						rows={3}
						className="font-mono text-xs"
						value={denyText}
						onChange={(event) => setDenyText(event.target.value)}
					/>
				</FieldShell>
			</div>

			<section className="grid content-start gap-2" aria-label={t`Trust snippet`}>
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-sm font-medium">
						<Trans>privileged.toml</Trans>
					</h3>
					<CopyButton text={preview} label={t`Copy trust snippet`} showLabel variant="outline" />
				</div>
				<CodeText text={preview} maxLines={40} label={t`Trust snippet`} copy={false} />
				<p className="text-xs text-muted-foreground">
					<Trans>
						Paste this block into the node's privileged.toml. The node must be restarted to pick up the change, and
						`crha status` shows the trust digest it reports.
					</Trans>
				</p>
			</section>
		</div>
	);
}
