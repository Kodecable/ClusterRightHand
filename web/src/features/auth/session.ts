import { useSyncExternalStore } from "react";
import { http, setUnauthorizedHandler } from "@/lib/api/client";
import type { User } from "@/lib/api/types";
import type { LoginCaptcha } from "./captcha";

export type AuthStatus = "unknown" | "authenticated" | "anonymous";

export interface AuthState {
	status: AuthStatus;
	user: User | null;
}

const ANONYMOUS: AuthState = { status: "anonymous", user: null };

/**
 * The signed-in user, outside React: the router guard runs in `beforeLoad`,
 * where hooks are not available, and the API client's 401 handler needs a way
 * to clear the session. Components subscribe with `useAuth()`.
 */
export class AuthStore {
	private current: AuthState = { status: "unknown", user: null };
	private readonly listeners = new Set<() => void>();

	get state(): AuthState {
		return this.current;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): AuthState => this.current;

	private set(next: AuthState): void {
		this.current = next;
		for (const listener of this.listeners) listener();
	}

	/** Restore the session at boot; a missing/expired session is not an error. */
	async load(): Promise<AuthState> {
		try {
			const { user } = await http.get<{ user: User }>("/me");
			this.set({ status: "authenticated", user });
		} catch {
			this.set(ANONYMOUS);
		}
		return this.current;
	}

	async login(username: string, password: string, cap?: LoginCaptcha): Promise<User> {
		const body = cap === undefined ? { username, password } : { username, password, cap };
		const { user } = await http.post<{ user: User }>("/auth/login", body, { skipUnauthorized: true });
		this.set({ status: "authenticated", user });
		return user;
	}

	/**
	 * The server's copy of the signed-in user after a profile change. The store
	 * is loaded once at boot, so the user menu and the self-change guards read
	 * this updated copy instead of the row from that first load.
	 */
	updateUser(user: User): void {
		if (this.current.user?.id !== user.id) return;
		this.set({ status: "authenticated", user });
	}

	async logout(): Promise<void> {
		try {
			await http.post<{ ok: true }>("/auth/logout");
		} finally {
			this.set(ANONYMOUS);
		}
	}

	/** Called by the API client on a 401: the session is gone. */
	clear = (): void => {
		this.set(ANONYMOUS);
	};
}

export const authStore = new AuthStore();

setUnauthorizedHandler(authStore.clear);

export function useAuth(): AuthState {
	return useSyncExternalStore(authStore.subscribe, authStore.getSnapshot, authStore.getSnapshot);
}
