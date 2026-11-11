/** Editing helpers for an SSH route's hop list (jump hosts first, the target last). */
export interface Hop {
	host: string;
	port: string;
	user: string;
	/** Confirmed host fingerprint, or "" while unpinned. */
	hostFingerprint: string;
	/** This hop's credential, or "" until one is picked. */
	credentialId: string;
}

export const emptyHop = (user = ""): Hop => ({ host: "", port: "22", user, hostFingerprint: "", credentialId: "" });

/**
 * Replaces fields of hop `i`. A host fingerprint belongs to the address (host:port), so changing either
 * clears that hop's pin; a user or credential change, and adding or removing other rows, keep every pin.
 */
export function editHop(hops: Hop[], index: number, patch: Partial<Omit<Hop, "hostFingerprint">>): Hop[] {
	const current = hops[index];
	if (!current) return hops;
	const addressChanged =
		(patch.host !== undefined && patch.host !== current.host) ||
		(patch.port !== undefined && patch.port !== current.port);
	return hops.map((hop, i) =>
		i === index ? { ...hop, ...patch, ...(addressChanged ? { hostFingerprint: "" } : {}) } : hop,
	);
}

/** Appends a new empty row: it becomes the target and the previous target becomes a jump. */
export function addHop(hops: Hop[]): Hop[] {
	return [...hops, emptyHop()];
}

/** Removes a row, target included (then the previous jump becomes the target); the last row stays. */
export function removeHop(hops: Hop[], index: number): Hop[] {
	if (hops.length <= 1 || index < 0 || index >= hops.length) return hops;
	return hops.filter((_, i) => i !== index);
}

export function pinHop(hops: Hop[], index: number, fingerprint: string): Hop[] {
	return hops.map((hop, i) => (i === index ? { ...hop, hostFingerprint: fingerprint } : hop));
}

export function firstUnpinned(hops: Hop[]): number {
	return hops.findIndex((hop) => !hop.hostFingerprint);
}

/** A validation failure of one hop, as a code the route editor translates with Lingui. */
export interface HopError {
	/** The index into the hop list (target last). */
	hop: number;
	code: "host-required" | "user-required" | "port-invalid" | "credential-required";
}

/** Validates the hop fields; returns the first failure or undefined. */
export function validateHops(hops: Hop[]): HopError | undefined {
	for (const [hop, value] of hops.entries()) {
		if (!value.host.trim()) return { hop, code: "host-required" };
		if (!value.user.trim()) return { hop, code: "user-required" };
		const port = Number(value.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return { hop, code: "port-invalid" };
		if (!value.credentialId) return { hop, code: "credential-required" };
	}
	return undefined;
}

/** API shape of the route; `hostFingerprint` is included only for hops that have a pinned fingerprint. */
export function hopBodies(hops: Hop[]) {
	const one = (hop: Hop) => ({
		host: hop.host.trim(),
		port: Number(hop.port),
		user: hop.user.trim(),
		credentialId: hop.credentialId,
		...(hop.hostFingerprint ? { hostFingerprint: hop.hostFingerprint } : {}),
	});
	const target = hops[hops.length - 1] as Hop;
	return { ...one(target), jumps: hops.slice(0, -1).map(one) };
}
