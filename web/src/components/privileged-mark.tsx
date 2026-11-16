import { Trans } from "@lingui/react/macro";

/**
 * The one "Privileged" mark (doc/design/webui.md "Shared components"): a warning-coloured pill beside a
 * task's, task group's or decision's title and in its facts. It is deliberately smaller than the title
 * it marks.
 */
export function PrivilegedMark() {
	return (
		<span
			data-slot="privileged-mark"
			className="inline-flex shrink-0 items-center rounded-full bg-warn-bg px-2 py-0.5 text-xs leading-none font-medium text-warn"
		>
			<Trans>Privileged</Trans>
		</span>
	);
}
