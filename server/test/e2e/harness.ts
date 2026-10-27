import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { serve } from "@hono/node-server";
import { ModelConfig } from "../../src/agent/models.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { type AppOptions, createApp } from "../../src/api/app.ts";
import { Audit } from "../../src/audit/audit.ts";
import { LoginLimiter } from "../../src/auth/login-limiter.ts";
import { AgentServer } from "../../src/cluster/agent-server.ts";
import { Cluster, type ClusterOptions } from "../../src/cluster/cluster.ts";
import { loadServerIdentity, type ServerIdentity } from "../../src/cluster/identity.ts";
import { TaskGroups } from "../../src/cluster/task-groups.ts";
import { MasterKey } from "../../src/keys/master-key.ts";
import type { Db } from "../../src/storage/db.ts";
import { createUser } from "../../src/users/service.ts";
import { openTestDb } from "../helpers/db.ts";

const execFileAsync = promisify(execFile);
export const CLIENT_DIR = resolve(import.meta.dirname, "../../../client");

export async function goAvailable(): Promise<boolean> {
	try {
		await execFileAsync("go", ["version"]);
		return true;
	} catch {
		return false;
	}
}

export async function buildCrha(outDir: string): Promise<string> {
	const bin = join(outDir, "crha");
	await execFileAsync("go", ["build", "-o", bin, "./cmd/crha"], { cwd: CLIENT_DIR });
	return bin;
}

