/** Editing helpers for the SSH wizard's hop list (jump hosts first, the target last). */
export interface Hop {
	host: string;
	port: string;
	user: string;
	/** Confirmed host key fingerprint, or "" while unpinned. */
	hostKey: string;
}

export const emptyHop = (user = ""): Hop => ({ host: "", port: "22", user, hostKey: "" });

/** Clears the pin of hop `i` and of every later hop (their routes go through hop `i`). */
export function clearPinsFrom(hops: Hop[], i: number): Hop[] {
	return hops.map((h, j) => (j >= i && h.hostKey ? { ...h, hostKey: "" } : h));
}

/** Replaces fields of hop `i`; a change to host, port or user invalidates that and later pins. */
export function editHop(hops: Hop[], i: number, patch: Partial<Omit<Hop, "hostKey">>): Hop[] {
	const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== hops[i]?.[k]);
	const next = hops.map((h, j) => (j === i ? { ...h, ...patch } : h));
	return changed ? clearPinsFrom(next, i) : next;
}

export function addJump(hops: Hop[], jump: Hop): Hop[] {
	// Insert before the target; the target's route changes, so its pin goes.
	return clearPinsFrom([...hops.slice(0, -1), jump, ...hops.slice(-1)], hops.length - 1);
}

export function removeJump(hops: Hop[], i: number): Hop[] {
	if (i < 0 || i >= hops.length - 1) return hops;
	return clearPinsFrom(
		hops.filter((_, j) => j !== i),
		i,
	);
}

/** Moves jump `i` by `delta` (-1 up, +1 down) within the jumps; the target stays last. */
export function moveJump(hops: Hop[], i: number, delta: -1 | 1): Hop[] {
	const k = i + delta;
	if (i < 0 || k < 0 || i >= hops.length - 1 || k >= hops.length - 1) return hops;
	const next = [...hops];
	[next[i], next[k]] = [next[k] as Hop, next[i] as Hop];
	return clearPinsFrom(next, Math.min(i, k));
}

export function pinHop(hops: Hop[], i: number, fingerprint: string): Hop[] {
	return hops.map((h, j) => (j === i ? { ...h, hostKey: fingerprint } : h));
}

export function firstUnpinned(hops: Hop[]): number {
	return hops.findIndex((h) => !h.hostKey);
}

/** Validates the hop fields; returns a user-facing message or undefined. */
export function validateHops(hops: Hop[]): string | undefined {
	for (const [i, h] of hops.entries()) {
		const what = i === hops.length - 1 ? "target" : `jump ${i + 1}`;
		if (!h.host.trim()) return `${what}: host is required`;
		if (!h.user.trim()) return `${what}: user is required`;
		const p = Number(h.port);
		if (!Number.isInteger(p) || p < 1 || p > 65535) return `${what}: invalid port`;
	}
	return undefined;
}

/** API shape of the route; `pinned` includes host keys only for hops that have one. */
export function hopBodies(hops: Hop[]) {
	const one = (h: Hop) => ({
		host: h.host.trim(),
		port: Number(h.port),
		user: h.user.trim(),
		...(h.hostKey ? { hostKey: h.hostKey } : {}),
	});
	const target = hops[hops.length - 1] as Hop;
	return { ...one(target), jumps: hops.slice(0, -1).map(one) };
}
