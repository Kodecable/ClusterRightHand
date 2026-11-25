import type { PublicNode } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSetNodeUserRemark } from "./api";

/** The user remark's limit in Unicode code points, matching the server (doc/design/webui.md "Node pages"). */
export const NODE_USER_REMARK_MAX_CODE_POINTS = 50;

/** How long a failed save keeps its message inline before the editor just stays open. */
const ERROR_TIMEOUT_MS = 4_000;

/**
 * A node's user remark, the bottom row of a node card (doc/design/webui.md "Node pages"): one truncated
 * line whose title carries the whole text. Administrators edit it in place, in a single-line input of the
 * same size: Enter or blur saves a changed remark, Escape cancels, and a failed save keeps the input with
 * the message briefly inline. Everyone else reads it; an empty remark is not shown at all, and for an
 * administrator an empty remark is the click target with a muted placeholder.
 */
export function NodeUserRemark({ node, admin }: { node: PublicNode; admin: boolean }) {
	const { t } = useLingui();
	const setUserRemark = useSetNodeUserRemark();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(node.userRemark ?? "");
	const [error, setError] = useState<string | null>(null);

	// A message from a failed save is shown briefly; the editor stays open either way.
	useEffect(() => {
		if (error === null) return;
		const timer = setTimeout(() => setError(null), ERROR_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [error]);

	// The row is nothing at all when there is no remark and no way to write one.
	if (!admin && node.userRemark === null) return null;

	const startEditing = () => {
		setDraft(node.userRemark ?? "");
		setError(null);
		setEditing(true);
	};
	const cancel = () => {
		setDraft(node.userRemark ?? "");
		setError(null);
		setEditing(false);
	};
	const save = () => {
		if (setUserRemark.isPending) return;
		const trimmed = draft.trim();
		const next = trimmed === "" ? null : trimmed;
		if (next === node.userRemark) {
			setEditing(false);
			return;
		}
		setError(null);
		setUserRemark.mutate(
			{ id: node.id, userRemark: next },
			{
				onSuccess: () => setEditing(false),
				onError: (failure) => setError(failure.message),
			},
		);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: an administrator's user remark row is one editor surface; a click in it stays in it.
		// biome-ignore lint/a11y/useKeyWithClickEvents: the input and the edit button inside handle the keyboard; the row only keeps clicks from the card.
		<div
			className="border-t pt-2 text-xs"
			data-testid="node-user-remark"
			onClick={admin ? (event) => event.stopPropagation() : undefined}
		>
			{!admin && (
				<span className="block truncate leading-5 text-muted-foreground" title={node.userRemark ?? undefined}>
					{node.userRemark}
				</span>
			)}
			{admin && editing && (
				<div className="flex min-w-0 items-center gap-2">
					<Input
						type="text"
						autoFocus
						value={draft}
						aria-label={t`User remark`}
						aria-invalid={error !== null}
						aria-busy={setUserRemark.isPending}
						data-testid="node-user-remark-input"
						onChange={(event) => {
							const value = event.target.value;
							// Count Unicode code points, not UTF-16 units, so an emoji is one character.
							if ([...value].length > NODE_USER_REMARK_MAX_CODE_POINTS) return;
							setDraft(value);
							setError(null);
						}}
						onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
							// The card opens on Enter/Space; a key in the user remark stays in it.
							if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation();
								save();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								cancel();
							} else if (event.key === " ") {
								event.stopPropagation();
							}
						}}
						onClick={(event) => event.stopPropagation()}
						onBlur={save}
						className="h-5 w-full min-w-0 flex-1 rounded-sm border-0 bg-transparent px-0.5 text-xs focus-visible:ring-1 md:text-xs"
					/>
					{error !== null && (
						<span role="alert" className="max-w-1/2 shrink-0 truncate text-[11px] text-danger">
							{error}
						</span>
					)}
				</div>
			)}
			{admin && !editing && (
				<button
					type="button"
					onClick={startEditing}
					title={node.userRemark ?? undefined}
					className={cn(
						"block w-full cursor-text truncate rounded-sm text-left leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
						node.userRemark === null ? "text-muted-foreground/60" : "text-muted-foreground",
					)}
				>
					{node.userRemark ?? t`Click to edit remark`}
				</button>
			)}
		</div>
	);
}
