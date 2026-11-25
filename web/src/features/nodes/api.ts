import type {
	CrhsKeyResponse,
	EnrollmentTokenResponse,
	NodeFileInfo,
	NodeFilesResponse,
	NodeGroupRef,
	NodeMetricsResponse,
	NodeTrafficResponse,
	NodeTrust,
	NodeUpgradeResponse,
	PublicNode,
	SshNodeDetails,
	SshTargetInput,
	TaskView,
} from "@crh/api";
import { NODE_METRICS_RANGES, type NodeMetricsRange } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { type FileEntry, type FileSource, previewMediaTypeOf } from "@/components/file-manager";
import { nodeGroupKeys } from "@/features/node-groups/keys";
import { enc, fetchBlob, http, queryString } from "@/lib/api/client";

export const nodeKeys = {
	all: ["nodes"] as const,
	list: () => ["nodes", "list"] as const,
	detail: (id: string) => ["nodes", "detail", id] as const,
	trust: (id: string) => ["nodes", "trust", id] as const,
	tasks: (id: string) => ["nodes", "tasks", id] as const,
	metrics: (id: string, range: MetricsRange) => ["nodes", "metrics", id, range] as const,
	/** Every range of a node's metrics, for a mutation that changes what they show. */
	metricsAll: (id: string) => ["nodes", "metrics", id] as const,
	availability: (id: string, days: number) => ["nodes", "availability", id, days] as const,
	crhsKey: () => ["nodes", "crhs-key"] as const,
};

/** The ranges the node page offers (doc/design/webui.md "Node pages"), shared with the `node_metrics` tool. */
export type MetricsRange = NodeMetricsRange;

export const METRICS_RANGE_MS: Record<MetricsRange, number> = NODE_METRICS_RANGES;

/**
 * The series the Metrics tab asks for; `disk.*` is expanded on the server to each of the node's
 * filesystems, so a filesystem added later needs no WebUI change.
 */
export const METRICS_SERIES = [
	"up",
	"uptime",
	"cpu.total",
	"load.1",
	"load.5",
	"load.15",
	"mem.total_bytes",
	"mem.available_bytes",
	"mem.cached_bytes",
	"mem.free_bytes",
	"swap.total_bytes",
	"swap.free_bytes",
	"disk.*",
	"net.rx_bytes_per_sec",
	"net.tx_bytes_per_sec",
	// The cumulative deltas are not charted, but their presence says whether a traffic total exists yet.
	"net.rx_bytes",
	"net.tx_bytes",
];

export function useNodes() {
	// Pending enrolments and online/offline changes show up without a refresh.
	return useQuery({
		queryKey: nodeKeys.list(),
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
		refetchInterval: 5_000,
	});
}

/**
 * Display names by node id, the one fallback every page uses (doc/design/webui.md "Shared components"):
 * the node's current name, else its id, so an unknown id stays visible.
 */
export function useNodeNames(): Map<string, string> {
	const nodes = useNodes();
	return useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name || node.id])), [nodes.data]);
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A node's stored metrics over one range; the server picks the coarsest level that covers it. The window
 * slides with every poll, so the request carries a fresh `to` each time. `visible` pauses the 30 s refresh
 * while the browser tab is hidden (doc/design/webui.md "Node pages").
 */
export function useNodeMetrics(id: string | undefined, range: MetricsRange, visible = true) {
	return useQuery({
		queryKey: nodeKeys.metrics(id ?? "", range),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) => {
			const to = Date.now();
			const from = to - METRICS_RANGE_MS[range];
			const query = queryString({ series: METRICS_SERIES.join(","), from, to });
			return http.get<NodeMetricsResponse>(`/nodes/${enc(id ?? "")}/metrics${query}`, { signal });
		},
		// A sample arrives once per interval; the charts follow without a refresh button.
		refetchInterval: visible ? 30_000 : false,
		refetchIntervalInBackground: true,
	});
}

/**
 * A node's level-4 `up` buckets for the availability strip: one bucket per UTC day, read directly at that
 * level because the tab's range query may choose a finer one. The strip has its own 30/90/365 day window.
 */
