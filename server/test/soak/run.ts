/**
 * Soak / resource test orchestrator.
 *
 * The parent builds the real crha binary and image, creates the podman nodes, samples crhs and the nodes, and writes
 * samples.csv + summary.md. The crhs runtime and the workload driver live in a child process, so the crhs RSS number
 * is "crhs + a thin driver"; the parent only orchestrates podman, samples and reports.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InProcessCrhs } from "../e2e/harness.ts";
import {
	buildStaticCrha,
	ensureImage,
	PrivilegedNode,
	podman,
	podmanAvailable,
	type TrustSpec,
} from "../system/privileged/harness.ts";
import type { ChildMessage, RuntimeStats, SoakNode } from "./ipc.ts";
import { decideExitCode, type WarningKind, WarningLog } from "./outcome.ts";
import { materializeOutDir, parseParams, SoakParamError, type SoakParams, usage } from "./params.ts";
import {
	capturePprofNode,
	createPprofSocketRoot,
	fetchHeapStats,
	openPprofSockets,
	PPROF_CONTAINER_DIR,
	type PprofCapture,
	type PprofNodeCapture,
	type PprofPaths,
	pprofEnv,
	preparePprofDir,
	removePprofSocketRoot,
} from "./pprof.ts";
import {
	csvHeader,
	csvRow,
	emptySample,
	type NodeSample,
	readCrhsDisk,
	readVmRssKb,
	type SampleRow,
	sampleNode,
} from "./sample.ts";
import { buildSummary } from "./summary.ts";

const CHILD_READY_TIMEOUT_MS = 180_000;
const CHILD_STARTED_TIMEOUT_MS = 300_000;
const STATS_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const NODE_SAMPLE_TIMEOUT_MS = 45_000;
/** Retries for the result-bearing requests (final stats, final pprof points) before calling them failures. */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	if (ms <= 0) return promise;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The crhs methods `PrivilegedNode` calls, over the child's real HTTP endpoints. */
class RemoteCrhs {
	readonly url: string;
	readonly cookie: string;

	constructor(url: string, cookie: string) {
		this.url = url;
		this.cookie = cookie;
	}

	async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
		const headers: Record<string, string> = { cookie: this.cookie };
		if (init.body !== undefined) headers["content-type"] = "application/json";
		const response = await fetch(this.url + path, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
		const text = await response.text();
		return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
	}

	async enrollmentToken(): Promise<string> {
		const response = await this.api("/api/enrollment-tokens", { body: { nameHint: "soak" } });
		const token = (response.json as { token?: string } | undefined)?.token;
		if (response.status !== 201 || !token) {
			throw new Error(`enrollment token: ${response.status} ${JSON.stringify(response.json)}`);
		}
		return token;
	}
}

interface NodeEntry {
	nodeId: string;
	container: string;
	/** PPROF=1 only: where this node's sockets and captured profiles live. */
	pprof?: PprofPaths;
}

function crhsPaths(params: SoakParams): { dbPath: string; durableDir: string } {
	return {
		dbPath: join(params.outDir, "crhs", "db", "crhs.sqlite"),
		durableDir: join(params.outDir, "crhs", "durable"),
	};
}

