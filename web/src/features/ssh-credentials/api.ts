import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";
import type { SshCredential } from "@/lib/api/types";

export const sshCredentialKeys = {
	all: ["ssh-credentials"] as const,
	list: () => ["ssh-credentials", "list"] as const,
};

/** The organization's SSH credentials and the nodes that use them (administrators only). */
export function useSshCredentials() {
	return useQuery({
		queryKey: sshCredentialKeys.list(),
		queryFn: ({ signal }) =>
			http.get<{ credentials: SshCredential[] }>("/ssh-credentials", { signal }).then((r) => r.credentials),
	});
}

export function useCreateSshCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) =>
			http.post<{ credential: SshCredential }>("/ssh-credentials", { name }).then((r) => r.credential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: sshCredentialKeys.all }),
	});
}

export function useDeleteSshCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/ssh-credentials/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: sshCredentialKeys.all }),
	});
}
