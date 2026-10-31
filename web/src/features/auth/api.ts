import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import { http } from "@/lib/api/client";
import type { User } from "@/lib/api/types";
import { authStore } from "./session";

export function useLogin(): UseMutationResult<User, Error, { username: string; password: string }> {
	return useMutation({
		mutationFn: ({ username, password }) => authStore.login(username, password),
	});
}

export function useLogout(): UseMutationResult<void, Error, void> {
	return useMutation({ mutationFn: () => authStore.logout() });
}

export interface ChangePasswordInput {
	currentPassword: string;
	newPassword: string;
}

export function useChangePassword(): UseMutationResult<void, Error, ChangePasswordInput> {
	return useMutation({
		mutationFn: (input) => http.post<{ ok: true }>("/auth/password", input).then(() => undefined),
	});
}

/** The route director uses this to send `user.kind` checks through one place. */
export function isAdmin(user: User | null): boolean {
	return user?.kind === "admin";
}
