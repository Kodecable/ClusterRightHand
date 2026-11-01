import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authStore } from "@/features/auth/session";
import { enc, http } from "@/lib/api/client";
import type { Directory, User, UserGroup, UserKind } from "@/lib/api/types";

export const userKeys = {
	all: ["users"] as const,
	list: () => ["users", "list"] as const,
	groups: () => ["users", "groups"] as const,
	directory: () => ["users", "directory"] as const,
};

export function useUsers() {
	return useQuery({
		queryKey: userKeys.list(),
		queryFn: ({ signal }) => http.get<{ users: User[] }>("/users", { signal }).then((r) => r.users),
	});
}

export function useUserGroups() {
	return useQuery({
		queryKey: userKeys.groups(),
		queryFn: ({ signal }) => http.get<{ groups: UserGroup[] }>("/user-groups", { signal }).then((r) => r.groups),
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
		mutationFn: ({ id, password }: { id: string; password: string }) =>
			http.post<{ ok: true }>(`/users/${enc(id)}/password`, { password }),
	});
}

export function useCreateGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.post<{ group: UserGroup }>("/user-groups", { name }).then((r) => r.group),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useDeleteGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/user-groups/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useAddGroupMember() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
			http.put<{ ok: true }>(`/user-groups/${enc(groupId)}/members/${enc(userId)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}

export function useRemoveGroupMember() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
			http.del<{ ok: true }>(`/user-groups/${enc(groupId)}/members/${enc(userId)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: userKeys.all }),
	});
}
