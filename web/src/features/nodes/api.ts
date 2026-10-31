import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import type {
	CrhsKey,
	NodeShare,
	NodeTrust,
	PublicNode,
	SshCredential,
	SshNodeDetails,
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
	return useQuery({
		queryKey: nodeKeys.list(),
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
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
	return useMutation({
		mutationFn: (nameHint?: string) =>
			http.post<{ token: string; expiresAt: string }>("/enrollment-tokens", nameHint ? { nameHint } : {}),
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

/** Node task list: the endpoint is not cursor-paged (only the lists named in doc/webui.md are). */
export function nodeTaskListPath(id: string, limit?: number): string {
	return `/nodes/${enc(id)}/tasks${queryString({ limit })}`;
}
