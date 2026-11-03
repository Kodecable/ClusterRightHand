/**
 * Debug-only Go pprof collection for the soak run (PPROF=1).
 *
 * The debug crha binary serves /debug/pprof/heap on one unix socket per process. The sockets live
 * in a short per-run host directory (a `crh-pp-*` mkdtemp under os.tmpdir()) that is bind-mounted at
 * PPROF_CONTAINER_DIR, so the parent talks to them with Node's http.get({ socketPath }) and never
 * needs curl or podman exec for the capture itself.
 *
 * The sockets deliberately do not live under OUT_DIR: a unix socket's host path must fit in
 * sun_path (108 bytes on Linux, including the NUL), and OUT_DIR can be arbitrarily long. The
 * profile files themselves still go to OUT_DIR/pprof/node-N.
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PrivilegedNode, podman } from "../system/privileged/harness.ts";
import { type HeapStats, sampleNode } from "./sample.ts";

/** Container path of the per-node bind mount. Both the fixture's process control and this file use it. */
export const PPROF_CONTAINER_DIR = "/pprof";

/**
 * Host socket paths must stay shorter than this. Linux's sun_path is 108 bytes including the
 * terminating NUL; the 104-byte budget leaves room for the kernel's own copy and a future reconnect.
 */
export const PPROF_SOCKET_PATH_MAX_BYTES = 104;

export interface PprofNodeCapture {
	nodeIndex: number;
	container: string;
	run: HeapStats;
	priv: HeapStats;
	rssRunKb: number;
	rssPrivKb: number;
}

export interface PprofCapture {
	/** Fraction of the total tool calls this capture represents. */
	point: number;
	/** Tool calls reported by crhs when the capture was taken. */
	toolCallsDone: number;
	at: string;
	nodes: PprofNodeCapture[];
}

/** The file name stem of a capture point: 0.1 -> "10", 1 -> "100". */
export function pointLabel(point: number): string {
	return String(Math.round(point * 100));
}

export interface PprofPaths {
	/** Profile files (*.pb.gz, *.txt) of this node, under OUT_DIR; the host parent writes them, nothing mounts it. */
	hostDir: string;
	/** Short directory of this node's debug sockets; bind-mounted at PPROF_CONTAINER_DIR. */
	socketDir: string;
	runSocket: string;
	privSocket: string;
}

/** Host socket paths of one node below the per-run root. One helper so paths and lengths never diverge. */
function socketPaths(socketRoot: string, nodeIndex: number): [runSocket: string, privSocket: string] {
	const socketDir = resolve(join(socketRoot, `node-${nodeIndex + 1}`));
	return [join(socketDir, "run.sock"), join(socketDir, "priv.sock")];
}

/** The longest of all host socket paths the run will use; the setup check reports this one. */
function longestSocketPath(socketRoot: string, nodes: number): string {
	let longest = "";
	for (let index = 0; index < nodes; index++) {
		for (const socketPath of socketPaths(socketRoot, index)) {
			if (Buffer.byteLength(socketPath, "utf8") > Buffer.byteLength(longest, "utf8")) longest = socketPath;
		}
	}
	return longest;
}

/**
 * Creates the per-run root of the debug sockets under os.tmpdir() and checks that every node's
 * socket path fits in sun_path.
 *
 * The root is per run (not per node) so teardown removes one directory. The check runs before any
 * container exists: a path that does not fit would otherwise only surface as `connect EINVAL` at the
 * first capture, late in a long run.
 */
export async function createPprofSocketRoot(nodes: number): Promise<string> {
	const prefix = resolve(join(tmpdir(), "crh-pp-"));
	// mkdtemp appends six random characters, so this placeholder has the same length as the real root.
	const longest = longestSocketPath(`${prefix}XXXXXX`, nodes);
	const bytes = Buffer.byteLength(longest, "utf8");
	if (bytes >= PPROF_SOCKET_PATH_MAX_BYTES) {
		throw new Error(
			`pprof socket path is ${bytes} bytes; every host socket path must be shorter than ` +
				`${PPROF_SOCKET_PATH_MAX_BYTES} bytes (Linux sun_path is 108 bytes including the NUL): ${longest}; ` +
				"point TMPDIR at a shorter directory",
		);
	}
	return mkdtemp(prefix);
}

/** The profile file directory (OUT_DIR/pprof/node-N, 1-based) and this node's two socket paths. */
export function pprofPaths(outDir: string, socketRoot: string, nodeIndex: number): PprofPaths {
	const [runSocket, privSocket] = socketPaths(socketRoot, nodeIndex);
	return {
		hostDir: resolve(join(outDir, "pprof", `node-${nodeIndex + 1}`)),
		socketDir: resolve(join(socketRoot, `node-${nodeIndex + 1}`)),
		runSocket,
		privSocket,
	};
}

/**
 * Creates this node's profile file directory under OUT_DIR and its socket directory under the short
 * per-run root.
 *
 * crha run runs as uid 998 inside the container. Rootless podman maps container root to the host user
 * but uid 998 to a subordinate uid, so the socket directory must be world-writable for that process to
 * create its socket, and it is the only directory bind-mounted into the container. OUT_DIR stays
 * private, including the file directory the host parent writes the captured profiles into.
 */
export async function preparePprofDir(outDir: string, socketRoot: string, nodeIndex: number): Promise<PprofPaths> {
	const paths = pprofPaths(outDir, socketRoot, nodeIndex);
	await mkdir(paths.hostDir, { recursive: true });
	await mkdir(paths.socketDir, { recursive: true });
	await chmod(paths.socketDir, 0o777);
	return paths;
}

/** Removes the per-run socket root at teardown. Best effort: the caller reports a failure as a warning. */
export async function removePprofSocketRoot(socketRoot: string): Promise<void> {
	await rm(socketRoot, { recursive: true, force: true });
}

