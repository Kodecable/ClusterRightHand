export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export type UserKind = "admin" | "member";
export interface User {
	id: string;
	username: string;
	displayName: string;
	email: string | null;
	kind: UserKind;
	status: "active" | "disabled";
	createdAt: string;
}
export interface UserGroup {
	id: string;
	name: string;
	source: "local";
	createdAt: string;
	memberIds: string[];
}
export type NodeAccess = "owner" | "admin" | "operate" | "view";
export interface PublicNode {
	id: string;
	name: string;
	transport: string;
	status: "pending" | "active" | "disabled";
	hostname: string | null;
	ownerUserId: string;
	clientVersion: string | null;
	privilegedMode: string | null;
	lastSeenAt: string | null;
	createdAt: string;
	approvedAt: string | null;
	groups: string[];
	access: NodeAccess;
	facts: Record<string, unknown> | null;
	keyFingerprint: string | null;
}
export type GranteeType = "user" | "user_group";
export type ShareAccess = "view" | "operate";
export interface NodeShare {
	id: string;
	nodeId: string;
	granteeType: GranteeType;
	granteeId: string;
	access: ShareAccess;
	createdByUserId: string;
	createdAt: string;
}
export type TaskState = "exited" | "failed" | "rejected" | "unknown" | (string & {});
export interface TaskView {
	id: string;
	nodeId: string;
	kind: string;
	state: TaskState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	errorCode: string | null;
	errorMessage: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutHead: string;
	stdoutTail: string;
	stderrHead: string;
	stderrTail: string;
	outputFile: string | null;
	createdAt: string;
	finishedAt: string | null;
}
/** Body of POST /nodes/:id/tasks: `kind` plus the kind's fields. */
export type TaskRequest = { kind: string; timeoutMs?: number; waitMs?: number } & Record<string, unknown>;

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
	onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const init: RequestInit = { method, credentials: "same-origin", signal };
	// The CSRF guard needs a JSON content type on every non-GET request.
	if (method !== "GET") init.headers = { "content-type": "application/json" };
	if (method !== "GET") init.body = JSON.stringify(body ?? {});
	const res = await fetch(`/api${path}`, init);
	let data: unknown;
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		const message = (data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
		if (res.status === 401 && path !== "/auth/login") onUnauthorized();
		throw new ApiError(res.status, message);
	}
	return data as T;
}

const enc = encodeURIComponent;

export const api = {
	login: (username: string, password: string) =>
		request<{ user: User }>("POST", "/auth/login", { username, password }).then((r) => r.user),
	logout: () => request<{ ok: true }>("POST", "/auth/logout"),
	me: () => request<{ user: User }>("GET", "/me").then((r) => r.user),

	listNodes: () => request<{ nodes: PublicNode[] }>("GET", "/nodes").then((r) => r.nodes),
	getNode: (id: string) => request<{ node: PublicNode; shares?: NodeShare[] }>("GET", `/nodes/${enc(id)}`),
	approveNode: (id: string) => request<{ node: PublicNode }>("POST", `/nodes/${enc(id)}/approve`),
	deleteNode: (id: string) => request<{ ok: true }>("DELETE", `/nodes/${enc(id)}`),
	renameNode: (id: string, name: string) => request<{ node: PublicNode }>("PATCH", `/nodes/${enc(id)}`, { name }),
	shareNode: (id: string, granteeType: GranteeType, granteeId: string, access: ShareAccess) =>
		request<{ share: NodeShare }>("PUT", `/nodes/${enc(id)}/shares`, { granteeType, granteeId, access }),
	unshareNode: (id: string, shareId: string) =>
		request<{ ok: true }>("DELETE", `/nodes/${enc(id)}/shares/${enc(shareId)}`),
	createEnrollmentToken: (nameHint?: string) =>
		request<{ token: string; expiresAt: string }>("POST", "/enrollment-tokens", nameHint ? { nameHint } : {}),

	listNodeTasks: (id: string) => request<{ tasks: TaskView[] }>("GET", `/nodes/${enc(id)}/tasks`).then((r) => r.tasks),
	createTask: (nodeId: string, body: TaskRequest) =>
		request<{ task: TaskView }>("POST", `/nodes/${enc(nodeId)}/tasks`, body).then((r) => r.task),
	getTask: (id: string) => request<{ task: TaskView }>("GET", `/tasks/${enc(id)}`).then((r) => r.task),
	waitTask: (id: string, timeoutMs: number, signal?: AbortSignal) =>
		request<{ task: TaskView }>("GET", `/tasks/${enc(id)}/wait?timeoutMs=${timeoutMs}`, undefined, signal).then(
			(r) => r.task,
		),
	cancelTask: (id: string) => request<{ cancelled: boolean }>("POST", `/tasks/${enc(id)}/cancel`),

	listUsers: () => request<{ users: User[] }>("GET", "/users").then((r) => r.users),
	createUser: (u: { username: string; displayName?: string; kind: UserKind; password?: string }) =>
		request<{ user: User }>("POST", "/users", u).then((r) => r.user),
	updateUser: (id: string, patch: { kind?: UserKind; status?: "active" | "disabled"; displayName?: string }) =>
		request<{ user: User }>("PATCH", `/users/${enc(id)}`, patch).then((r) => r.user),
	setPassword: (id: string, password: string) =>
		request<{ ok: true }>("POST", `/users/${enc(id)}/password`, { password }),
	listGroups: () => request<{ groups: UserGroup[] }>("GET", "/user-groups").then((r) => r.groups),
	createGroup: (name: string) => request<{ group: UserGroup }>("POST", "/user-groups", { name }).then((r) => r.group),
	deleteGroup: (id: string) => request<{ ok: true }>("DELETE", `/user-groups/${enc(id)}`),
	addMember: (groupId: string, userId: string) =>
		request<{ ok: true }>("PUT", `/user-groups/${enc(groupId)}/members/${enc(userId)}`),
	removeMember: (groupId: string, userId: string) =>
		request<{ ok: true }>("DELETE", `/user-groups/${enc(groupId)}/members/${enc(userId)}`),
};
