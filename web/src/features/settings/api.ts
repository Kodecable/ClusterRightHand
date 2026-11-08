import type {
	AvailableModel,
	ModelPreset,
	ModelPresetInput,
	ModelPresetKind,
	ModelProviderInput,
	ModelProviderView,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";

export const settingsKeys = {
	all: ["settings"] as const,
	models: () => ["settings", "models"] as const,
	providers: () => ["settings", "model-providers"] as const,
	presets: () => ["settings", "model-presets"] as const,
};

export function useModels() {
	return useQuery({
		queryKey: settingsKeys.models(),
		queryFn: ({ signal }) => http.get<{ models: AvailableModel[] }>("/models", { signal }).then((r) => r.models),
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

/** The three model presets (D116): the model page's session, auto review and title cards. */
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
