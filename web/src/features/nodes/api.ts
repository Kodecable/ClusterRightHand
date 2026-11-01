import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";
import type {
	CrhsKey,
	NodeShare,
	NodeTrust,
	PublicNode,
	SshCredential,
	SshNodeDetails,
	SshTargetBody,
	TaskView,
} from "@/lib/api/types";

export const nodeKeys = {
	all: ["nodes"] as const,
	list: () => ["nodes", "list"] as const,
	detail: (id: string) => ["nodes", "detail", id] as const,
	trust: (id: string) => ["nodes", "trust", id] as const,
	tasks: (id: string) => ["nodes", "tasks", id] as const,
	sshCredentials: () => ["nodes", "ssh-credentials"] as const,
	crhsKey: () => ["nodes", "crhs-key"] as const,
};

export function useNodes() {
	// Pending enrolments and online/offline changes show up without a refresh.
	return useQuery({
		queryKey: nodeKeys.list(),
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
		refetchInterval: 5_000,
	});
}

export function useNode(id: string | undefined) {
	return useQuery({
		queryKey: nodeKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ node: PublicNode; shares?: NodeShare[]; ssh?: SshNodeDetails | null }>(`/nodes/${enc(id ?? "")}`, {
				signal,
			}),
	});
}

export function useNodeTrust(id: string | undefined) {
	return useQuery({
		queryKey: nodeKeys.trust(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ trust: NodeTrust }>(`/nodes/${enc(id ?? "")}/trust`, { signal }).then((r) => r.trust),
	});
}

export function useNodeTasks(id: string | undefined) {
	return useQuery({
		queryKey: nodeKeys.tasks(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ tasks: TaskView[] }>(`/nodes/${enc(id ?? "")}/tasks`, { signal }).then((r) => r.tasks),
	});
}

export function useCrhsKey() {
	return useQuery({
		queryKey: nodeKeys.crhsKey(),
		queryFn: ({ signal }) => http.get<{ key: CrhsKey }>("/privilege/crhs-key", { signal }).then((r) => r.key),
	});
}

export function useApproveNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.post<{ node: PublicNode }>(`/nodes/${enc(id)}/approve`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

export function useDeleteNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/nodes/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

export function useRenameNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			http.patch<{ node: PublicNode }>(`/nodes/${enc(id)}`, { name }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

export function useShareNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			granteeType,
			granteeId,
			access,
		}: {
			id: string;
			granteeType: string;
			granteeId: string;
			access: "view" | "operate";
		}) => http.put<{ share: NodeShare }>(`/nodes/${enc(id)}/shares`, { granteeType, granteeId, access }),
		onSuccess: (_data, { id }) => void queryClient.invalidateQueries({ queryKey: nodeKeys.detail(id) }),
	});
}

export function useUnshareNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, shareId }: { id: string; shareId: string }) =>
			http.del<{ ok: true }>(`/nodes/${enc(id)}/shares/${enc(shareId)}`),
		onSuccess: (_data, { id }) => void queryClient.invalidateQueries({ queryKey: nodeKeys.detail(id) }),
	});
}

export function useEnrollmentToken() {
	// The add-node dialog renders the failure in the dialog.
	return useMutation({
		mutationFn: (nameHint?: string) =>
			http.post<{ token: string; expiresAt: string }>("/enrollment-tokens", nameHint ? { nameHint } : {}),
		meta: { toast: false },
	});
}

export function useSshCredentials() {
	return useQuery({
		queryKey: nodeKeys.sshCredentials(),
		queryFn: ({ signal }) =>
			http.get<{ credentials: SshCredential[] }>("/ssh-credentials", { signal }).then((r) => r.credentials),
	});
}

export function useCreateSshCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) =>
			http.post<{ credential: SshCredential }>("/ssh-credentials", { name }).then((r) => r.credential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.sshCredentials() }),
	});
}

/** Probes the route's next unpinned hop and returns the fingerprint the wizard shows for confirmation. */
export function useProbeSshHost() {
	return useMutation({
		mutationFn: (body: SshTargetBody) => http.post<{ hop: number; fingerprint: string }>("/ssh-nodes/probe", body),
	});
}

/** Creates an SSH node from the wizard's route (jump hosts first, the target last). */
export function useCreateSshNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: SshTargetBody & { name: string; groups: string[] }) =>
			http.post<{ node: PublicNode }>("/ssh-nodes", body).then((r) => r.node),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

/** Tries the whole route before the node is created (the wizard's last step). */
export function useTestSshRoute() {
	// The TestConnection button reports success and failure inline.
	return useMutation({
		mutationFn: (body: SshTargetBody) => http.post<{ ok: true }>("/ssh-nodes/test", body),
		meta: { toast: false },
	});
}

/** Tries an existing SSH node's route and credential. */
export function useTestSshNode() {
	// The TestConnection button reports success and failure inline.
	return useMutation({
		mutationFn: (id: string) => http.post<{ ok: true }>(`/nodes/${enc(id)}/ssh-test`),
		meta: { toast: false },
	});
}

/** Replaces an SSH node's access groups. */
export function useSetNodeGroups() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, groups }: { id: string; groups: string[] }) =>
			http.put<{ groups: string[] }>(`/nodes/${enc(id)}/groups`, { groups }).then((r) => r.groups),
		onSuccess: (_groups, { id }) => void queryClient.invalidateQueries({ queryKey: nodeKeys.detail(id) }),
	});
}
