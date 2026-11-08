/**
 * Shapes that every crhs HTTP API module shares (doc/webui.md "API 约定").
 *
 * The types in this package are the Web API's wire types: the JSON the server
 * sends and accepts. They live here so that crhs and the WebUI use one
 * definition instead of two copies that drift.
 */

/** One page of a keyset-cursor list (doc/webui.md "游标列表"). */
export interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}

/** Query parameters every cursor list accepts. */
export interface CursorQuery {
	cursor?: string;
	limit?: number;
}

/** The current name of a stored node/node-group reference; null when the object was deleted. */
export interface RefTarget {
	kind: "node" | "node_group";
	name: string;
}

/** Display names for stored UUID references, keyed by id (D109). */
export type RefMap = Record<string, RefTarget | null>;
