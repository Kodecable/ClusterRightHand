import type { NodeGroup } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nodeKeys } from "@/features/nodes/api";
import { enc, http } from "@/lib/api/client";
import { nodeGroupKeys } from "./keys";

/**
 * Node groups (D108, D109): every signed-in user may list them; creating,
 * renaming, deleting and changing members are administrator actions. The
 * server filters `memberIds` to the nodes a non-admin can see.
 */

/** Every node list and detail view carries the node's node groups by name. */
function invalidateNodeViews(queryClient: ReturnType<typeof useQueryClient>): void {
	void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
}

export function useNodeGroups() {
	return useQuery({
		queryKey: nodeGroupKeys.list(),
		queryFn: ({ signal }) => http.get<{ groups: NodeGroup[] }>("/node-groups", { signal }).then((r) => r.groups),
	});
}

export function useCreateNodeGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.post<{ group: NodeGroup }>("/node-groups", { name }).then((r) => r.group),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
			invalidateNodeViews(queryClient);
		},
	});
}

export function useRenameNodeGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			http.patch<{ group: NodeGroup }>(`/node-groups/${enc(id)}`, { name }).then((r) => r.group),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
			invalidateNodeViews(queryClient);
			// Task groups and token rules display references by their current name.
			void queryClient.invalidateQueries({ queryKey: ["tasks"] });
			void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});
}

export function useDeleteNodeGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/node-groups/${enc(id)}`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
			invalidateNodeViews(queryClient);
			// Rules and task groups may reference the deleted group; their refs now say so.
			void queryClient.invalidateQueries({ queryKey: ["tasks"] });
			void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});
}

export function useSetNodeGroupMembers() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, nodeIds }: { id: string; nodeIds: string[] }) =>
			http.put<{ group: NodeGroup }>(`/node-groups/${enc(id)}/members`, { nodeIds }).then((r) => r.group),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
			invalidateNodeViews(queryClient);
		},
	});
}