async function main(): Promise<number> {
	let parsed: ReturnType<typeof parseParams>;
	try {
		parsed = parseParams(process.argv.slice(2), process.env);
	} catch (err) {
		if (err instanceof SoakParamError) {
			console.error(`soak: ${err.message}`);
			console.error(usage());
			return 2;
		}
		throw err;
	}
	if (parsed.help || !parsed.params) {
		console.log(usage());
		return 0;
	}
	const params = await materializeOutDir(parsed.params);
	const samplesPath = join(params.outDir, "samples.csv");
	const summaryPath = join(params.outDir, "summary.md");
	const startedAt = new Date().toISOString();
	const errors: string[] = [];
	const recordError = (message: string): void => {
		if (!errors.includes(message)) {
			errors.push(message);
			console.error(`soak: ${message}`);
		}
	};
	const warnings = new WarningLog();
	const recordWarning = (kind: WarningKind, message: string): void => {
		warnings.add(kind, message);
		console.warn(`soak: warning (${kind}): ${message}`);
	};

	console.log(`soak: OUT_DIR ${params.outDir}`);
	console.log(
		`soak: ${params.sessions} sessions (${params.concurrency} concurrent) x ${params.turns} turns x ` +
			`${params.toolsPerTurn} tool calls on ${params.nodes} node(s), sample every ${params.sampleSeconds}s`,
	);
	await writeFile(join(params.outDir, "params.json"), `${JSON.stringify({ ...params, startedAt }, null, "\t")}\n`);
	await writeFile(samplesPath, csvHeader(params.nodes, params.pprof));

	if (process.env.CRH_TEST_PODMAN !== "1") {
		recordError("CRH_TEST_PODMAN=1 is required: the soak drives real crha containers with podman");
		return 1;
	}
	if (!podmanAvailable) {
		recordError("podman is not available (`podman version` failed); install podman and check its storage/runtime dirs");
		return 1;
	}

	let interrupted = false;
	const interrupt = deferred<never>();
	interrupt.promise.catch(() => {});
	const onSignal = (signal: NodeJS.Signals): void => {
		if (interrupted) return;
		interrupted = true;
		console.error(`soak: ${signal} received; cleaning up`);
		interrupt.reject(new Error(`interrupted by ${signal}`));
	};
	const onSigint = (): void => onSignal("SIGINT");
	const onSigterm = (): void => onSignal("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	const raceInterrupt = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupt.promise]);

	let child: ChildProcess | undefined;
	const childLog = createWriteStream(join(params.outDir, "child.log"), { flags: "a" });
	const nodes: NodeEntry[] = [];
	const samples: SampleRow[] = [];
	let finalStats: RuntimeStats | undefined;
	let childStopped = false;
	let sampling = true;
	let samplingNow = false;
	let samplingTimer: NodeJS.Timeout | undefined;
	let workloadStart = performance.now();
	let workloadStarted = false;
	let workloadFinished = false;
	let lastStats: RuntimeStats | undefined;
	let statsSequence = 0;
	const pendingStats = new Map<
		number,
		{ resolve: (stats: RuntimeStats) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	const ready = deferred<Extract<ChildMessage, { type: "ready" }>>();
	const started = deferred<Extract<ChildMessage, { type: "started" }>>();
	const finished = deferred<Extract<ChildMessage, { type: "finished" }>>();
	const stopped = deferred<void>();
	const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
	ready.promise.catch(() => {});
	started.promise.catch(() => {});
	finished.promise.catch(() => {});
	stopped.promise.catch(() => {});
	exited.promise.catch(() => {});

	const paths = crhsPaths(params);
	let bin = "";
	/** PPROF=1 only: the short per-run root of the debug sockets (created before any container). */
	let pprofSocketRoot: string | undefined;
	const totalToolCalls = params.sessions * params.turns * params.toolsPerTurn;
	const capturedPprofPoints = new Set<number>();
	const pprofCaptures: PprofCapture[] = [];

	// capturePprofPoint takes one heap point for every node. A node that fails aborts this attempt;
	// the caller decides whether that is a warning (the next sample retries) or a failure (the final
	// forced capture gave up). Successful nodes write their files again on the next attempt.
	const capturePprofPoint = async (point: number, toolCallsDone: number): Promise<void> => {
		const capturedNodes: PprofNodeCapture[] = [];
		const failures: string[] = [];
		for (let index = 0; index < nodes.length; index++) {
			const entry = nodes[index];
			if (!entry?.pprof) continue;
			try {
				capturedNodes.push(
					await withTimeout(
						capturePprofNode({
							paths: entry.pprof,
							nodeIndex: index,
							container: entry.container,
							point,
						}),
						NODE_SAMPLE_TIMEOUT_MS * 2,
						"pprof capture",
					),
				);
			} catch (err) {
				failures.push(`node ${index + 1} (${entry.container}): ${(err as Error).message}`);
			}
		}
		if (failures.length > 0) throw new Error(failures.join("; "));
		if (capturedNodes.length === 0) return;
		capturedPprofPoints.add(point);
		pprofCaptures.push({ point, toolCallsDone, at: new Date().toISOString(), nodes: capturedNodes });
		console.log(
			`soak: pprof ${Math.round(point * 100)}% captured for ${capturedNodes.length} node(s) ` +
				`at ${toolCallsDone} tool calls`,
		);
	};

	// During the run, capture every point whose fraction the workload has reached. A failed periodic
	// attempt is a warning and leaves the point for the next sample. At the end (force), retry every
	// missing point; one that still fails is a failure because the requested profile is missing.
	const maybeCapturePprof = async (toolCallsDone: number, force: boolean, final: boolean): Promise<void> => {
		if (!params.pprof) return;
		const fraction = totalToolCalls > 0 ? toolCallsDone / totalToolCalls : 0;
		for (const point of params.pprofPoints) {
			if (capturedPprofPoints.has(point)) continue;
			if (!force && fraction + 1e-9 < point) continue;
			const attempts = final ? RETRY_ATTEMPTS : 1;
			let lastError: Error | undefined;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				try {
					await capturePprofPoint(point, toolCallsDone);
					lastError = undefined;
					break;
				} catch (err) {
					lastError = err as Error;
					if (attempt < attempts) await delay(RETRY_DELAY_MS);
				}
			}
			if (capturedPprofPoints.has(point)) continue;
			const label = `pprof at ${Math.round(point * 100)}%`;
			const detail = lastError?.message ?? "not captured";
			if (final) recordError(`${label}: ${detail}`);
			else recordWarning("pprof capture", `${label}: ${detail}`);
		}
	};

	const askStats = async (): Promise<RuntimeStats | undefined> => {
		const current = child;
		if (!current || current.exitCode !== null || current.signalCode !== null) return undefined;
		const id = ++statsSequence;
		const result = deferred<RuntimeStats>();
		const timer = setTimeout(() => {
			pendingStats.delete(id);
			result.reject(new Error("stats request timed out"));
		}, STATS_TIMEOUT_MS);
		pendingStats.set(id, { resolve: result.resolve, reject: result.reject, timer });
		try {
			current.send({ type: "stats", id });
		} catch (err) {
			clearTimeout(timer);
			pendingStats.delete(id);
			result.reject(err as Error);
		}
		return result.promise;
	};

	const sampleOnce = async (final = false): Promise<void> => {
		if (samplingNow) return;
		samplingNow = true;
		try {
			let stats: RuntimeStats | undefined;
			let statsError: Error | undefined;
			const statsAttempts = final ? RETRY_ATTEMPTS : 1;
			for (let attempt = 1; attempt <= statsAttempts; attempt++) {
				try {
					stats = await askStats();
					if (stats) break;
					statsError = new Error("the crhs child is not running");
				} catch (err) {
					statsError = err as Error;
				}
				if (attempt < statsAttempts) await delay(RETRY_DELAY_MS);
			}
			if (!stats) {
				if (final) {
					// The final numbers are the result: stats still missing after the retries is a failure.
					recordError(`final stats: ${statsError?.message ?? "not available"}`);
				} else {
					// A periodic sample without stats is skipped: no CSV row, one warning, keep going.
					recordWarning("stats sample", statsError?.message ?? "stats not available");
					return;
				}
			} else {
				lastStats = stats;
			}
			const effective = stats ?? lastStats;
			const disk = await readCrhsDisk(paths.dbPath, paths.durableDir);
			const rssKb = child?.pid ? await readVmRssKb(child.pid) : 0;
			const nodeSamples: (NodeSample | undefined)[] = [];
			for (const entry of nodes) {
				try {
					nodeSamples.push(await withTimeout(sampleNode(entry.container), NODE_SAMPLE_TIMEOUT_MS, "node sample"));
				} catch (err) {
					// One node's exec/du/ps hiccup leaves that node's columns empty; the sample still counts.
					recordWarning("node sample", `node ${entry.container}: ${(err as Error).message}`);
					nodeSamples.push(undefined);
				}
			}
			if (params.pprof) {
				// Cheap per-sample MemStats fetch (no gc, no profile file). A failure leaves that
				// node's heap columns empty for this row and is only a warning.
				for (let index = 0; index < nodes.length; index++) {
					const entry = nodes[index];
					const nodeSample = nodeSamples[index];
					if (!entry?.pprof || !nodeSample) continue;
					try {
						nodeSample.heapRun = await fetchHeapStats(entry.pprof.runSocket);
						nodeSample.heapPriv = await fetchHeapStats(entry.pprof.privSocket);
					} catch (err) {
						recordWarning("pprof sample", `node ${entry.container}: ${(err as Error).message}`);
					}
				}
			}
			const fallback = emptySample(new Date().toISOString(), (performance.now() - workloadStart) / 1000, params.nodes);
			const row: SampleRow = {
				...fallback,
				time: new Date().toISOString(),
				elapsedS: (performance.now() - workloadStart) / 1000,
				turnsDone: effective?.turnsDone ?? 0,
				toolCallsDone: effective?.toolCallsDone ?? 0,
				tasksFailed: effective?.tasksFailed ?? 0,
				crhsRssKb: rssKb,
				crhsHeapUsedKb: effective ? Math.round(effective.heapUsedBytes / 1024) : 0,
				crhsDbBytes: disk.dbBytes,
				crhsDbWalBytes: disk.walBytes,
				durableDirBytes: disk.durableDirBytes,
				sessionsCount: effective?.sessions ?? 0,
				tasksCount: effective?.tasks ?? 0,
				auditEventsCount: effective?.auditEvents ?? 0,
				piEntriesCount: effective?.piEntries ?? 0,
				compactions: effective?.compactions ?? 0,
				turnP50Ms: effective?.turnP50Ms ?? null,
				turnP95Ms: effective?.turnP95Ms ?? null,
				nodes: nodeSamples,
			};
			samples.push(row);
			await appendFile(samplesPath, csvRow(row, params.pprof));
			await maybeCapturePprof(effective?.toolCallsDone ?? 0, false, false);
			console.log(
				`sample ${String(samples.length).padStart(2)} t=${row.elapsedS.toFixed(0)}s turns=${row.turnsDone} ` +
					`tools=${row.toolCallsDone} rss=${Math.round(row.crhsRssKb / 1024)}MiB ` +
					`db=${(row.crhsDbBytes / 1024 ** 2).toFixed(1)}MiB tasks=${row.tasksCount} failed=${row.tasksFailed}`,
			);
		} catch (err) {
			// A periodic sample must never fail the run; the final sample is the result and must.
			if (final) recordError(`final sample: ${(err as Error).message}`);
			else recordWarning("sample", (err as Error).message);
		} finally {
			samplingNow = false;
		}
	};

	const scheduleSampling = (): void => {
		if (!sampling) return;
		samplingTimer = setTimeout(() => {
			void sampleOnce().then(scheduleSampling);
		}, params.sampleSeconds * 1000);
	};

	const stopSampling = (): void => {
		sampling = false;
		if (samplingTimer) clearTimeout(samplingTimer);
		samplingTimer = undefined;
	};

	const stopChild = async (): Promise<void> => {
		const current = child;
		if (!current) return;
		if (childStopped) return;
		childStopped = true;
		try {
			if (current.exitCode === null && current.signalCode === null) {
				current.send(interrupted ? { type: "abort", reason: "SIGINT" } : { type: "shutdown" });
				await withTimeout(stopped.promise, SHUTDOWN_TIMEOUT_MS, "child shutdown").catch((err: unknown) => {
					recordError((err as Error).message);
					current.kill("SIGKILL");
				});
			}
		} catch (err) {
			recordError(`stopping the crhs child: ${(err as Error).message}`);
			current.kill("SIGKILL");
		}
		await withTimeout(exited.promise, 10_000, "child exit").catch(() => {
			current.kill("SIGKILL");
		});
	};

	// `PrivilegedNode.destroy()` ignores podman's exit code; teardown wants a real error to report as a warning.
	const removeContainers = async (names: string[]): Promise<void> => {
		const removed = await podman(["rm", "-f", ...names]);
		if (removed.code !== 0) {
			throw new Error(`podman rm failed (${removed.code}): ${removed.stderr.trim() || removed.stdout.trim()}`);
		}
	};
	const leftoverContainers = async (): Promise<string[]> => {
		const list = await podman(["ps", "-a", "--format", "{{.Names}}", "--filter", `name=crh-priv-${process.pid}-`]);
		if (list.code !== 0) {
			throw new Error(`podman ps failed (${list.code}): ${list.stderr.trim() || list.stdout.trim()}`);
		}
		return list.stdout
			.split("\n")
			.map((name) => name.trim())
			.filter((name) => name !== "");
	};

	try {
		if (params.pprof) {
			// Created and length-checked before the image build and any container: a socket path that
			// does not fit must fail the run immediately, not as connect EINVAL at the first capture.
			pprofSocketRoot = await createPprofSocketRoot(params.nodes);
			console.log(`soak: pprof sockets under ${pprofSocketRoot}`);
		}
		await mkdir(join(params.outDir, "bin"), { recursive: true });
		console.log("soak: building static crha");
		bin = await buildStaticCrha(join(params.outDir, "bin"), params.pprof ? { tags: ["pprof"] } : {});
		console.log(`soak: crha at ${bin}${params.pprof ? " (pprof debug build)" : ""}`);
		console.log("soak: ensuring the podman image (the first run builds it)");
		const image = await ensureImage();
		console.log(`soak: image ${image}`);
		if (interrupted) throw new Error("interrupted");

		const childPath = join(import.meta.dirname, "child.ts");
		child = spawn(process.execPath, [childPath], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: { ...process.env, SOAK_PARAMS: JSON.stringify(params) },
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			childLog.write(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			childLog.write(chunk);
		});
		child.on("message", (message: ChildMessage) => {
			switch (message.type) {
				case "ready":
					ready.resolve(message);
					break;
				case "started":
					started.resolve(message);
					break;
				case "stats": {
					const pending = pendingStats.get(message.id);
					if (!pending) break;
					clearTimeout(pending.timer);
					pendingStats.delete(message.id);
					pending.resolve(message.stats);
					break;
				}
				case "finished":
					workloadFinished = true;
					finished.resolve(message);
					break;
				case "stopped":
					stopped.resolve();
					break;
				case "log":
					console.log(`[crhs] ${message.message}`);
					break;
				case "error": {
					recordError(`crhs child: ${message.message}`);
					const failure = new Error(message.message);
					ready.reject(failure);
					started.reject(failure);
					finished.reject(failure);
					for (const pending of pendingStats.values()) {
						clearTimeout(pending.timer);
						pending.reject(failure);
					}
					pendingStats.clear();
					break;
				}
			}
		});
		child.on("exit", (code, signal) => {
			exited.resolve({ code, signal });
			if (!childStopped) {
				// The rejected promise wakes whichever wait is active; the finally block reports and cleans up.
				if (workloadFinished) {
					// The workload promise already resolved, so no rejection will report a crash after it.
					recordError(`crhs child exited after finishing (code ${code}, signal ${signal})`);
				}
				finished.reject(new Error(`crhs child exited before finishing (code ${code}, signal ${signal})`));
				started.reject(new Error(`crhs child exited (code ${code}, signal ${signal})`));
				ready.reject(new Error(`crhs child exited (code ${code}, signal ${signal})`));
			}
			for (const pending of pendingStats.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("crhs child exited"));
			}
			pendingStats.clear();
		});

		const readyMessage = await raceInterrupt(withTimeout(ready.promise, CHILD_READY_TIMEOUT_MS, "crhs child ready"));
		console.log(`soak: crhs up at ${readyMessage.url}`);
		const remote = new RemoteCrhs(readyMessage.url, readyMessage.cookie);
		const crhsFacade = remote as unknown as InProcessCrhs;
		const keyResponse = await remote.api("/api/privilege/crhs-key");
		const crhsKey = (keyResponse.json as { key?: { authorizedKey?: string } } | undefined)?.key?.authorizedKey;
		if (!crhsKey) throw new Error("could not read crhs's authorization signing key");
		const trust: TrustSpec = {
			name: "soak-crhs",
			role: "crhs",
			format: "sshsig",
			key: crhsKey,
			kinds: ["execute"],
			requireExact: true,
			allow: [{ method: "exec" }, { method: "file.read" }, { method: "file.write" }],
		};

		for (let index = 0; index < params.nodes; index++) {
			if (interrupted) throw new Error("interrupted");
			console.log(`soak: creating node ${index + 1}/${params.nodes}`);
			let pprof: PprofPaths | undefined;
			if (pprofSocketRoot) {
				pprof = await preparePprofDir(params.outDir, pprofSocketRoot, index);
				console.log(`soak: pprof profiles in ${pprof.hostDir}, sockets in ${pprof.socketDir}`);
			}
			// Not raced against the interrupt: a create that is already running must finish so its container can be
			// added to `nodes` and removed by the cleanup below.
			const node = await PrivilegedNode.create({
				bin,
				crhs: crhsFacade,
				mode: "forward",
				trust: [trust],
				ssh: false,
				...(pprof
					? {
							env: pprofEnv(),
							mounts: [{ source: pprof.socketDir, destination: PPROF_CONTAINER_DIR }],
						}
					: {}),
			});
			nodes.push({ nodeId: node.nodeId, container: node.name, pprof });
			// Make the debug sockets connectable from the host; a failure here must still leave the
			// container in `nodes` so the finally block removes it.
			if (pprof) await openPprofSockets(node, pprof);
			console.log(`soak: node ${index + 1} up as ${node.nodeId} (${node.name})`);
			if (interrupted) throw new Error("interrupted");
		}

		const childNodes: SoakNode[] = nodes.map((entry) => ({ nodeId: entry.nodeId, container: entry.container }));
		child.send({ type: "nodes", nodes: childNodes });
		const startedMessage = await raceInterrupt(
			withTimeout(started.promise, CHILD_STARTED_TIMEOUT_MS, "workload start"),
		);
		workloadStart = performance.now();
		workloadStarted = true;
		console.log(
			`soak: workload started: ${startedMessage.sessions} sessions, ${startedMessage.turns} turns, ` +
				`${startedMessage.toolCalls} tool calls`,
		);
		await sampleOnce();
		scheduleSampling();

		const finishedMessage = await raceInterrupt(finished.promise);
		finalStats = finishedMessage.stats;
		console.log(
			`soak: workload finished: ${finalStats.turnsDone} turns, ${finalStats.toolCallsDone} tool calls, ` +
				`${finalStats.failures.length} failure(s)`,
		);
	} catch (err) {
		recordError((err as Error).message);
	} finally {
		stopSampling();
		while (samplingNow) await new Promise((resolve) => setTimeout(resolve, 50));
		// The final sample is the result: its stats request gets retries and its failure is a real failure.
		if (workloadStarted) await sampleOnce(true);
		if (params.pprof && workloadStarted) {
			// Anything the sampler did not reach: point 1.0 must exist after the workload finishes,
			// before the containers are torn down. Runs while they are still alive. A point that still
			// fails after the retries is a failure, not a warning.
			try {
				await maybeCapturePprof(finalStats?.toolCallsDone ?? lastStats?.toolCallsDone ?? 0, true, true);
			} catch (err) {
				recordError(`pprof final capture: ${(err as Error).message}`);
			}
		}
		await stopChild();
		finalStats ??= lastStats;
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);

		// Teardown happens before the summary is written so container-removal warnings are included.
		for (const entry of nodes) {
			try {
				await removeContainers([entry.container]);
				console.log(`soak: removed container ${entry.container}`);
			} catch (err) {
				recordWarning("container removal", `${entry.container}: ${(err as Error).message}`);
			}
		}
		// A container whose creation was interrupted may not have reached `nodes`; remove by the fixture prefix.
		try {
			const leftovers = await leftoverContainers();
			if (leftovers.length > 0) {
				await removeContainers(leftovers);
				console.log(`soak: removed leftover container(s): ${leftovers.join(", ")}`);
			}
		} catch (err) {
			recordWarning("leftover cleanup", (err as Error).message);
		}
		// The short-lived socket root goes away with the containers. A failure is only a warning: the
		// directory is a leftover, not a result.
		if (pprofSocketRoot) {
			try {
				await removePprofSocketRoot(pprofSocketRoot);
				console.log(`soak: removed pprof socket directory ${pprofSocketRoot}`);
			} catch (err) {
				recordWarning("pprof socket cleanup", `${pprofSocketRoot}: ${(err as Error).message}`);
			}
		}

		const summary = buildSummary({
			params,
			samples,
			stats: finalStats,
			nodes: nodes.map((entry) => ({ nodeId: entry.nodeId, container: entry.container })),
			startedAt,
			errors,
			warnings: warnings.snapshot(),
			interrupted,
			pprof: params.pprof
				? { points: params.pprofPoints, captures: pprofCaptures, socketDir: pprofSocketRoot }
				: undefined,
		});
		try {
			await writeFile(summaryPath, summary);
			console.log(`soak: summary written to ${summaryPath}`);
			console.log(`soak: ${samples.length} sample(s) in ${samplesPath}`);
			if (warnings.total > 0) {
				console.log(`soak: ${warnings.total} warning(s) in ${warnings.snapshot().length} kind(s); see ${summaryPath}`);
			}
		} catch (err) {
			recordError(`writing summary: ${(err as Error).message}`);
		}
		await new Promise<void>((resolve) => childLog.end(resolve));
	}

	for (const pending of pendingStats.values()) clearTimeout(pending.timer);
	const failures = (finalStats?.failures.length ?? 0) + (finalStats?.tasksFailed ?? 0);
	return decideExitCode({ interrupted, errors, workloadFailures: failures, warnings: warnings.total });
}

main()
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		console.error("soak: fatal:", err);
		process.exit(1);
	});
