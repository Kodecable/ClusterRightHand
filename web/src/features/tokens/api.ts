import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePendingDecisions } from "@/features/approvals/api";
import { enc, http } from "@/lib/api/client";
import type { ApiTokenView, Preset, Rule } from "@/lib/api/types";

export const tokenKeys = {
	all: ["api-tokens"] as const,
	list: () => ["api-tokens", "list"] as const,
};

export function useApiTokens() {
	return useQuery({
		queryKey: tokenKeys.list(),
		queryFn: ({ signal }) => http.get<{ tokens: ApiTokenView[] }>("/api-tokens", { signal }).then((r) => r.tokens),
	});
}

export interface CreateTokenInput {
	name: string;
	preset: Preset;
	days: number | null;
}

export function useCreateApiToken() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateTokenInput) => http.post<{ token: string; apiToken: ApiTokenView }>("/api-tokens", input),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokenKeys.all }),
	});
}

export function useRevokeApiToken() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.post<{ apiToken: ApiTokenView }>(`/api-tokens/${enc(id)}/revoke`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: tokenKeys.all });
			// The server rejects what the token still had waiting for approval.
			invalidatePendingDecisions(queryClient);
		},
	});
}

export function useDeleteApiToken() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/api-tokens/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokenKeys.all }),
	});
}

export function useSetTokenRules() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, body }: { id: string; body: { preset?: Preset; rules?: Rule[] } }) =>
			http.put<{ apiToken: ApiTokenView }>(`/api-tokens/${enc(id)}/rules`, body).then((r) => r.apiToken),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: tokenKeys.all });
			// The server re-evaluates the tasks waiting on this token's rules.
			invalidatePendingDecisions(queryClient);
		},
	});
}
