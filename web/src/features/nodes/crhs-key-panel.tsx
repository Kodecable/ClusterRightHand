import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { CardSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { trustSnippet } from "@/features/credentials/trust";
import { useCrhsKey } from "@/features/nodes/api";

/**
 * crhs's authorization signing key (doc/design/privilege.md "Authorization signing key"): the
 * authorized_keys line and the fingerprint to trust on a node, plus the
 * ready-made `[[trust]]` block for privileged.toml.
 */
export function CrhsKeyPanel() {
	const { t } = useLingui();
	const key = useCrhsKey();
	const [snippet, setSnippet] = useState(false);
	if (key.isError) return <ErrorState error={key.error} retry={() => void key.refetch()} compact />;
	if (!key.data) return <CardSkeleton />;
	const block = trustSnippet(key.data.authorizedKey);
	return (
		<section className="grid gap-2" aria-labelledby="crhs-key-heading" data-testid="crhs-key-panel">
			<h2 id="crhs-key-heading" className="text-sm font-medium">
				<Trans>crhs signing key</Trans>
			</h2>
			<p className="max-w-3xl text-sm text-muted-foreground">
				<Trans>
					A node authorizes privileged tasks signed by this key when its privileged.toml trusts the key below.
				</Trans>
			</p>
			<KeyValueList
				items={[
					{ label: t`Fingerprint`, value: key.data.fingerprint, mono: true },
					{ label: t`Public key`, value: key.data.authorizedKey, mono: true },
				]}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" size="sm" onClick={() => setSnippet((shown) => !shown)}>
					{snippet ? <Trans>Hide trust snippet</Trans> : <Trans>Export trust snippet</Trans>}
				</Button>
				{snippet && <CopyButton text={block} label={t`Copy trust snippet`} showLabel variant="outline" />}
			</div>
			{snippet && <CodeText text={block} maxLines={40} label={t`crhs trust snippet`} copy={false} />}
		</section>
	);
}
