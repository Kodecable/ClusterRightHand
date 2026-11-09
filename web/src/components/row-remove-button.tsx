import { Trans } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The remove action of a detail-page list row (doc/webui.md "列表导航、链接与刷新"):
 * an outline xs button with the X icon and the visible "Remove" label. `label`
 * names what is removed for screen readers, since every row says "Remove".
 */
export function RowRemoveButton({
	label,
	onClick,
	disabled = false,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Button type="button" variant="outline" size="xs" aria-label={label} disabled={disabled} onClick={onClick}>
			<XIcon />
			<Trans>Remove</Trans>
		</Button>
	);
}
