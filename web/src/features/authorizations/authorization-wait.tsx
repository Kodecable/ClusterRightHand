import type { ReactNode } from "react";
import { AuthorizationCard } from "@/components/authorization-card";
import { usePendingAuthorization, useSubmitAuthorization } from "./api";

/**
 * Wires a waiting task or task group to the shared authorization card: the
 * polled `GET .../authorization` query, the submit mutation and the refresh
 * after a signature. The caller keeps what only it knows — the message shown
 * while the payload is prepared and the queries to refresh afterwards.
 */
export function AuthorizationWait({
	kind,
	id,
	onChanged,
	waiting,
}: {
	kind: "task" | "task_group";
	id: string | undefined;
	/** Extra refresh after a successful signature (the caller's own query). */
	onChanged?: () => void;
	/** Shown until the payload arrives; `loading` means the request is still out. */
	waiting: ReactNode | ((state: "loading" | "waiting") => ReactNode);
}) {
	const pending = usePendingAuthorization(kind, id);
	const submit = useSubmitAuthorization();

	if (pending.data === undefined || pending.data.pending === null) {
		const state = pending.data === undefined ? "loading" : "waiting";
		return <>{typeof waiting === "function" ? waiting(state) : waiting}</>;
	}

	return (
		<AuthorizationCard
			pending={pending.data.pending}
			tasks={pending.data.tasks}
			kind={kind}
			onSubmit={(input) => submit.mutateAsync(input)}
			onChanged={() => {
				void pending.refetch();
				onChanged?.();
			}}
			busy={submit.isPending}
			error={submit.error}
		/>
	);
}
