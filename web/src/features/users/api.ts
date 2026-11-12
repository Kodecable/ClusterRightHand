import type { Directory, User, UserDetail, UserGroup, UserGroupDetail, UserKind } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";
import { authStore } from "@/lib/session";

export const userKeys = {
	all: ["users"] as const,
	list: () => ["users", "list"] as const,
	userGroups: () => ["users", "user-groups"] as const,
	userGroup: (id: string) => ["users", "user-groups", id] as const,
	detail: (id: string) => ["users", "detail", id] as const,
	directory: () => ["users", "directory"] as const,
};

export function useUsers() {
	return useQuery({
		queryKey: userKeys.list(),
		queryFn: ({ signal }) => http.get<{ users: User[] }>("/users", { signal }).then((r) => r.users),
	});
}

/** One user with the user groups it belongs to; non-admins may only read their own id. */
export function useUser(id: string) {
	return useQuery({
		queryKey: userKeys.detail(id),
		enabled: id !== "",
		queryFn: ({ signal }) => http.get<UserDetail>(`/users/${enc(id)}`, { signal }),
	});
}

/** The user groups; administrators only, so a member's own page passes `enabled: false`. */
export function useUserGroups({ enabled = true }: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: userKeys.userGroups(),
		enabled,
		queryFn: ({ signal }) => http.get<{ groups: UserGroup[] }>("/user-groups", { signal }).then((r) => r.groups),
	});
}

/** One user group and its members (administrators only). */
export function useUserGroup(id: string) {
	return useQuery({
		queryKey: userKeys.userGroup(id),
		enabled: id !== "",
		queryFn: ({ signal }) =>
			http.get<{ group: UserGroupDetail }>(`/user-groups/${enc(id)}`, { signal }).then((r) => r.group),
	});
}

export function useDirectory() {
	return useQuery({
		queryKey: userKeys.directory(),
		queryFn: ({ signal }) => http.get<Directory>("/directory", { signal }),
	});
}

export function useCreateUser() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { username: string; displayName?: string; kind: UserKind; password?: string }) =>
			http.post<{ user: User }>("/users", input).then((r) => r.user),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useUpdateUser() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			patch,
		}: {
			id: string;
			patch: { kind?: UserKind; status?: "active" | "disabled"; displayName?: string };
		}) => http.patch<{ user: User }>(`/users/${enc(id)}`, patch).then((r) => r.user),
		onSuccess: (user) => {
			void queryClient.invalidateQueries({ queryKey: userKeys.all });
			// The update may be the signed-in user's own row.
			authStore.updateUser(user);
		},
	});
}

export function useSetUserPassword() {
	return useMutation({
		mutationFn: ({
			id,
			password,
			revokeApiTokens,
		}: {
			id: string;
			password: string;
			/** End every API token of the target user as well (the server defaults to false). */
			revokeApiTokens?: boolean;
		}) => http.post<{ ok: true }>(`/users/${enc(id)}/password`, { password, revokeApiTokens }),
	});
}

export function useCreateUserGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.post<{ group: UserGroup }>("/user-groups", { name }).then((r) => r.group),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useRenameUserGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			http.patch<{ group: UserGroup }>(`/user-groups/${enc(id)}`, { name }).then((r) => r.group),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useDeleteUserGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/user-groups/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useAddUserGroupMember() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
			http.put<{ ok: true }>(`/user-groups/${enc(groupId)}/members/${enc(userId)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useRemoveUserGroupMember() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
			http.del<{ ok: true }>(`/user-groups/${enc(groupId)}/members/${enc(userId)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}
