import type {
	DirectoryResponse,
	NodeGroupListResponse,
	NodeListResponse,
	UserGroupListResponse,
	UserListResponse,
} from "@crh/api";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { nodeStatusLabel } from "@/components/status-badge";
import { http, queryString } from "@/lib/api/client";

/**
 * The data half of EntityPicker: one search hook per entity kind (doc/webui.md
 * "实体搜索"). Every request goes through the existing list endpoints' `q` /
 * `limit` / `ids` parameters, so no picker ever downloads the whole directory.
 */

export type EntityKind = "user" | "userGroup" | "node" | "nodeGroup" | "directory" | "nodeTarget";

/** The concrete kind of one option; `directory` combines users and user groups. */
export type EntityOptionKind = "user" | "userGroup" | "node" | "nodeGroup";

export interface EntityOption {
	id: string;
	kind: EntityOptionKind;
	/** What the picker shows as the item's main line (a display name, a node name, …). */
	primary: string;
	/** The muted second line, when the entity has one worth showing. */
	secondary?: string;
	/** An inactive user or node; callers that must keep their old filter pass `includeDisabled={false}`. */
	disabled?: boolean;
}

export interface EntitySearchPage {
	options: EntityOption[];
	/** True when the server had more matches than `limit` (50). */
	more: boolean;
}

/** The picker's server-side page size; well under the API's 100. */
export const ENTITY_PICKER_LIMIT = 50;

/**
 * The picker's cache keys. They sit under the owning feature's root (`["users"]`, `["nodes"]`,
 * `["node-groups"]`), so a create/rename/delete that invalidates that root also refreshes the
 * picker without every mutation knowing about EntityPicker.
 */
const ROOTS: Record<EntityKind, readonly string[]> = {
	user: ["users", "picker"],
	userGroup: ["users", "user-groups", "picker"],
	node: ["nodes", "picker"],
	nodeGroup: ["node-groups", "picker"],
	directory: ["users", "directory-picker"],
	// Node and node-group mutations both invalidate `["nodes"]`, so one root refreshes both halves.
	nodeTarget: ["nodes", "picker", "node-target"],
};

export const entityPickerKeys = {
	search: (kind: EntityKind, q: string) => [...ROOTS[kind], "search", q] as const,
	ids: (kind: EntityKind, ids: readonly string[]) => [...ROOTS[kind], "ids", [...ids].sort()] as const,
};

function countText(i18n: ReturnType<typeof useLingui>["i18n"], count: number): string {
	return i18n._(
		plural(count, {
			one: "# member",
			other: "# members",
		}),
	);
}

function userOption(user: { id: string; username: string; displayName: string; status?: string }): EntityOption {
	const primary = user.displayName || user.username;
	return {
		id: user.id,
		kind: "user",
		primary,
		// The username is the one stable handle when it differs from the shown name.
		...(user.displayName && user.displayName !== user.username ? { secondary: `@${user.username}` } : {}),
		// A disabled account may be shown by the member editor but must not gain new access.
		disabled: user.status !== undefined && user.status !== "active",
	};
}

/** A node anywhere it is chosen as a target: the hostname and status explain the name. */
function nodeOption(
	node: { id: string; name: string; hostname: string | null; status: string; connected?: boolean | null },
	i18n: ReturnType<typeof useLingui>["i18n"],
): EntityOption {
	return {
		id: node.id,
		kind: "node",
		primary: node.name,
		secondary: [node.hostname, nodeStatusLabel(i18n, node.status, node.connected)]
			.filter((part) => part !== null && part !== "")
			.join(" · "),
		disabled: node.status !== "active",
	};
}

/** A grant target: the hostname alone distinguishes same-named nodes in the merged list. */
function nodeTargetNodeOption(node: {
	id: string;
	name: string;
	hostname: string | null;
	status: string;
	connected?: boolean | null;
}): EntityOption {
	return {
		id: node.id,
		kind: "node",
		primary: node.name,
		secondary: node.hostname === null || node.hostname === "" ? undefined : node.hostname,
		disabled: node.status !== "active",
	};
}

/** A node group grant target: the member count is its useful second line. */
function nodeTargetGroupOption(
	group: { id: string; name: string; memberIds: string[] },
	i18n: ReturnType<typeof useLingui>["i18n"],
): EntityOption {
	return {
		id: group.id,
		kind: "nodeGroup",
		primary: group.name,
		secondary: countText(i18n, group.memberIds.length),
	};
}

