import type {
	ExtensionInput,
	ExtensionStatus,
	ExtensionToolView,
	ExtensionView,
	ModelPreset,
	ModelPresetInput,
	ModelPresetKind,
	ModelProviderInput,
	ModelProviderView,
	ModelsResponse,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";

export const settingsKeys = {
	all: ["settings"] as const,
	models: () => ["settings", "models"] as const,
	providers: () => ["settings", "model-providers"] as const,
	presets: () => ["settings", "model-presets"] as const,
};

/** The offered models; the session model preset is read separately with `useSessionModelPreset`. */
export function useModels() {
	return useQuery({
		queryKey: settingsKeys.models(),
		queryFn: ({ signal }) => http.get<ModelsResponse>("/models", { signal }),
		select: (data) => data.models,
		staleTime: 5 * 60_000,
	});
}

/** The session model preset's model, if an administrator ever sets one; it is the second new-session default. */
export function useSessionModelPreset() {
	return useQuery({
		queryKey: settingsKeys.models(),
		queryFn: ({ signal }) => http.get<ModelsResponse>("/models", { signal }),
		select: (data) => data.sessionModel ?? null,
		staleTime: 5 * 60_000,
	});
}

export function useModelProviders() {
	return useQuery({
		queryKey: settingsKeys.providers(),
		queryFn: ({ signal }) =>
			http.get<{ providers: ModelProviderView[]; builtin: string[] }>("/model-providers", { signal }),
	});
}

export function useSaveModelProvider() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ providerId, body }: { providerId: string; body: ModelProviderInput }) =>
			http.put<{ provider: ModelProviderView }>(`/model-providers/${enc(providerId)}`, body).then((r) => r.provider),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
	});
}

export function useDeleteModelProvider() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (providerId: string) => http.del<{ ok: true }>(`/model-providers/${enc(providerId)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
	});
}

/** The three model presets: the model page's session, auto review and title cards. */
export function useModelPresets() {
	return useQuery({
		queryKey: settingsKeys.presets(),
		queryFn: ({ signal }) => http.get<{ presets: ModelPreset[] }>("/model-presets", { signal }).then((r) => r.presets),
	});
}

/** Saves one preset; omitted fields stay unchanged, and a whitespace prompt clears it. */
export function useSaveModelPreset() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ kind, input }: { kind: ModelPresetKind; input: ModelPresetInput }) =>
			http.put<{ preset: ModelPreset }>(`/model-presets/${kind}`, input).then((r) => r.preset),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsKeys.presets() }),
	});
}

export const extensionKeys = {
	all: ["settings", "extensions"] as const,
	tools: (name: string) => ["settings", "extensions", name, "tools"] as const,
};

/** The administrator's extensions (doc/design/extensions.md "Extensions"). */
export function useExtensions() {
	return useQuery({
		queryKey: extensionKeys.all,
		queryFn: ({ signal }) => http.get<{ extensions: ExtensionView[] }>("/extensions", { signal }),
		// An MCP connection changes state (and the next backoff attempt) in the background; the list stays current.
		refetchInterval: 5_000,
	});
}

export function useSaveExtension() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ name, body }: { name: string; body: ExtensionInput }) =>
			http.put<{ extension: ExtensionView }>(`/extensions/${enc(name)}`, body).then((r) => r.extension),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: extensionKeys.all }),
	});
}

export function useDeleteExtension() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.del<{ ok: true }>(`/extensions/${enc(name)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: extensionKeys.all }),
	});
}

export function useReconnectExtension() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) =>
			http.post<{ status: ExtensionStatus }>(`/extensions/${enc(name)}/reconnect`).then((r) => r.status),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: extensionKeys.all }),
	});
}

export function useExtensionTools(name: string | undefined) {
	return useQuery({
		queryKey: extensionKeys.tools(name ?? ""),
		enabled: name !== undefined && name !== "",
		retry: false,
		queryFn: ({ signal }) =>
			http.get<{ tools: ExtensionToolView[]; status: ExtensionStatus }>(`/extensions/${enc(name ?? "")}/tools`, {
				signal,
			}),
	});
}
