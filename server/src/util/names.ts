import type { Db } from "../storage/db.ts";
import { UserError } from "./errors.ts";

/**
 * Node and node-group names (doc/design/access-control.md "User model"). Names are display values: uniqueness and
 * lookup compare `nameKey`, while the stored name keeps its case. Nodes and node groups share one namespace
 * per organization, so a node may not take a group's name and vice versa.
 */

export const NAME_MIN = 2;
export const NAME_MAX = 64;

/** A user-chosen name: 2-64 characters, starting with a letter, ending with a letter or digit. */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9._/-]*[A-Za-z0-9]$/;

/** System names start with `_`; the only one today is `_all`. The name rule already excludes them. */
export const ALL_TARGET = "_all";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** The stored comparison key: lowercasing is the whole of the case folding both dialects share. */
export function nameKey(raw: string): string {
	return raw.toLowerCase();
}

/**
 * Validates an explicit name (rename, create group, SSH node name): the input is taken as written (only
 * surrounding whitespace is removed), never normalized, so a rejected name is visible to the caller.
 */
export function validateName(raw: string, what = "name"): string {
	const name = raw.trim();
	if (name.startsWith("_")) {
		throw new UserError(`${what} must not start with "_": names starting with "_" are reserved for the system`);
	}
	if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) {
		throw new UserError(
			`${what} must be 2-64 characters, start with a letter, end with a letter or digit, and contain only ` +
				"letters, digits, '.', '_', '/' or '-'",
		);
	}
	return name;
}

/** Names already in use, as lowercase keys: a predicate or any iterable of keys. */
export type TakenNames = ((key: string) => boolean) | Iterable<string>;

/**
 * Makes a generated default name (enrollment name_hint, hostname, SSH host) fit the name rule: disallowed
 * characters become `-`, a leading non-letter gets the `n-` prefix, trailing non-alphanumerics are removed,
 * short names are padded and long ones cut to 64. A name already in `taken` (lowercase keys) gets `-2`, `-3`, …
 */
export function normalizeName(raw: string, taken: TakenNames = () => false): string {
	const keys = typeof taken === "function" ? undefined : new Set([...taken].map((key) => key.toLowerCase()));
	const isTaken = typeof taken === "function" ? taken : (key: string) => (keys as Set<string>).has(key);
	let name = raw.replace(/[^A-Za-z0-9._/-]/g, "-");
	if (!/^[A-Za-z]/.test(name)) name = `n-${name}`;
	name = name.replace(/[^A-Za-z0-9]+$/, "");
	if (name.length < NAME_MIN) name = name.padEnd(NAME_MIN, "0");
	if (name.length > NAME_MAX) {
		name = name.slice(0, NAME_MAX).replace(/[^A-Za-z0-9]+$/, "");
		// Truncating can cut a long run down to a single leading letter; the result still has to be a name.
		if (name.length < NAME_MIN) name = name.padEnd(NAME_MIN, "0");
	}
	const base = name;
	if (!isTaken(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
		if (!isTaken(candidate.toLowerCase())) return candidate;
	}
}

export interface NameOwner {
	table: "nodes" | "node_groups";
	id: string;
}

/** Whether the name key is already used by a node or a node group in the organization. */
export async function nameTaken(db: Db, orgId: string, key: string, except?: NameOwner): Promise<boolean> {
	const node = await db
		.selectFrom("nodes")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name_key", "=", key)
		.executeTakeFirst();
	if (node && !(except?.table === "nodes" && except.id === node.id)) return true;
	const group = await db
		.selectFrom("node_groups")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name_key", "=", key)
		.executeTakeFirst();
	return Boolean(group && !(except?.table === "node_groups" && except.id === group.id));
}

/** Rejects a name already used by a node or node group; call inside the transaction that writes the row. */
export async function assertNameAvailable(db: Db, orgId: string, name: string, except?: NameOwner): Promise<void> {
	const key = nameKey(name);
	if (!(await nameTaken(db, orgId, key, except))) return;
	const node = await db
		.selectFrom("nodes")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name_key", "=", key)
		.executeTakeFirst();
	if (node && !(except?.table === "nodes" && except.id === node.id)) {
		throw new UserError(`a node named "${name}" already exists`);
	}
	throw new UserError(`a node group named "${name}" already exists`);
}

/** Every name key used by a node or a node group in the organization, for normalizeName's collision check. */
export async function takenNameKeys(db: Db, orgId: string): Promise<Set<string>> {
	const [nodes, groups] = await Promise.all([
		db.selectFrom("nodes").select("name_key").where("org_id", "=", orgId).execute(),
		db.selectFrom("node_groups").select("name_key").where("org_id", "=", orgId).execute(),
	]);
	return new Set([...nodes.map((row) => row.name_key), ...groups.map((row) => row.name_key)]);
}

/** Allocates a generated default name that is free in the organization's shared namespace. */
export async function availableGeneratedName(db: Db, orgId: string, raw: string): Promise<string> {
	const taken = await takenNameKeys(db, orgId);
	return normalizeName(raw, (key) => taken.has(key));
}
