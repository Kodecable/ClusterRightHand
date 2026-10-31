import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";
import type { AvailableModel, ModelProviderInput, ModelProviderView } from "@/lib/api/types";

export const settingsKeys = {
	all: ["settings"] as const,
	models: () => ["settings", "models"] as const,
	providers: () => ["settings", "model-providers"] as const,
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
