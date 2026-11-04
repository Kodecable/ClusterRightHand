import type { PublicNode } from "@/lib/api/types";

/**
 * Whether the caller may run tasks on this node (doc/access-control.md#归属访问授权与分享): one access level,
 * and every node a non-administrator sees is already granted to them. Administrators manage nodes; the caller's
 * kind decides that, so no node action is offered from the node's own `access` value.
 */
export function canRunOn(node: PublicNode): boolean {
	return node.status === "active";
}
