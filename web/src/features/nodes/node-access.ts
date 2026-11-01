import type { PublicNode } from "@/lib/api/types";

/** Whether the caller may run tasks on this node (doc/access-control.md#节点访问). */
export function canRunOn(node: PublicNode): boolean {
	return node.status === "active" && (node.access === "owner" || node.access === "admin" || node.access === "operate");
}

export function canManageNode(node: PublicNode): boolean {
	return node.access === "owner" || node.access === "admin";
}
