import type {
	ApprovalBody,
	PtyAuthorizationResponse,
	PtyCreateBody,
	PtyListResponse,
	PtySize,
	PtyView,
} from "@crh/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";

export const terminalKeys = {
	all: ["terminals"] as const,
	enabled: () => ["terminals", "enabled"] as const,
	list: () => ["terminals", "list"] as const,
	detail: (id: string) => ["terminals", "detail", id] as const,
	authorization: (id: string) => ["terminals", "authorization", id] as const,
};

/** Whether the terminal subsystem is on; the sidebar hides its entry while it is off. */
export function usePtyEnabled() {
	return useQuery({
		queryKey: terminalKeys.enabled(),
		queryFn: ({ signal }) => http.get<{ enabled: boolean }>("/ptys/enabled", { signal }).then((r) => r.enabled),
	});
}

/** Every terminal the caller may see (all of them for an administrator) and the subsystem's state. */
export function useTerminals() {
	return useQuery({
		queryKey: terminalKeys.list(),
		queryFn: ({ signal }) => http.get<PtyListResponse>("/ptys", { signal }),
		// A terminal changes state and viewers without a mutation from this tab.
		refetchInterval: 10_000,
	});
}

/**
 * One terminal, polled while it is opening or running: an agent's approval appears without a local
 * mutation, and a signature wait ends from another tab. An exited terminal keeps its view until the
 * retention sweep removes it, so it is polled slowly to turn that 404 into the page's gone state.
 */
export function useTerminal(id: string | undefined) {
	return useQuery({
		queryKey: terminalKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ terminal: PtyView }>(`/ptys/${enc(id ?? "")}`, { signal }).then((r) => r.terminal),
		refetchInterval: (query) => (query.state.data?.state === "exited" ? 30_000 : 5_000),
	});
}

/** The planned options of a privileged terminal's signature wait; polled while the panel is open. */
export function useTerminalAuthorization(id: string, enabled: boolean) {
	return useQuery({
		queryKey: terminalKeys.authorization(id),
		enabled,
		refetchInterval: 5_000,
		queryFn: ({ signal }) => http.get<PtyAuthorizationResponse>(`/ptys/${enc(id)}/authorization`, { signal }),
	});
}

/** Refreshes one terminal and every list that shows it. */
export function invalidateTerminal(queryClient: QueryClient, id: string): void {
	void queryClient.invalidateQueries({ queryKey: terminalKeys.detail(id) });
	void queryClient.invalidateQueries({ queryKey: terminalKeys.all });
}

export function useCreateTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		// The dialog shows the refusal beside its fields.
		meta: { toast: false },
		mutationFn: (input: PtyCreateBody) => http.post<{ terminal: PtyView }>("/ptys", input).then((r) => r.terminal),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: terminalKeys.all }),
	});
}

export interface ResizeTerminalInput {
	id: string;
	size: PtySize;
}

export function useResizeTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		// The Fit button shows the failure beside itself.
		meta: { toast: false },
		mutationFn: ({ id, size }: ResizeTerminalInput) =>
			http.post<{ terminal: PtyView }>(`/ptys/${enc(id)}/resize`, size).then((r) => r.terminal),
		onSuccess: (terminal) => void queryClient.invalidateQueries({ queryKey: terminalKeys.detail(terminal.id) }),
	});
}

export function useCloseTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/ptys/${enc(id)}`),
		onSuccess: (_result, id) => {
			queryClient.removeQueries({ queryKey: terminalKeys.detail(id) });
			void queryClient.invalidateQueries({ queryKey: terminalKeys.all });
		},
	});
}

export interface AssociationInput {
	id: string;
	sessionId: string;
}

export function useAssociateSession() {
	const queryClient = useQueryClient();
	return useMutation({
		meta: { toast: false },
		mutationFn: ({ id, sessionId }: AssociationInput) =>
			http.put<{ ok: true }>(`/ptys/${enc(id)}/sessions/${enc(sessionId)}`),
		onSuccess: (_result, { id }) => invalidateTerminal(queryClient, id),
	});
}

export function useUnassociateSession() {
	const queryClient = useQueryClient();
	return useMutation({
		meta: { toast: false },
		mutationFn: ({ id, sessionId }: AssociationInput) =>
			http.del<{ ok: true }>(`/ptys/${enc(id)}/sessions/${enc(sessionId)}`),
		onSuccess: (_result, { id }) => invalidateTerminal(queryClient, id),
	});
}

export function useRejectTerminalAuthorization(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		// SignaturePanel renders the failure in its Reject tab.
		meta: { toast: false },
		mutationFn: (reason: string) =>
			http.post<{ ok: true }>(`/ptys/${enc(id)}/authorization/reject`, reason === "" ? {} : { reason }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: terminalKeys.authorization(id) });
			void queryClient.invalidateQueries({ queryKey: terminalKeys.detail(id) });
		},
	});
}

export interface DecideTerminalApprovalInput {
	id: string;
	body: ApprovalBody;
}

/**
 * The rule approval's decision through the same body every approval takes: approve or reject with a
 * reason, and "always allow" with a server-built candidate (doc/design/access-control.md "Approvals").
 */
export function useDecideTerminalApproval() {
	const queryClient = useQueryClient();
	return useMutation({
		// ApprovalPanel renders the failure beside its tabs.
		meta: { toast: false },
		mutationFn: ({ id, body }: DecideTerminalApprovalInput) =>
			http.post<{ ok: true }>(`/ptys/${enc(id)}/approval`, body),
		onSuccess: (_result, { id }) => invalidateTerminal(queryClient, id),
	});
}
