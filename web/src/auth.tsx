import { createContext, type ReactNode, useContext } from "react";
import type { User } from "./api.ts";

const Ctx = createContext<User | null>(null);

export function UserProvider({ user, children }: { user: User; children: ReactNode }) {
	return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}

export function useUser(): User {
	const u = useContext(Ctx);
	if (!u) throw new Error("no user in context");
	return u;
}