export function useNodeAvailability(id: string | undefined, days: number, enabled = true) {
	return useQuery({
		queryKey: nodeKeys.availability(id ?? "", days),
		enabled: enabled && id !== undefined && id !== "",
		queryFn: ({ signal }) => {
			const to = Date.now();
			const from = to - days * DAY_MS;
			const query = queryString({ series: "up", from, to, level: "4" });
			return http.get<NodeMetricsResponse>(`/nodes/${enc(id ?? "")}/metrics${query}`, { signal });
		},
		refetchInterval: enabled ? 30_000 : false,
		refetchIntervalInBackground: true,
	});
}

/**
 * "Reset now" for a node's traffic totals (doc/design/metrics.md "Traffic totals"): administrators only.
 * The metrics read is invalidated, so the summary and the period lines follow at once.
 */
export function useResetNodeTraffic(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			http.post<NodeTrafficResponse>(`/nodes/${enc(id)}/traffic/reset`).then((response) => response.traffic),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeKeys.metricsAll(id) });
			void queryClient.invalidateQueries({ queryKey: nodeKeys.detail(id) });
		},
		meta: { toast: false },
	});
}

/** Sets when a node's current traffic period ends; administrators only. */
export function useSetNodeTrafficNextReset(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { nextResetAt: string }) =>
			http.put<NodeTrafficResponse>(`/nodes/${enc(id)}/traffic/next-reset`, body).then((response) => response.traffic),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: nodeKeys.metricsAll(id) });
			void queryClient.invalidateQueries({ queryKey: nodeKeys.detail(id) });
		},
		meta: { toast: false },
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

/**
 * Sets or clears a node's user remark (doc/design/webui.md "Node pages"): administrators only. The saved
 * remark is written into the cached list at once, so the card shows it without waiting for the polling
 * read; the detail query is invalidated for the node page's read-only row.
 */
export function useSetNodeUserRemark() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, userRemark }: { id: string; userRemark: string | null }) =>
			http.put<{ node: PublicNode }>(`/nodes/${enc(id)}/user-remark`, { userRemark }).then((response) => response.node),
		onSuccess: (node) => {
			queryClient.setQueryData<PublicNode[]>(nodeKeys.list(), (nodes) =>
				nodes?.map((candidate) =>
					candidate.id === node.id ? { ...candidate, userRemark: node.userRemark } : candidate,
				),
			);
			void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
		},
		// The user remark editor shows the failure inline and stays open.
		meta: { toast: false },
	});
}

/**
 * Sets or clears a node's emoji (doc/design/webui.md "Node pages"): administrators only. The saved emoji
 * goes into the cached list at once, like the user remark, and every node query is invalidated so the
 * node page heading and the lists agree.
 */
export function useSetNodeEmoji() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, emoji }: { id: string; emoji: string | null }) =>
			http.put<{ node: PublicNode }>(`/nodes/${enc(id)}/emoji`, { emoji }).then((response) => response.node),
		onSuccess: (node) => {
			queryClient.setQueryData<PublicNode[]>(nodeKeys.list(), (nodes) =>
				nodes?.map((candidate) => (candidate.id === node.id ? { ...candidate, emoji: node.emoji } : candidate)),
			);
			void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
		},
		// The picker closes on success; a failure toasts like other one-click mutations.
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
						mediaType: previewMediaTypeOf(entry.name),
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
					mediaType: previewMediaTypeOf(file.path),
					updatedAt: file.mtime,
				};
			},
			download(path) {
				return `/api${base}/file?path=${encodeURIComponent(`/${path}`)}`;
			},
			async preview(path, signal) {
				return fetchBlob(`/api${base}/file?path=${encodeURIComponent(`/${path}`)}&preview=1`, signal);
			},
		};
	}, [nodeId]);
}

/**
 * Plans or starts a crha upgrade of nodes or node groups to crhs's version (doc/design/distribution.md
 * "crha self-upgrade"). A dry run fetches nothing; the real request starts one privileged task group per
 * architecture.
 */
export function useUpgradeNodes() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { targets: string[]; dryRun: boolean }) =>
			http.post<NodeUpgradeResponse>("/nodes/upgrade", body),
		onSuccess: (_data, body) => {
			if (!body.dryRun) void queryClient.invalidateQueries({ queryKey: nodeKeys.all });
		},
		meta: { toast: false },
	});
}
