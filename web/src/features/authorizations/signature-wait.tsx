import type { ReactNode } from "react";
import type { ApprovalItem } from "@/components/decision/types";
import { usePendingAuthorization, useRejectAuthorization, useSubmitAuthorization } from "./api";
import { SignatureDecision } from "./signature-decision";

/**
 * Wires a waiting task or task group to the shared signature decision: the
 * polled `GET .../authorization` query, the submit and reject mutations, and
 * the caller's own refresh after the wait ends.
 */
export function SignatureWait({
	kind,
	id,
	item,
	nodeNames,
	onChanged,
	details,
	count,
}: {
	kind: "task" | "task_group";
	id: string | undefined;
	item: ApprovalItem;
	nodeNames?: Map<string, string>;
	/** Extra refresh after a successful signature or a rejection (the caller's own query). */
	onChanged?: () => void;
	details?: ReactNode;
	count?: ReactNode;
}) {
	const pending = usePendingAuthorization(kind, id);
	const submit = useSubmitAuthorization();
	const reject = useRejectAuthorization();

	return (
		<SignatureDecision
			item={item}
			nodeNames={nodeNames}
			pending={pending.data?.pending ?? undefined}
			pendingError={pending.isError ? pending.error : undefined}
			details={details}
			count={count}
			onSubmit={(input) => submit.mutateAsync(input)}
			onChanged={() => {
				void pending.refetch();
				onChanged?.();
			}}
			onReject={(reason) => {
				if (id === undefined) return;
				reject.mutate(
					{ kind, id, reason },
					{
						onSuccess: () => {
							void pending.refetch();
							onChanged?.();
						},
					},
				);
			}}
			busy={submit.isPending}
			rejectBusy={reject.isPending}
			error={submit.error}
			rejectError={reject.error}
		/>
	);
}
