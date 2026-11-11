import type {
	SigningKeyCreateResponse,
	SigningKeyDeleteConflict,
	SigningKeyListResponse,
	SystemSettings,
	SystemSettingsPatch,
	SystemSettingsResponse,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nodeKeys } from "@/features/nodes/api";
import { ApiError, enc, http } from "@/lib/api/client";

export const systemSettingsKeys = {
	all: ["system-settings"] as const,
	settings: () => ["system-settings", "settings"] as const,
	signingKeys: () => ["system-settings", "signing-keys"] as const,
};

/** The runtime settings and the defaults a value falls back to. */
export function useSystemSettings() {
	return useQuery({
		queryKey: systemSettingsKeys.settings(),
		queryFn: ({ signal }) => http.get<SystemSettingsResponse>("/settings", { signal }),
	});
}

/** Saves one section's values; the server keeps the omitted groups as they are. */
export function useSaveSystemSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		// Settings forms show the failure inline, beside the fields.
		meta: { toast: false },
		mutationFn: (patch: SystemSettingsPatch) =>
			http.patch<{ settings: SystemSettings }>("/settings", patch).then((r) => r.settings),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: systemSettingsKeys.all }),
	});
}

/** crhs's authorization signing keys, newest first. */
export function useSigningKeys() {
	return useQuery({
		queryKey: systemSettingsKeys.signingKeys(),
		queryFn: ({ signal }) =>
			http.get<SigningKeyListResponse>("/privilege/signing-keys", { signal }).then((r) => r.keys),
	});
}

export function useCreateSigningKey() {
	const queryClient = useQueryClient();
	return useMutation({
		meta: { toast: false },
		mutationFn: (input: { name?: string }) =>
			http.post<SigningKeyCreateResponse>("/privilege/signing-keys", input).then((r) => r.key),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: systemSettingsKeys.all });
			// The node page shows the newest key; a rotation must update that panel too.
			void queryClient.invalidateQueries({ queryKey: nodeKeys.crhsKey() });
		},
	});
}

export function useDeleteSigningKey() {
	const queryClient = useQueryClient();
	return useMutation({
		// The delete dialog shows the failure, or the nodes that still trust the key.
		meta: { toast: false },
		mutationFn: ({ id, force = false }: { id: string; force?: boolean }) =>
			http.del<{ ok: true }>(`/privilege/signing-keys/${enc(id)}`, force ? { force: true } : undefined),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: systemSettingsKeys.all });
			// The node page shows the newest key; deleting one must update that panel too.
			void queryClient.invalidateQueries({ queryKey: nodeKeys.crhsKey() });
		},
	});
}

/**
 * The per-field messages of a `PATCH /api/settings` validation failure. The server
 * keys them by API field path (`clockWarn`, `retention.tasks`, `webauthn.origins`).
 */
export function settingsFieldErrors(error: unknown): Record<string, string> {
	if (!(error instanceof ApiError) || error.status !== 400) return {};
	const fields = error.details?.fields;
	if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return {};
	return Object.fromEntries(
		Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

/** The nodes a 409 delete response names as still trusting the key. */
export function signingKeyDeleteConflict(error: unknown): SigningKeyDeleteConflict | null {
	if (!(error instanceof ApiError) || error.status !== 409) return null;
	const nodes = error.details?.nodes;
	if (!Array.isArray(nodes)) return null;
	return { error: error.message, nodes: nodes as SigningKeyDeleteConflict["nodes"] };
}
