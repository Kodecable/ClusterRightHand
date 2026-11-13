import type {
	CrhsKeyResponse,
	EnrollmentTokenResponse,
	NodeFileInfo,
	NodeFilesResponse,
	NodeGroupRef,
	NodeTrust,
	PublicNode,
	SshNodeDetails,
	SshTargetInput,
	TaskView,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { FileEntry, FileSource } from "@/components/file-manager";
import { nodeGroupKeys } from "@/features/node-groups/keys";
import { enc, http } from "@/lib/api/client";

export const nodeKeys = {
	all: ["nodes"] as const,
	list: () => ["nodes", "list"] as const,
	detail: (id: string) => ["nodes", "detail", id] as const,
	trust: (id: string) => ["nodes", "trust", id] as const,
	tasks: (id: string) => ["nodes", "tasks", id] as const,
	crhsKey: () => ["nodes", "crhs-key"] as const,
};

export function useNodes() {
	// Pending enrolments and online/offline changes show up without a refresh.
	return useQuery({
		queryKey: nodeKeys.list(),
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
		refetchInterval: 5_000,
	});
}

export function useNode(id: string | undefined) {
	return useQuery({
		queryKey: nodeKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			// `ssh` is admin-only; a non-admin response has no `ssh`.
			http.get<{ node: PublicNode; ssh?: SshNodeDetails | null }>(`/nodes/${enc(id ?? "")}`, {
				signal,
			}),
	});
}

export function useNodeTrust(id: string | undefined) {
	// The node pushes a new report when it reconnects or its configuration
	// changes; a 10 s poll shows it without a "Refresh" button. Node mutations
	// invalidate `nodeKeys.all` at once.
	return useQuery({
		queryKey: nodeKeys.trust(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ trust: NodeTrust }>(`/nodes/${enc(id ?? "")}/trust`, { signal }).then((r) => r.trust),
		refetchInterval: 10_000,
	});
}

export function useNodeTasks(id: string | undefined) {
	// Tasks also start outside this page (schedules, batch, API tokens); polling
	// keeps the section current, and the run panel invalidates it at once.
	return useQuery({
		queryKey: nodeKeys.tasks(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ tasks: TaskView[] }>(`/nodes/${enc(id ?? "")}/tasks`, { signal }).then((r) => r.tasks),
		refetchInterval: 10_000,
	});
}

export function useCrhsKey() {
	return useQuery({
		queryKey: nodeKeys.crhsKey(),
		// The response carries the newest key first (`key`) and every key (`keys`).
		queryFn: ({ signal }) => http.get<CrhsKeyResponse>("/privilege/crhs-key", { signal }),
	});
}

export function useApproveNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.post<{ node: PublicNode }>(`/nodes/${enc(id)}/approve`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

export function useDeleteNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/nodes/${enc(id)}`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
			// The node's node-group memberships are gone with it.
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
		},
		// The delete confirmation shows the failure inline; it does not also need a toast.
		meta: { toast: false },
	});
}

export function useRenameNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			http.patch<{ node: PublicNode }>(`/nodes/${enc(id)}`, { name }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

export function useEnrollmentToken() {
	// The add-node dialog renders the failure in the dialog.
	return useMutation({
		mutationFn: (nameHint?: string) =>
			http.post<EnrollmentTokenResponse>("/enrollment-tokens", nameHint ? { nameHint } : {}),
		meta: { toast: false },
	});
}

/**
 * Creates a one-time token that replaces a crha node's key. The node becomes pending again, so the
 * detail query is invalidated once the token is created.
 */
export function useReenrollNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.post<EnrollmentTokenResponse>(`/nodes/${enc(id)}/reenroll`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
		meta: { toast: false },
	});
}

/** Probes the route's next unpinned hop and returns the fingerprint the wizard shows for confirmation. */
export function useProbeSshHost() {
	return useMutation({
		mutationFn: (body: SshTargetInput) => http.post<{ hop: number; fingerprint: string }>("/ssh-nodes/probe", body),
	});
}

/** Creates an SSH node from the wizard's route (jump hosts first, the target last). */
export function useCreateSshNode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: SshTargetInput & { name: string }) =>
			http.post<{ node: PublicNode }>("/ssh-nodes", body).then((r) => r.node),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
	});
}

/**
 * Replaces an existing SSH node's route. The server closes the node's pooled connection (tasks running on
 * it become unknown), so the detail and list queries are invalidated.
 */
export function useUpdateSshNodeRoute() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, body }: { id: string; body: SshTargetInput }) =>
			http.patch<{ node: PublicNode }>(`/nodes/${enc(id)}/ssh-route`, body).then((r) => r.node),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: nodeKeys.all }),
		// The dialog shows the server's refusal inline.
		meta: { toast: false },
	});
}

/** Tries the whole route before the node is created (the wizard's last step). */
export function useTestSshRoute() {
	// The TestConnection button reports success and failure inline.
	return useMutation({
		mutationFn: (body: SshTargetInput) => http.post<{ ok: true }>("/ssh-nodes/test", body),
		meta: { toast: false },
	});
}

/** Tries an existing SSH node's route and credential. */
export function useTestSshNode() {
	// The TestConnection button reports success and failure inline.
	return useMutation({
		mutationFn: (id: string) => http.post<{ ok: true }>(`/nodes/${enc(id)}/ssh-test`),
		meta: { toast: false },
	});
}

/** Replaces a node's node groups; administrators only, for crha and SSH nodes alike. */
export function useSetNodeGroups() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, nodeGroups }: { id: string; nodeGroups: string[] }) =>
			http
				.put<{ nodeGroups: NodeGroupRef[] }>(`/nodes/${enc(id)}/node-groups`, { nodeGroups })
				.then((r) => r.nodeGroups),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
			// The node groups' member lists changed too.
			void queryClient.invalidateQueries({ queryKey: nodeGroupKeys.all });
		},
	});
}

/** A node file's media type from its name; the server sniffs the bytes again before serving a preview. */
function mediaTypeOf(name: string): string | undefined {
	const lower = name.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return undefined;
}

function nodeAbsolutePath(prefix: string): string {
	return prefix === "" ? "/" : `/${prefix}`;
}

/**
 * The FileSource of a node's Files tab (doc/design/webui.md "Node pages"): list, stat and preview only;
 * upload, download, delete and rename are not available for nodes yet. Every call is a browse task the
 * server runs as the signed-in user, unprivileged.
 */
export function useNodeFileSource(nodeId: string): FileSource {
	return useMemo<FileSource>(() => {
		const base = `/nodes/${enc(nodeId)}`;
		return {
			async list(prefix, signal) {
				const body = await http.get<NodeFilesResponse>(
					`${base}/files?path=${encodeURIComponent(nodeAbsolutePath(prefix))}`,
					{
						signal,
					},
				);
				const files: FileEntry[] = body.entries
					.filter((entry) => entry.type !== "dir")
					.map((entry) => ({
						path: entry.path.replace(/^\//, ""),
						name: entry.name,
						kind: "file",
						size: entry.size,
						mediaType: mediaTypeOf(entry.name),
						...(entry.mtime === undefined ? {} : { updatedAt: entry.mtime }),
					}));
				return {
					files,
					directories: body.entries.filter((entry) => entry.type === "dir").map((entry) => entry.name),
				};
			},
			async stat(path) {
				const body = await http.get<{ file: NodeFileInfo }>(`${base}/stat?path=${encodeURIComponent(`/${path}`)}`);
				const file = body.file;
				return {
					path: file.path.replace(/^\//, ""),
					name: file.path.slice(file.path.lastIndexOf("/") + 1),
					kind: file.type === "dir" ? "directory" : "file",
					size: file.size,
					mediaType: mediaTypeOf(file.path),
					updatedAt: file.mtime,
				};
			},
			download(path) {
				return `/api${base}/file?path=${encodeURIComponent(`/${path}`)}`;
			},
			async preview(path) {
				const response = await fetch(`/api${base}/file?path=${encodeURIComponent(`/${path}`)}&preview=1`, {
					credentials: "same-origin",
				});
				if (!response.ok) {
					let message = `HTTP ${response.status}`;
					try {
						const body = (await response.json()) as { error?: string };
						message = body.error ?? message;
					} catch {
						// Not JSON; keep the status line.
					}
					throw new Error(message);
				}
				return response.blob();
			},
		};
	}, [nodeId]);
}
