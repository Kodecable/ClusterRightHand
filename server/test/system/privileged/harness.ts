/**
 * The podman fixture of the privileged system suite (doc/testing/privileged.md).
 *
 * One container is one node: a real `crha privileged run` as root on /run/crha/privileged.sock, a real
 * `crha run` as uid 998 crha, and an sshd on 127.0.0.1:2222. The crhs side is the in-process server of
 * ../e2e/harness.ts, so both ends are the real code with no test doubles in between.
 *
 * Everything that is not the image (the crha binary, the per-test configuration, the SSH keys) is
 * bind-mounted from the host. The tests write the configuration, enroll the node and approve it; the
 * container's entrypoint only starts the three processes once /etc/crha/.ready exists.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type InProcessCrhs, type TaskJson, waitFor } from "../../e2e/harness.ts";

const execFileAsync = promisify(execFile);

export const SUITE_DIR = resolve(import.meta.dirname);
export const CLIENT_DIR = resolve(SUITE_DIR, "../../../../client");
/** Path of crha inside the container; the sudoers and doas rules name it. */
export const CONTAINER_CRHA = "/usr/local/bin/crha";
export const PRIV_SOCKET = "/run/crha/privileged.sock";
export const UNPRIVILEGED_UID = 998;

const PODMAN = process.env.CRH_PODMAN ?? "podman";

/** Whether `CRH_TEST_PODMAN=1` is set and podman answers; every suite skips otherwise. */
export const podmanAvailable = await podmanWorks();

async function podmanWorks(): Promise<boolean> {
	if (process.env.CRH_TEST_PODMAN !== "1") return false;
	try {
		await execFileAsync(PODMAN, ["version", "--format", "{{.Version}}"], { timeout: 20_000 });
		return true;
	} catch {
		return false;
	}
}

/** A port that is currently free on the host, for the container's sshd. */
export async function freePort(): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

