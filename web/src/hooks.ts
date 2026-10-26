import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export interface Loaded<T> {
	data: T | undefined;
	error: string | undefined;
	loading: boolean;
	reload: () => void;
}

/** Runs `fn` on mount and when deps change; `reload()` refetches. Stale results are ignored. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [tick, setTick] = useState(0);
	const fnRef = useRef(fn);
	fnRef.current = fn;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller
	useEffect(() => {
		let live = true;
		setLoading(true);
		fnRef.current().then(
			(d) => {
				if (!live) return;
				setData(d);
				setError(undefined);
				setLoading(false);
			},
			(e: unknown) => {
				if (!live) return;
				setError(e instanceof Error ? e.message : String(e));
				setLoading(false);
			},
		);
		return () => {
			live = false;
		};
	}, [...deps, tick]);
	const reload = useCallback(() => setTick((t) => t + 1), []);
	return { data, error, loading, reload };
}

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Wraps an async action with busy/error state. */
export function useAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
		setBusy(true);
		setError(undefined);
		try {
			return await fn();
		} catch (e) {
			setError(errMsg(e));
			return undefined;
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, error, run, setError };
}

/** The user/group directory plus a lookup for user display names; empty until loaded or if it fails. */
export function useDirectory() {
	const { data } = useLoad(() => api.directory(), []);
	const userName = useCallback(
		(id: string) => {
			const u = data?.users.find((x) => x.id === id);
			return u ? u.displayName || u.username : undefined;
		},
		[data],
	);
	return { users: data?.users ?? [], userGroups: data?.userGroups ?? [], userName };
}
