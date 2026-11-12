import { Trans, useLingui } from "@lingui/react/macro";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";

/**
 * The enrollment result: the command to run on the node, then the crhs address and the one-time
 * token, each with its own copy button so the token stays out of the shell history.
 */
export function EnrollmentCode({ address, token }: { address: string; token: string }) {
	const { t } = useLingui();
	return (
		<>
			<CodeText text="sudo crha enroll" maxLines={1} label={t`Enrollment command`} />
			<fieldset aria-label={t`crhs address`} className="m-0 grid gap-1 border-0 p-0">
				<span className="text-xs text-muted-foreground">
					<Trans>crhs address</Trans>
				</span>
				<div className="flex items-start gap-2">
					<code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
						{address}
					</code>
					<CopyButton text={address} label={t`Copy crhs address`} variant="outline" />
				</div>
			</fieldset>
			<fieldset aria-label={t`Enrollment token`} className="m-0 grid gap-1 border-0 p-0">
				<span className="text-xs text-muted-foreground">
					<Trans>Enrollment token</Trans>
				</span>
				<div className="flex items-start gap-2">
					<code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
						{token}
					</code>
					<CopyButton text={token} label={t`Copy enrollment token`} variant="outline" />
				</div>
			</fieldset>
		</>
	);
}
