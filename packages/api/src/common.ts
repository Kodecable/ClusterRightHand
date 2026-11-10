/**
 * Shapes that every crhs HTTP API module shares (doc/design/webui.md "API conventions").
 *
 * The types in this package are the Web API's wire types: the JSON the server
 * sends and accepts. They live here so that crhs and the WebUI use one
 * definition instead of two copies that drift.
 */

/** One page of a keyset-cursor list (doc/design/webui.md "Cursor pagination"). */
export interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}

/** Query parameters every cursor list accepts. */
export interface CursorQuery {
	cursor?: string;
	limit?: number;
}

/**
 * Query parameters of the searchable entity lists (`GET /api/users`, `/api/user-groups`,
 * `/api/nodes`, `/api/node-groups` and `/api/directory`):
 *
 * - `q` matches case-insensitively: users by username or display name, user groups and node
 *   groups by name, nodes by name or hostname. Prefix matches come before substring matches.
 * - `limit` is 1..100. With it the response also carries `more`, true when more matched.
 * - `ids` is a comma-separated list of at most 100 ids and returns those items that exist and
 *   are visible; it cannot be combined with `q` or `limit`. EntityPicker uses it to resolve the
 *   labels of already-selected values.
 *
 * Without any of them a list endpoint returns exactly what it did before search existed.
 */
export interface EntityListQuery {
	q?: string;
	limit?: number;
	ids?: string;
}

/** The current name of a stored node/node-group reference; null when the object was deleted. */
export interface RefTarget {
	kind: "node" | "node_group";
	name: string;
}

/** Display names for stored UUID references, keyed by id. */
export type RefMap = Record<string, RefTarget | null>;
