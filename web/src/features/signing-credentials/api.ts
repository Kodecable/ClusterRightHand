import type { SigningCredentialView } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";

export const signingCredentialKeys = {
	all: ["signing-credentials"] as const,
	list: () => ["signing-credentials", "list"] as const,
};

export function useSigningCredentials() {
	return useQuery({
		queryKey: signingCredentialKeys.list(),
		queryFn: ({ signal }) =>
			http
				.get<{ signingCredentials: SigningCredentialView[] }>("/me/signing-credentials", { signal })
				.then((r) => r.signingCredentials),
	});
}

export function useAddSshSigningCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ publicKey, name }: { publicKey: string; name?: string }) =>
			http
				.post<{ signingCredential: SigningCredentialView }>("/me/signing-credentials/ssh", { publicKey, name })
				.then((r) => r.signingCredential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: signingCredentialKeys.all }),
	});
}

export function useDeleteSigningCredential() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/me/signing-credentials/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: signingCredentialKeys.all }),
	});
}

/** WebAuthn registration options; the challenge is remembered server-side and used once. */
export function usePasskeyOptions() {
	// The registration card reports every failure of the Passkey flow inline.
	return useMutation({
		mutationFn: () => http.post<{ options: Record<string, unknown> }>("/me/signing-credentials/webauthn/options", {}),
		meta: { toast: false },
	});
}

export function useRegisterPasskey() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ response, name }: { response: unknown; name?: string }) =>
			http
				.post<{ signingCredential: SigningCredentialView }>("/me/signing-credentials/webauthn", { response, name })
				.then((r) => r.signingCredential),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: signingCredentialKeys.all }),
		// The registration card reports every failure of the Passkey flow inline.
		meta: { toast: false },
	});
}
