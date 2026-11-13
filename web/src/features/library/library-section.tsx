import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { EmptyHint } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { Panel, SectionHeader } from "@/components/section";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { isNotFound } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { linkClass } from "@/lib/utils";
import { useLibrary } from "./api";
import { LibraryLimitsDialog } from "./limits-dialog";

/**
 * A user's or user group's library (doc/design/webui.md "User and user group pages"): the usage, the
 * three limits, an administrator's **Edit limits** dialog and a link to the library page.
 */
export function LibrarySection({ reference, testId = "library-section" }: { reference: string; testId?: string }) {
	const { t, i18n } = useLingui();
	const library = useLibrary(reference);
	const [editing, setEditing] = useState(false);

	if (library.isError) {
		if (isNotFound(library.error)) {
			return (
				<section className="grid gap-2" aria-labelledby={`${testId}-heading`} data-testid={testId}>
					<SectionHeader id={`${testId}-heading`} title={<Trans>Library</Trans>} />
					<EmptyHint>
						<Trans>No library exists for this account.</Trans>
					</EmptyHint>
				</section>
			);
		}
		return <ErrorState error={library.error} compact retry={() => void library.refetch()} />;
	}
	if (!library.data) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={testId}>
				<Spinner decorative />
				<Trans>Loading library…</Trans>
			</div>
		);
	}

	const current = library.data;
	return (
		<Panel as="section" aria-labelledby={`${testId}-heading`} data-testid={testId} className="grid gap-3">
			<SectionHeader
				id={`${testId}-heading`}
				title={<Trans>Library</Trans>}
				actions={
					<>
						<Link to="/library/$library" params={{ library: current.ref }} search={{}} className={linkClass}>
							<Trans>Open library</Trans>
						</Link>
						{current.capabilities.manage && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setEditing(true)}
								data-testid="edit-library-limits"
							>
								<PencilIcon />
								<Trans>Edit limits</Trans>
							</Button>
						)}
					</>
				}
			/>
			<KeyValueList
				columns={2}
				items={[
					{ label: t`Files`, value: `${current.usage.files} / ${current.limits.files}` },
					{
						label: t`Total size`,
						value: `${formatBytes(current.usage.bytes, i18n.locale)} / ${formatBytes(current.limits.totalBytes, i18n.locale)}`,
					},
					{ label: t`One file`, value: formatBytes(current.limits.fileBytes, i18n.locale) },
					{
						label: t`Limits`,
						value:
							current.limits.files === 0
								? t`Nothing is allowed until an administrator raises them.`
								: t`Changing them applies to this library only.`,
					},
				]}
			/>
			{editing && <LibraryLimitsDialog library={current} onClose={() => setEditing(false)} />}
		</Panel>
	);
}
