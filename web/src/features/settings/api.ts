import type {
	AvailableModel,
	McpServerInput,
	McpServerStatus,
	McpServerView,
	McpToolView,
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

export const mcpServerKeys = {
	all: ["settings", "mcp-servers"] as const,
	tools: (name: string) => ["settings", "mcp-servers", name, "tools"] as const,
};

/** The administrator's MCP servers (doc/design/extensions.md "MCP servers"). */
export function useMcpServers() {
	return useQuery({
		queryKey: mcpServerKeys.all,
		queryFn: ({ signal }) => http.get<{ servers: McpServerView[] }>("/mcp-servers", { signal }),
		// A connection changes state (and the next backoff attempt) in the background; the list stays current.
		refetchInterval: 5_000,
	});
}

export function useSaveMcpServer() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ name, body }: { name: string; body: McpServerInput }) =>
			http.put<{ server: McpServerView }>(`/mcp-servers/${enc(name)}`, body).then((r) => r.server),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: mcpServerKeys.all }),
	});
}

export function useDeleteMcpServer() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.del<{ ok: true }>(`/mcp-servers/${enc(name)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: mcpServerKeys.all }),
	});
}

export function useReconnectMcpServer() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) =>
			http.post<{ status: McpServerStatus }>(`/mcp-servers/${enc(name)}/reconnect`).then((r) => r.status),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: mcpServerKeys.all }),
	});
}

export function useMcpServerTools(name: string | undefined) {
	return useQuery({
		queryKey: mcpServerKeys.tools(name ?? ""),
		enabled: name !== undefined && name !== "",
		retry: false,
		queryFn: ({ signal }) =>
			http.get<{ tools: McpToolView[]; status: McpServerStatus }>(`/mcp-servers/${enc(name ?? "")}/tools`, { signal }),
	});
}