export async function waitFor<T>(
	what: string,
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	timeoutMs = 30_000,
	intervalMs = 100,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

export interface TaskJson {
	id: string;
	state: string;
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
}

/** crhs assembled the way runServer does, in this process, restartable on the same port and database. */
export class InProcessCrhs {
	readonly db: Db;
	readonly masterKey = MasterKey.generate();
	readonly clusterOptions: ClusterOptions;
	readonly appOptions: Partial<AppOptions>;
	identity!: ServerIdentity;
	cluster!: Cluster;
	audit!: Audit;
	port = 0;
	cookie = "";
	#agents!: AgentServer;
	#server?: ReturnType<typeof serve>;
	/** With `agentDir`: the agent runtime, on durable storage in that directory, with pi-ai's faux model. */
	readonly agentDir: string | undefined;
	readonly faux = fauxProvider();
	runtime: AgentRuntime | undefined;
	models: ModelConfig | undefined;

	private constructor(
		db: Db,
		clusterOptions: ClusterOptions,
		appOptions: Partial<AppOptions>,
		agentDir: string | undefined,
	) {
		this.db = db;
		this.clusterOptions = clusterOptions;
		this.appOptions = appOptions;
		this.agentDir = agentDir;
	}

	/**
	 * `appOptions` adds to the createApp options (e.g. webRoot for the WebUI tests); `agentDir` enables sessions
	 * (the faux model is `faux/<this.faux.getModel().id>`; script it with `this.faux.setResponses`).
	 */
	static async create(
		opts: ClusterOptions = {},
		appOptions: Partial<AppOptions> = {},
		agentDir?: string,
	): Promise<InProcessCrhs> {
		const crhs = new InProcessCrhs(await openTestDb("sqlite"), opts, appOptions, agentDir);
		crhs.identity = await loadServerIdentity(crhs.db, crhs.masterKey);
		await crhs.#listen(0);
		return crhs;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async #listen(port: number): Promise<void> {
		this.audit = new Audit(this.db);
		this.cluster = new Cluster(this.db, { ...this.clusterOptions, audit: this.audit });
		this.#agents = new AgentServer(this.db, this.identity, this.cluster, this.audit);
		const taskGroups = new TaskGroups(this.db, this.cluster, { audit: this.audit });
		let agent: AppOptions["agent"];
		if (this.agentDir) {
			this.models = new ModelConfig(this.db, this.masterKey);
			this.models.addProvider(this.faux.provider);
			await this.models.reload();
			this.runtime = await AgentRuntime.open({
				db: this.db,
				storage: await openNodeSqliteStorage(join(this.agentDir, "durable.sqlite"), { prefix: "pi_" }),
				models: this.models,
				cluster: this.cluster,
				groups: taskGroups,
				audit: this.audit,
			});
			agent = { runtime: this.runtime, models: this.models };
		}
		const app = createApp(this.db, {
			taskGroups,
			...(agent ? { agent } : {}),
			serverFingerprint: this.identity.fingerprint,
			serverPublicKey: this.identity.keyPair.publicKey,
			cluster: this.cluster,
			masterKey: this.masterKey,
			audit: this.audit,
			limiter: new LoginLimiter(),
			...this.appOptions,
		});
		const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
		server.on("upgrade", (req, socket, head) => {
			if (!this.#agents.handleUpgrade(req, socket, head)) socket.destroy();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			if (server.listening) resolve();
			else server.once("listening", () => resolve());
		});
		this.port = (server.address() as AddressInfo).port;
		this.#server = server;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		await this.runtime?.close();
		this.runtime = undefined;
		this.cluster.close();
		this.#agents.close();
		if (server) {
			// biome-ignore lint/suspicious/noExplicitAny: closeAllConnections exists on http.Server
			(server as any).closeAllConnections?.();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}

	/** Simulates a crhs restart: in-memory Cluster state is lost, the database and port are kept. */
	async restart(): Promise<void> {
		const port = this.port;
		await this.stop();
		await this.#listen(port);
	}

	async destroy(): Promise<void> {
		await this.stop();
		await this.db.destroy();
	}

	// biome-ignore lint/suspicious/noExplicitAny: test helper returns untyped JSON
	async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
		const headers: Record<string, string> = { cookie: this.cookie };
		if (init.body !== undefined) headers["content-type"] = "application/json";
		const res = await fetch(this.url + path, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : undefined };
	}

	async loginAdmin(): Promise<void> {
		await createUser(this.db, { username: "root", kind: "admin", password: "admin-password" });
		const res = await fetch(`${this.url}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "root", password: "admin-password" }),
		});
		const cookie = res.headers.get("set-cookie")?.match(/crh_session=([^;]+)/)?.[0];
		if (res.status !== 200 || !cookie) throw new Error(`login failed: ${res.status}`);
		this.cookie = cookie;
	}

	async enrollmentToken(): Promise<string> {
		const res = await this.api("/api/enrollment-tokens", { body: { nameHint: "e2e" } });
		if (res.status !== 201) throw new Error(`enrollment token: ${res.status}`);
		return res.json.token;
	}

	async runTask(nodeId: string, body: Record<string, unknown>, waitMs = 15_000): Promise<TaskJson> {
		const res = await this.api(`/api/nodes/${nodeId}/tasks`, { body: { waitMs, ...body } });
		if (res.status !== 201) throw new Error(`create task: ${res.status} ${JSON.stringify(res.json)}`);
		return res.json.task;
	}

	async getTask(id: string): Promise<TaskJson> {
		return (await this.api(`/api/tasks/${id}`)).json.task;
	}

	async waitTask(id: string, timeoutMs = 20_000): Promise<TaskJson> {
		return (await this.api(`/api/tasks/${id}/wait?timeoutMs=${timeoutMs}`)).json.task;
	}
}

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export function runCrha(bin: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

/** A whole environment: crhs, an enrolled and approved node, and a running crha child process. */
export class Env {
	dir = "";
	bin = "";
	crhs!: InProcessCrhs;
	configPath = "";
	nodeId = "";
	#crha?: ChildProcess;
	crhaLog = "";

	static async create(
		bin: string,
		dir: string,
		opts: ClusterOptions = {},
		appOptions: Partial<AppOptions> = {},
		{ agent = false }: { agent?: boolean } = {},
	): Promise<Env> {
		const env = new Env();
		env.bin = bin;
		env.dir = await mkdtemp(join(dir, "env-"));
		env.crhs = await InProcessCrhs.create(opts, appOptions, agent ? join(env.dir, "agent") : undefined);
		await env.crhs.loginAdmin();
		await writeFile(join(env.dir, "crha.toml"), `server = "${env.crhs.url}"\nstate_dir = "${join(env.dir, "crha")}"\n`);
		env.configPath = join(env.dir, "crha.toml");
		return env;
	}

	async enroll(): Promise<ExecResult> {
		return runCrha(this.bin, ["enroll", "--config", this.configPath, this.crhs.url, await this.crhs.enrollmentToken()]);
	}

	/** Enrolls, starts crha, approves the node and waits until it is connected. */
	async bringUp(): Promise<void> {
		const res = await this.enroll();
		if (res.code !== 0) throw new Error(`enroll failed: ${res.stdout}${res.stderr}`);
		this.startCrha();
		const node = await waitFor("pending node", async () => {
			const { json } = await this.crhs.api("/api/nodes");
			return json.nodes.find((n: { status: string }) => n.status === "pending");
		});
		this.nodeId = node.id;
		const approved = await this.crhs.api(`/api/nodes/${node.id}/approve`, { body: {} });
		if (approved.status !== 200) throw new Error(`approve: ${approved.status}`);
		await this.waitConnected();
	}

	waitConnected(timeoutMs = 30_000): Promise<true> {
		return waitFor("node connected", () => this.crhs.cluster.isConnected(this.nodeId) as true | false, timeoutMs);
	}

	waitDisconnected(timeoutMs = 30_000): Promise<true> {
		return waitFor("node disconnected", () => !this.crhs.cluster.isConnected(this.nodeId), timeoutMs);
	}

	startCrha(): ChildProcess {
		const child = spawn(this.bin, ["run", "--config", this.configPath], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (d) => {
			this.crhaLog += d;
		});
		child.stderr?.on("data", (d) => {
			this.crhaLog += d;
		});
		this.#crha = child;
		return child;
	}

	get crha(): ChildProcess | undefined {
		return this.#crha;
	}

	async killCrha(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
		const child = this.#crha;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((r) => child.once("exit", () => r()));
		child.kill(signal);
		await exited;
	}

	async destroy(): Promise<void> {
		if (this.#crha && this.#crha.exitCode === null) {
			this.#crha.kill("SIGCONT");
			await this.killCrha("SIGKILL");
		}
		await this.crhs?.destroy();
		await rm(this.dir, { recursive: true, force: true });
	}
}

/** Kills leftover processes (e.g. a `sleep` orphaned by SIGKILLing crha) by their unique command line. */
export async function pkill(pattern: string): Promise<void> {
	try {
		await execFileAsync("pkill", ["-f", pattern]);
	} catch {}
}
