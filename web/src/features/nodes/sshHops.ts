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
export function clearPinsFrom(hops: Hop[], index: number): Hop[] {
	return hops.map((hop, i) => (i >= index && hop.hostKey ? { ...hop, hostKey: "" } : hop));
}

/** Replaces fields of hop `i`; a change to host, port or user invalidates that and later pins. */
export function editHop(hops: Hop[], index: number, patch: Partial<Omit<Hop, "hostKey">>): Hop[] {
	const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((key) => patch[key] !== hops[index]?.[key]);
	const next = hops.map((hop, i) => (i === index ? { ...hop, ...patch } : hop));
	return changed ? clearPinsFrom(next, index) : next;
}

export function addJump(hops: Hop[], jump: Hop): Hop[] {
	// Insert before the target; the target's route changes, so its pin goes.
	return clearPinsFrom([...hops.slice(0, -1), jump, ...hops.slice(-1)], hops.length - 1);
}

export function removeJump(hops: Hop[], index: number): Hop[] {
	if (index < 0 || index >= hops.length - 1) return hops;
	return clearPinsFrom(
		hops.filter((_, i) => i !== index),
		index,
	);
}

/** Moves jump `i` by `delta` (-1 up, +1 down) within the jumps; the target stays last. */
export function moveJump(hops: Hop[], index: number, delta: -1 | 1): Hop[] {
	const target = index + delta;
	if (index < 0 || target < 0 || index >= hops.length - 1 || target >= hops.length - 1) return hops;
	const next = [...hops];
	[next[index], next[target]] = [next[target] as Hop, next[index] as Hop];
	return clearPinsFrom(next, Math.min(index, target));
}

export function pinHop(hops: Hop[], index: number, fingerprint: string): Hop[] {
	return hops.map((hop, i) => (i === index ? { ...hop, hostKey: fingerprint } : hop));
}

export function firstUnpinned(hops: Hop[]): number {
	return hops.findIndex((hop) => !hop.hostKey);
}

/** A validation failure of one hop, as a code the wizard translates with Lingui. */
export interface HopError {
	/** The index into the hop list (target last). */
	hop: number;
	code: "host-required" | "user-required" | "port-invalid";
}

/** Validates the hop fields; returns the first failure or undefined. */
export function validateHops(hops: Hop[]): HopError | undefined {
	for (const [hop, value] of hops.entries()) {
		if (!value.host.trim()) return { hop, code: "host-required" };
		if (!value.user.trim()) return { hop, code: "user-required" };
		const port = Number(value.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return { hop, code: "port-invalid" };
	}
	return undefined;
}

/** API shape of the route; `pinned` includes host keys only for hops that have one. */
export function hopBodies(hops: Hop[]) {
	const one = (hop: Hop) => ({
		host: hop.host.trim(),
		port: Number(hop.port),
		user: hop.user.trim(),
		...(hop.hostKey ? { hostKey: hop.hostKey } : {}),
	});
	const target = hops[hops.length - 1] as Hop;
	return { ...one(target), jumps: hops.slice(0, -1).map(one) };
}