/** The container environment privctl.sh appends to the commands it starts. */
export function pprofEnv(): Record<string, string> {
	return {
		CRHA_RUN_ARGS: `--pprof-listen unix:${PPROF_CONTAINER_DIR}/run.sock`,
		CRHA_PRIV_ARGS: `--pprof-listen unix:${PPROF_CONTAINER_DIR}/priv.sock`,
	};
}

/**
 * crha chmods both sockets 0600. For the privileged process that is fine (container root maps to
 * the host user), but the non-privileged process runs as uid 998, which rootless podman maps to a
 * subordinate host uid the parent does not own. Widening the sockets from inside the container
 * keeps the host parent able to connect without changing what crha does. They are debug sockets in
 * the short-lived crh-pp-* directory, which is removed at teardown.
 */
export async function openPprofSockets(node: PrivilegedNode, paths: PprofPaths, timeoutMs = 60_000): Promise<void> {
	await waitForSockets(paths, timeoutMs);
	const result = await podman([
		"exec",
		"--user",
		"0",
		node.name,
		"chmod",
		"0666",
		`${PPROF_CONTAINER_DIR}/run.sock`,
		`${PPROF_CONTAINER_DIR}/priv.sock`,
	]);
	if (result.code !== 0) {
		throw new Error(
			`widening pprof sockets in ${node.name} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
}

async function waitForSockets(paths: PprofPaths, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		last = "";
		let open = true;
		for (const socketPath of [paths.runSocket, paths.privSocket]) {
			try {
				const info = await stat(socketPath);
				if (!info.isSocket()) {
					last = `${socketPath} is not a socket`;
					open = false;
				}
			} catch {
				last = `${socketPath} does not exist`;
				open = false;
			}
		}
		if (open) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`pprof sockets did not appear within ${timeoutMs} ms (${last}); is this a -tags pprof build?`);
}

/** One GET over a unix socket: Node's http client supports socketPath directly. */
export function getOverSocket(socketPath: string, path: string, timeoutMs = 60_000): Promise<Buffer> {
	return new Promise((done, fail) => {
		const request = get({ socketPath, path, agent: false, timeout: timeoutMs }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", fail);
			response.on("end", () => {
				const body = Buffer.concat(chunks);
				if (response.statusCode !== 200) {
					fail(new Error(`GET ${path} over ${socketPath}: HTTP ${response.statusCode}`));
					return;
				}
				done(body);
			});
		});
		request.on("timeout", () => request.destroy(new Error(`GET ${path} over ${socketPath} timed out`)));
		request.on("error", fail);
	});
}

/**
 * Fetches /debug/pprof/heap?gc=1 and discards it: the handler runs a garbage collection, so the
 * next heap profile (and its debug=1 MemStats) reflects live objects instead of garbage.
 */
export async function forceGC(socketPath: string): Promise<void> {
	await getOverSocket(socketPath, "/debug/pprof/heap?gc=1");
}

/**
 * Reads the debug=1 heap text and extracts the runtime.MemStats fields the summary reports.
 * The text profile ends with a "# runtime.MemStats" block; the profile part before it is ignored.
 */
export function parseHeapText(text: string): HeapStats {
	const fields: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const match = /^# (HeapAlloc|HeapInuse|HeapReleased|HeapSys|Sys|Alloc) = (\d+)/.exec(line);
		if (match?.[1] && match[2] !== undefined) fields[match[1]] = Number(match[2]);
	}
	for (const field of ["HeapAlloc", "HeapInuse", "HeapReleased", "Sys"]) {
		if (fields[field] === undefined) throw new Error(`heap profile text has no "# ${field} = n" line`);
	}
	const toKb = (bytes: number | undefined): number => Math.round((bytes ?? 0) / 1024);
	return {
		allocKb: toKb(fields.HeapAlloc),
		inuseKb: toKb(fields.HeapInuse),
		releasedKb: toKb(fields.HeapReleased),
		sysKb: toKb(fields.Sys),
	};
}

/** Cheap per-sample MemStats fetch: no gc request, no profile file. */
export async function fetchHeapStats(socketPath: string): Promise<HeapStats> {
	return parseHeapText((await getOverSocket(socketPath, "/debug/pprof/heap?debug=1", 20_000)).toString("utf8"));
}

/**
 * Captures one pprof point for one node and both processes: a GC-requested binary heap profile
 * (*.pb.gz, usable with `go tool pprof -base`), the debug=1 text profile (*.txt) and the process
 * RSS at the same moment.
 */
export async function capturePprofNode(input: {
	paths: PprofPaths;
	nodeIndex: number;
	container: string;
	point: number;
}): Promise<PprofNodeCapture> {
	const label = pointLabel(input.point);
	const capture = async (process: "run" | "priv", socketPath: string): Promise<HeapStats> => {
		await forceGC(socketPath);
		const binary = await getOverSocket(socketPath, "/debug/pprof/heap");
		await writeFile(join(input.paths.hostDir, `${process}-heap-${label}.pb.gz`), binary);
		const text = (await getOverSocket(socketPath, "/debug/pprof/heap?debug=1")).toString("utf8");
		await writeFile(join(input.paths.hostDir, `${process}-heap-${label}.txt`), text);
		return parseHeapText(text);
	};
	const [run, priv, rss] = await Promise.all([
		capture("run", input.paths.runSocket),
		capture("priv", input.paths.privSocket),
		sampleNode(input.container),
	]);
	return {
		nodeIndex: input.nodeIndex,
		container: input.container,
		run,
		priv,
		rssRunKb: rss.rssRunKb,
		rssPrivKb: rss.rssPrivKb,
	};
}
