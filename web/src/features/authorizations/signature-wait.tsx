import type { ApprovalRequest } from "@crh/api";
import type { ReactNode } from "react";
import type { DecisionVariant } from "@/components/decision/content";
import { SignaturePanel } from "@/components/decision/signature-panel";
import { usePendingAuthorization, useRejectAuthorization, useSubmitAuthorization } from "./api";

/**
 * Wires a waiting task or task group to the shared signature panel: the polled `GET .../authorization`
 * query, the submit and reject mutations, and the caller's own refresh after the wait ends. The request is
 * the server-built compact model, so the panel's summary is the same one the approval card renders.
 */
export function SignatureWait({
	request,
	variant = "inline",
	onChanged,
	details,
	count,
}: {
	request: ApprovalRequest;
	variant?: DecisionVariant;
	/** Extra refresh after a successful signature or a rejection, or when the server reports the wait ended. */
	onChanged?: () => void;
	details?: ReactNode;
	count?: ReactNode;
}) {
	// A request that waits for a signature is always a task or a task group.
	const kind = request.kind === "task_group" ? "task_group" : "task";
	const pending = usePendingAuthorization(kind, request.id);
	const submit = useSubmitAuthorization();
	const reject = useRejectAuthorization();

	// The server states the phase with the options, so the panel never has to guess from a missing view:
	// `preparing` still waits (Reject available), `waiting` offers the planned tabs, and `ended` means the
	// wait is over (signed, rejected, cancelled, expired, or settled elsewhere) for the panel to report
	// once before the caller's refresh unmounts it.
	return (
		<SignaturePanel
			request={request}
			variant={variant}
			phase={pending.data?.phase}
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
				reject.mutate(
					{ kind, id: request.id, reason },
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
