import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";
import type { CredentialView } from "@/lib/api/types";

export const credentialKeys = {
	all: ["credentials"] as const,
	list: () => ["credentials", "list"] as const,
};

export function useCredentials() {
	return useQuery({
		queryKey: credentialKeys.list(),
		queryFn: ({ signal }) =>
			http.get<{ credentials: CredentialView[] }>("/me/credentials", { signal }).then((r) => r.credentials),
	});
}

export function useAddSshCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ publicKey, name }: { publicKey: string; name?: string }) =>
			http.post<{ credential: CredentialView }>("/me/credentials/ssh", { publicKey, name }).then((r) => r.credential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
	});
}

export function useDeleteCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/me/credentials/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
	});
}

/** WebAuthn registration options; the challenge is remembered server-side and used once. */
export function usePasskeyOptions() {
	// The registration card reports every failure of the Passkey flow inline.
	return useMutation({
		mutationFn: () => http.post<{ options: Record<string, unknown> }>("/me/credentials/webauthn/options", {}),
		meta: { toast: false },
	});
}

export function useRegisterPasskey() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ response, name }: { response: unknown; name?: string }) =>
			http
				.post<{ credential: CredentialView }>("/me/credentials/webauthn", { response, name })
				.then((r) => r.credential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
		// The registration card reports every failure of the Passkey flow inline.
		meta: { toast: false },
	});
}