/** Fetches one search page; the response mapping is shared with the label lookup. */
async function fetchSearch(
	kind: EntityKind,
	q: string,
	i18n: ReturnType<typeof useLingui>["i18n"],
	signal: AbortSignal,
): Promise<EntitySearchPage> {
	const params = queryString({ q, limit: ENTITY_PICKER_LIMIT });
	switch (kind) {
		case "user": {
			const body = await http.get<UserListResponse>(`/users${params}`, { signal });
			return { options: body.users.map((user) => userOption(user)), more: body.more === true };
		}
		case "userGroup": {
			const body = await http.get<UserGroupListResponse>(`/user-groups${params}`, { signal });
			return {
				options: body.groups.map((group) => ({
					id: group.id,
					kind: "userGroup",
					primary: group.name,
					secondary: countText(i18n, group.memberIds.length),
				})),
				more: body.more === true,
			};
		}
		case "node": {
			const body = await http.get<NodeListResponse>(`/nodes${params}`, { signal });
			return {
				options: body.nodes.map((node) => nodeOption(node, i18n)),
				more: body.more === true,
			};
		}
		case "nodeGroup": {
			const body = await http.get<NodeGroupListResponse>(`/node-groups${params}`, { signal });
			return {
				options: body.groups.map((group) => ({
					id: group.id,
					kind: "nodeGroup",
					primary: group.name,
					secondary: countText(i18n, group.memberIds.length),
				})),
				more: body.more === true,
			};
		}
		case "directory": {
			const body = await http.get<DirectoryResponse>(`/directory${params}`, { signal });
			return {
				options: [
					...body.users.map((user) => userOption(user)),
					...body.userGroups.map((group) => ({
						id: group.id,
						kind: "userGroup" as const,
						primary: group.name,
					})),
				],
				more: body.more === true,
			};
		}
		case "nodeTarget": {
			const [nodes, groups] = await Promise.all([
				http.get<NodeListResponse>(`/nodes${params}`, { signal }),
				http.get<NodeGroupListResponse>(`/node-groups${params}`, { signal }),
			]);
			return {
				options: [
					...nodes.nodes.map((node) => nodeTargetNodeOption(node)),
					...groups.groups.map((group) => nodeTargetGroupOption(group, i18n)),
				],
				more: nodes.more === true || groups.more === true,
			};
		}
	}
}

/** The current search page for `q`; `enabled` keeps it idle until the popup opens. */
export function useEntitySearch(kind: EntityKind, q: string, enabled: boolean) {
	const { i18n } = useLingui();
	return useQuery({
		queryKey: entityPickerKeys.search(kind, q),
		enabled,
		queryFn: ({ signal }) => fetchSearch(kind, q, i18n, signal),
	});
}

async function fetchLabelsChunk(
	kind: EntityKind,
	ids: readonly string[],
	i18n: ReturnType<typeof useLingui>["i18n"],
	signal: AbortSignal,
): Promise<EntityOption[]> {
	const params = queryString({ ids: ids.join(",") });
	switch (kind) {
		case "user": {
			const body = await http.get<UserListResponse>(`/users${params}`, { signal });
			return body.users.map((user) => userOption(user));
		}
		case "userGroup": {
			const body = await http.get<UserGroupListResponse>(`/user-groups${params}`, { signal });
			return body.groups.map((group) => ({
				id: group.id,
				kind: "userGroup",
				primary: group.name,
				secondary: countText(i18n, group.memberIds.length),
			}));
		}
		case "node": {
			const body = await http.get<NodeListResponse>(`/nodes${params}`, { signal });
			return body.nodes.map((node) => nodeOption(node, i18n));
		}
		case "nodeGroup": {
			const body = await http.get<NodeGroupListResponse>(`/node-groups${params}`, { signal });
			return body.groups.map((group) => ({
				id: group.id,
				kind: "nodeGroup",
				primary: group.name,
				secondary: countText(i18n, group.memberIds.length),
			}));
		}
		case "directory": {
			const body = await http.get<DirectoryResponse>(`/directory${params}`, { signal });
			return [
				...body.users.map((user) => userOption(user)),
				...body.userGroups.map((group) => ({
					id: group.id,
					kind: "userGroup" as const,
					primary: group.name,
				})),
			];
		}
		case "nodeTarget": {
			const [nodes, groups] = await Promise.all([
				http.get<NodeListResponse>(`/nodes${params}`, { signal }),
				http.get<NodeGroupListResponse>(`/node-groups${params}`, { signal }),
			]);
			return [
				...nodes.nodes.map((node) => nodeTargetNodeOption(node)),
				...groups.groups.map((group) => nodeTargetGroupOption(group, i18n)),
			];
		}
	}
}

/** The API accepts at most 100 ids at once; a long multi-selection is resolved in chunks. */
async function fetchLabels(
	kind: EntityKind,
	ids: readonly string[],
	i18n: ReturnType<typeof useLingui>["i18n"],
	signal: AbortSignal,
): Promise<EntityOption[]> {
	const chunks: string[][] = [];
	for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
	const pages = await Promise.all(chunks.map((chunk) => fetchLabelsChunk(kind, chunk, i18n, signal)));
	return pages.flat();
}

/**
 * Resolves the labels of the values already selected, even when they are outside the current
 * search results. The query key is the sorted id list, so the same selection is one cache entry.
 */
export function useEntityLabels(kind: EntityKind, ids: readonly string[]) {
	const { i18n } = useLingui();
	return useQuery({
		queryKey: entityPickerKeys.ids(kind, ids),
		enabled: ids.length > 0,
		queryFn: ({ signal }) => fetchLabels(kind, [...ids].sort(), i18n, signal),
	});
}