export async function podman(args: string[], opts: { timeout?: number } = {}): Promise<ExecResult> {
	return run(PODMAN, args, opts);
}

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<ExecResult> {
	return new Promise((complete) => {
		execFile(cmd, args, { timeout: opts.timeout ?? 120_000, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
			const code = err
				? typeof (err as { code?: unknown }).code === "number"
					? (err as { code: number }).code
					: 1
				: 0;
			complete({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/**
 * Builds a static crha on the host (the image never compiles Go). `GOCACHE` is passed through when
 * the environment sets it; otherwise Go's own cache is used.
 */
export async function buildStaticCrha(outDir: string): Promise<string> {
	const bin = join(outDir, "crha");
	await new Promise<void>((done, fail) => {
		const child = spawn("go", ["build", "-o", bin, "./cmd/crha"], {
			cwd: CLIENT_DIR,
			env: { ...process.env, CGO_ENABLED: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		child.stdout?.on("data", (d) => {
			log += d;
		});
		child.stderr?.on("data", (d) => {
			log += d;
		});
		child.on("error", fail);
		child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`go build failed (${code}): ${log}`))));
	});
	return bin;
}

/**
 * The image tag is the hash of everything baked into it, so an edit rebuilds once and stale images
 * are never reused. The image itself is left in the local store afterwards (the brief asks for that).
 */
export async function ensureImage(): Promise<string> {
	const files = ["Containerfile", "entrypoint.sh", "privctl.sh", "fixtures/sshd_config"];
	const hash = createHash("sha256");
	for (const name of files) hash.update(await readFile(join(SUITE_DIR, name)));
	const tag = `crh-privileged-system:${hash.digest("hex").slice(0, 12)}`;
	const exists = await podman(["image", "exists", tag]);
	if (exists.code === 0) return tag;
	const build = await podman(["build", "-t", tag, "-f", join(SUITE_DIR, "Containerfile"), SUITE_DIR], {
		timeout: 15 * 60_000,
	});
	if (build.code !== 0) throw new Error(`podman build ${tag} failed:\n${build.stdout}\n${build.stderr}`);
	return tag;
}

/** Parses the output of `/usr/bin/env` into a map, for the constructed-environment assertions. */
export function parseEnv(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return env;
}

/** Copies a public key line into the container's authorized_keys (read by sshd per connection). */
export function sshKeygen(path: string): Promise<void> {
	return execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]).then(() => undefined);
}

export async function publicKeyOf(privateKeyPath: string): Promise<string> {
	return (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
}

export interface ContainerOptions {
	bin: string;
	/** The server the node enrolls with and connects to. */
	crhs: InProcessCrhs;
	/** Non-privileged mode and node groups. */
	mode?: "forward" | "native" | "ignore" | "reject";
	native?: "sudo" | "doas" | "run0";
	groups?: string[];
	/** privileged.toml clock_skew; the fallback test uses 0 to let a 1 ms authorization expire. */
	clockSkew?: string;
	/** A deliberately wrong node_id in privileged.toml, to make crha reject a payload built for the node. */
	privilegedNodeId?: string;
	/** Start the container's sshd; the port must be free on the host (the test picks one). */
	ssh?: boolean;
	sshPort?: number;
	/**
	 * Trust entries of privileged.toml. The node id is filled in by the fixture; `null` keeps the
	 * file away, which is what a node whose privileged mode is not running looks like.
	 */
	trust?: TrustSpec[] | null;
}

/** One [[trust]] entry, in the field names of privileged.toml (doc/privilege.md 信任配置). */
export interface TrustSpec {
	name: string;
	role: "crhs" | "user" | "local";
	format?: "sshsig" | "webauthn";
	key?: string;
	credentialId?: string;
	rpId?: string;
	origins?: string[];
	uids?: number[];
	kinds: ("execute" | "cosign" | "require-cosign")[];
	requireExact?: boolean;
	requireTask?: boolean;
	requireUv?: boolean;
	maxTtl?: string;
	allow?: GuardRuleSpec[];
	deny?: GuardRuleSpec[];
	envAllow?: string[];
}

export interface GuardRuleSpec {
	method: "exec" | "file.read" | "file.write";
	prefix?: string;
	regex?: string;
}

/** A running privileged test container and its crhs-side node. */
export class PrivilegedNode {
	readonly name: string;
	readonly dir: string;
	readonly crhs: InProcessCrhs;
	readonly bin: string;
	readonly sshDir: string;
	readonly configDir: string;
	readonly userKeyPath: string;
	readonly sshClientKeyPath: string;
	readonly hostKeyPath: string;
	readonly sshPort: number;
	nodeId = "";
	#mode: ContainerOptions["mode"] = "forward";
	#clockSkew = "60s";
	#groups: string[] = ["web"];

	private constructor(name: string, dir: string, crhs: InProcessCrhs, bin: string, sshPort: number) {
		this.name = name;
		this.dir = dir;
		this.crhs = crhs;
		this.bin = bin;
		this.sshDir = join(dir, "ssh");
		this.configDir = join(dir, "config");
		this.userKeyPath = join(dir, "ssh", "user-signing-key");
		this.sshClientKeyPath = join(dir, "ssh", "client-key");
		this.hostKeyPath = join(dir, "ssh", "ssh_host_ed25519_key");
		this.sshPort = sshPort;
	}

	/** Starts a container, enrolls the node, writes the privileged config and waits until crha is up. */
	static async create(opts: ContainerOptions): Promise<PrivilegedNode> {
		const image = await ensureImage();
		const dir = await mkdtemp(join(tmpdir(), "crh-priv-"));
		const node = new PrivilegedNode(
			`crh-priv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
			dir,
			opts.crhs,
			opts.bin,
			opts.sshPort ?? 2222,
		);
		await node.#prepare(opts);
		await node.#start(image, opts);
		await node.#enroll();
		await node.#ready(opts);
		return node;
	}

	async #prepare(opts: ContainerOptions): Promise<void> {
		this.#clockSkew = opts.clockSkew ?? "60s";
		this.#groups = opts.groups ?? ["web"];
		await mkdir(this.sshDir, { recursive: true });
		await mkdir(this.configDir, { recursive: true });
		// 0777: the config dir is written from the host (root inside the container) and crha (uid 998)
		// only reads it; the state dirs of both processes live inside the container.
		await chmod(this.configDir, 0o777);
		await mkdir(join(this.dir, "bin"), { recursive: true });
		await sshKeygen(this.hostKeyPath);
		await sshKeygen(this.userKeyPath);
		await sshKeygen(this.sshClientKeyPath);
		await writeFile(join(this.sshDir, "authorized_keys"), `${await publicKeyOf(this.sshClientKeyPath)}\n`);
		await chmod(this.hostKeyPath, 0o600);
		await this.#writeCrhaConfig(opts);
	}

	async #start(image: string, opts: ContainerOptions): Promise<void> {
		const res = await podman([
			"run",
			"-d",
			"--name",
			this.name,
			"--network=host",
			"--init",
			...(opts.ssh ? ["-e", `PRIV_SSH_PORT=${this.sshPort}`] : ["-e", "PRIV_NO_SSHD=1"]),
			"-v",
			`${this.configDir}:/etc/crha:rw`,
			"-v",
			`${this.sshDir}:/opt/crh/ssh:ro`,
			"-v",
			`${this.bin}:${CONTAINER_CRHA}:ro`,
			image,
		]);
		if (res.code !== 0) throw new Error(`podman run failed:\n${res.stdout}\n${res.stderr}`);
	}

	async #enroll(): Promise<void> {
		const token = await this.crhs.enrollmentToken();
		const res = await this.execAs(
			UNPRIVILEGED_UID,
			[CONTAINER_CRHA, "enroll", "--config", "/etc/crha/crha.toml", this.crhs.url, token],
			{
				timeout: 60_000,
			},
		);
		if (res.code !== 0) throw new Error(`crha enroll failed:\n${res.stdout}\n${res.stderr}`);
		const id = /enrolled as node ([^\s,]+)/.exec(res.stdout)?.[1];
		if (!id) throw new Error(`could not read the node id from crha enroll:\n${res.stdout}\n${res.stderr}`);
		this.nodeId = id;
		// The enrollment row is written by the connection handler, so it may trail the printed id.
		await waitFor(
			"the pending node",
			async () => {
				const { json } = await this.crhs.api("/api/nodes");
				return json.nodes.find((n: { id: string }) => n.id === id);
			},
			30_000,
		);
	}

	async #ready(opts: ContainerOptions): Promise<void> {
		// The enrollment connection stays pending until an administrator confirms the node.
		const approved = await this.crhs.api(`/api/nodes/${this.nodeId}/approve`, { body: {} });
		if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${JSON.stringify(approved.json)}`);
		if (opts.trust !== null) await this.writeTrust(opts.trust ?? [], opts.privilegedNodeId ?? this.nodeId);
		await writeFile(join(this.configDir, ".ready"), "ready\n");
		await waitFor(
			"the node to connect",
			async () => {
				const { json } = await this.crhs.api("/api/nodes");
				const row = json.nodes.find((n: { id: string }) => n.id === this.nodeId);
				return row && row.connected === true;
			},
			60_000,
		);
		// Only forward mode asks the privileged mode for a summary; the others report not_forward.
		if (opts.trust !== null)
			await this.waitTrust(opts.mode === "forward" || opts.mode === undefined ? "ok" : "not_forward");
	}

	/** Waits for the node's cached trust report to reach a status (`ok`, `unavailable`, `not_forward`). */
	async waitTrust(status: "ok" | "unavailable" | "not_forward", timeoutMs = 30_000): Promise<TaskJson | unknown> {
		return waitFor(
			`trust report ${status}`,
			async () => {
				const { json } = await this.crhs.api(`/api/nodes/${this.nodeId}/trust`);
				return json.trust.status === status ? json.trust : undefined;
			},
			timeoutMs,
		);
	}

	async trust(): Promise<{ status: string; digest: string | null; summary: Record<string, unknown> | null }> {
		return (await this.crhs.api(`/api/nodes/${this.nodeId}/trust`)).json.trust;
	}

	/** Runs a command in the container as a user (uid 0 by default). */
	async exec(command: string[], opts: { user?: number; timeout?: number } = {}): Promise<ExecResult> {
		return this.execAs(opts.user ?? 0, command, opts);
	}

	async execAs(uid: number, command: string[], opts: { timeout?: number } = {}): Promise<ExecResult> {
		return podman(["exec", "--user", String(uid), this.name, ...command], opts);
	}

	/** privctl.sh: start/stop/restart the processes, reload trust, reset the privileged state. */
	async ctl(command: string, timeout = 60_000): Promise<ExecResult> {
		const res = await this.exec(["/usr/local/bin/privctl.sh", command], { timeout });
		if (res.code !== 0) throw new Error(`privctl ${command} failed:\n${res.stdout}\n${res.stderr}`);
		return res;
	}

	async logs(): Promise<string> {
		const res = await podman(["logs", this.name]);
		return res.stdout + res.stderr;
	}

	async writeTrust(trust: TrustSpec[], nodeId = this.nodeId): Promise<void> {
		const lines = [
			`node_id = "${nodeId}"`,
			`unprivileged_uid = ${UNPRIVILEGED_UID}`,
			`clock_skew = "${this.#clockSkew}"`,
			`groups = [${this.#groups.map(tomlString).join(", ")}]`,
		];
		for (const entry of trust) lines.push("", ...trustEntryToml(entry));
		await writeFile(join(this.configDir, "privileged.toml"), `${lines.join("\n")}\n`, { mode: 0o644 });
	}

	/** Replaces privileged.toml, reloads it and waits until crhs has the new digest. */
	async setTrust(trust: TrustSpec[], nodeId = this.nodeId): Promise<string | null> {
		const before = (await this.trust()).digest;
		await this.reloadTrust(trust, nodeId);
		return waitTrustDigestChange(this, before);
	}

	/** Replaces privileged.toml and makes the running privileged mode reload it; restarts it if stopped. */
	async reloadTrust(trust: TrustSpec[], nodeId = this.nodeId): Promise<void> {
		await this.writeTrust(trust, nodeId);
		const status = await this.ctl("status");
		if (status.stdout.includes("priv running")) {
			await this.ctl("hup-priv");
		} else {
			await this.ctl("start-priv");
		}
	}

	/** Rewrites crha.toml (privileged mode changes need a restart, doc/privilege.md#reload). */
	async setMode(mode: ContainerOptions["mode"], native: ContainerOptions["native"] = "sudo"): Promise<void> {
		this.#mode = mode;
		await this.#writeCrhaConfig({ mode, native });
		await this.ctl("restart-crha");
		await waitFor(
			`the node to reconnect in ${mode} mode`,
			async () => {
				const { json } = await this.crhs.api(`/api/nodes/${this.nodeId}`);
				return json.node.connected === true && json.node.privilegedMode === mode;
			},
			45_000,
		);
	}

	async #writeCrhaConfig(opts: {
		mode?: ContainerOptions["mode"];
		native?: ContainerOptions["native"];
	}): Promise<void> {
		const mode = opts.mode ?? this.#mode;
		const native = opts.native ?? "sudo";
		const lines = [
			`server = "${this.crhs.url}"`,
			'state_dir = "/var/lib/crha"',
			`groups = [${this.#groups.map(tomlString).join(", ")}]`,
			"",
			"[privileged]",
			`mode = "${mode}"`,
			`socket = "${PRIV_SOCKET}"`,
			`native = "${native}"`,
			"",
			"[output]",
			'dir = "/var/lib/crha/output"',
			"",
		];
		await writeFile(join(this.configDir, "crha.toml"), lines.join("\n"), { mode: 0o644 });
	}

	/** Adds a public key line to sshd's authorized_keys (used by the SSH node tests). */
	async authorizeSshKey(publicKey: string): Promise<void> {
		const path = join(this.sshDir, "authorized_keys");
		const current = await readFile(path, "utf8");
		await writeFile(path, `${current.trimEnd()}\n${publicKey.trim()}\n`);
	}

	/** Creates a privileged task (kind exec/file.*) and returns the task as created. */
	async task(body: Record<string, unknown>, waitMs = 1000): Promise<TaskJson> {
		return this.crhs.runTask(this.nodeId, { ...body, privileged: true }, waitMs);
	}

	async taskState(id: string, waitMs = 20_000): Promise<TaskJson> {
		return this.crhs.waitTask(id, waitMs);
	}

	async destroy(): Promise<void> {
		await podman(["rm", "-f", this.name]);
	}
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function trustEntryToml(entry: TrustSpec): string[] {
	const lines: string[] = ["[[trust]]", `name = ${tomlString(entry.name)}`, `role = ${tomlString(entry.role)}`];
	const field = (key: string, value: string | number | boolean | undefined) => {
		if (value !== undefined) lines.push(`${key} = ${typeof value === "string" ? tomlString(value) : value}`);
	};
	field("format", entry.format);
	field("key", entry.key);
	field("credential_id", entry.credentialId);
	field("rp_id", entry.rpId);
	if (entry.origins) lines.push(`origins = [${entry.origins.map(tomlString).join(", ")}]`);
	if (entry.uids) lines.push(`uids = [${entry.uids.join(", ")}]`);
	lines.push(`kinds = [${entry.kinds.map(tomlString).join(", ")}]`);
	if (entry.requireExact) lines.push("require_exact = true");
	if (entry.requireTask !== undefined) lines.push(`require_task = ${entry.requireTask}`);
	if (entry.requireUv) lines.push("require_uv = true");
	field("max_ttl", entry.maxTtl);
	field("env_allow", undefined);
	if (entry.envAllow) lines.push(`env_allow = [${entry.envAllow.map(tomlString).join(", ")}]`);
	for (const [kind, rules] of [
		["allow", entry.allow],
		["deny", entry.deny],
	] as const) {
		if (!rules || rules.length === 0) continue;
		const tables = rules.map((rule) => {
			const parts = [`method = ${tomlString(rule.method)}`];
			if (rule.prefix !== undefined) parts.push(`prefix = ${tomlString(rule.prefix)}`);
			if (rule.regex !== undefined) parts.push(`regex = ${tomlString(rule.regex)}`);
			return `{ ${parts.join(", ")} }`;
		});
		lines.push(`${kind} = [${tables.join(", ")}]`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Driving the user authorization paths
// ---------------------------------------------------------------------------

/** Registers an SSH public key as one of the caller's (admin's) signing credentials. */
export async function registerSshCredential(crhs: InProcessCrhs, publicKey: string): Promise<string> {
	const res = await crhs.api("/api/me/credentials/ssh", { body: { publicKey, name: "privileged test key" } });
	if (res.status !== 201) throw new Error(`register credential: ${res.status} ${JSON.stringify(res.json)}`);
	return res.json.credential.id;
}

export interface PendingAuthorization {
	id: string;
	payload: string;
	decoded: {
		nodes: string[];
		command: { method: string; match: string; target: string; specSha256?: string } | null;
		taskIds: string[] | null;
		attempt: number | null;
		deadline: string | null;
	};
	challenge: string;
	taskIds: string[];
	attempt: number;
	localRequested: boolean;
	tried: string[];
	lastRejection: unknown;
}

/** The exact payload bytes the owner must sign (GET /api/tasks/:id/authorization). */
export async function pendingAuthorization(crhs: InProcessCrhs, taskId: string): Promise<PendingAuthorization> {
	const res = await crhs.api(`/api/tasks/${taskId}/authorization`);
	if (res.status !== 200 || !res.json.authorization) {
		throw new Error(`task ${taskId} has no pending authorization: ${res.status} ${JSON.stringify(res.json)}`);
	}
	return res.json.authorization as PendingAuthorization;
}

/** Signs a pending payload on the host with the real CLI: `crha grant --payload … --key … --yes`. */
export async function signPayload(bin: string, keyPath: string, payload: string): Promise<string> {
	const res = await run(bin, ["grant", "--payload", payload, "--key", keyPath, "--yes"]);
	if (res.code !== 0) throw new Error(`crha grant failed:\n${res.stdout}\n${res.stderr}`);
	const line = res.stdout
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) throw new Error(`crha grant printed nothing:\n${res.stderr}`);
	return line;
}

/** Submits a signed authorization and returns the API result. */
export async function submitAuthorization(
	crhs: InProcessCrhs,
	authorization: string,
): Promise<{ status: number; json: { authorization?: { id: string; dispatched: string[] }; error?: string } }> {
	return crhs.api("/api/authorizations", { body: { authorization } });
}

/** Signs the task's pending payload for its owner and submits it. */
export async function authorizeWithCli(
	node: PrivilegedNode,
	taskId: string,
): Promise<{ id: string; authorization: string }> {
	const pending = await pendingAuthorization(node.crhs, taskId);
	const authorization = await signPayload(node.bin, node.userKeyPath, pending.payload);
	const res = await submitAuthorization(node.crhs, authorization);
	if (res.status !== 200) throw new Error(`submit authorization: ${res.status} ${JSON.stringify(res.json)}`);
	return { id: res.json.authorization?.id ?? pending.id, authorization };
}

/** Waits until the node's cached trust digest differs from `previous` (a trust config change). */
export async function waitTrustDigestChange(node: PrivilegedNode, previous: string | null): Promise<string | null> {
	const view = await waitFor(
		"a new trust digest",
		async () => {
			const trust = await node.trust();
			return trust.status === "ok" && trust.digest !== previous ? trust : undefined;
		},
		30_000,
	);
	return view.digest;
}
