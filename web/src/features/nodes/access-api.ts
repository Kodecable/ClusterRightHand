import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import type { AccessTargetType, GranteeType, NodeAccessGrant, NodeAccessGrantFilter } from "@/lib/api/types";

export const accessGrantKeys = {
	all: ["node-access-grants"] as const,
	list: (filter: NodeAccessGrantFilter = {}) =>
		[
			"node-access-grants",
			"list",
			filter.targetType ?? "",
			filter.targetId ?? "",
			filter.granteeType ?? "",
			filter.granteeId ?? "",
		] as const,
};

/**
 * Node access grants (D108, doc/access-control.md#归属访问授权与分享). The endpoints are administrator-only, so
 * every caller passes `enabled` from the signed-in user's kind. There is one access level; a grantee reaches a
 * node directly or every current member of a node group.
 */
export function useNodeAccessGrants(filter: NodeAccessGrantFilter = {}, enabled = true) {
	return useQuery({
		queryKey: accessGrantKeys.list(filter),
		enabled,
		queryFn: ({ signal }) =>
			http
				.get<{ grants: NodeAccessGrant[] }>(`/node-access-grants${queryString({ ...filter })}`, { signal })
				.then((r) => r.grants),
	});
}

export interface CreateAccessGrantInput {
	granteeType: GranteeType;
	granteeId: string;
	targetType: AccessTargetType;
	targetId: string;
}

export function useCreateNodeAccessGrant() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateAccessGrantInput) =>
			http.post<{ grant: NodeAccessGrant }>("/node-access-grants", input).then((r) => r.grant),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: accessGrantKeys.all }),
		// The dialog shows "already has access" and other failures inline.
		meta: { toast: false },
	});
}

export function useDeleteNodeAccessGrant() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/node-access-grants/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: accessGrantKeys.all }),
	});
}
