/**
 * The podman fixture of the crha self-upgrade system suite (doc/design/testing/privileged.md).
 *
 * One container is one node with systemd as PID 1: `crha enroll` sets it up exactly as on a real host
 * (the crha user, the directories, the managed units), so the upgrade runs against real systemd-run,
 * systemctl and journalctl. The crhs side is the in-process server of ../../e2e/harness.ts, given a
 * crha release cache that holds the newer crha built by the test.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CrhaReleases } from "../../../src/cluster/crha-release.ts";
import { InProcessCrhs, waitFor } from "../../e2e/harness.ts";

const execFileAsync = promisify(execFile);
const PODMAN = process.env.CRH_PODMAN ?? "podman";

export const SUITE_DIR = resolve(import.meta.dirname);
export const CLIENT_DIR = resolve(SUITE_DIR, "../../../../client");
export const CONTAINER_CRHA = "/usr/local/bin/crha";
/** The architecture crha reports for a binary built on this host. */
export const ARCH = process.arch === "arm64" ? "arm64" : "amd64";

export const podmanAvailable = await (async () => {
	if (process.env.CRH_TEST_PODMAN !== "1") return false;
	try {
		await execFileAsync(PODMAN, ["version", "--format", "{{.Version}}"], { timeout: 20_000 });
		return true;
	} catch {
		return false;
	}
})();

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], opts: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	return new Promise<ExecResult>((complete) => {
		execFile(
			cmd,
			args,
			{ timeout: opts.timeout ?? 120_000, maxBuffer: 32 << 20, cwd: opts.cwd, env: opts.env },
			(err, stdout, stderr) => {
				const code = err
					? typeof (err as { code?: unknown }).code === "number"
						? (err as { code: number }).code
						: 1
					: 0;
				complete({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

export function podman(args: string[], timeout?: number): Promise<ExecResult> {
	return run(PODMAN, args, timeout === undefined ? {} : { timeout });
}

/** The image tag is the hash of the Containerfile, so an edit rebuilds once. */
export async function ensureImage(): Promise<string> {
	const hash = createHash("sha256").update(await readFile(join(SUITE_DIR, "Containerfile")));
	const tag = `crh-upgrade-system:${hash.digest("hex").slice(0, 12)}`;
	if ((await podman(["image", "exists", tag])).code === 0) return tag;
	const build = await podman(["build", "-t", tag, "-f", join(SUITE_DIR, "Containerfile"), SUITE_DIR], 15 * 60_000);
	if (build.code !== 0) throw new Error(`podman build ${tag} failed:\n${build.stdout}\n${build.stderr}`);
	return tag;
}

/**
 * A static crha that reports `version`. `neverReady` builds one that never logs its readiness line
 * (the test-only switch in client/internal/agent/ready.go), to drive the installer's rollback.
 */
export async function buildCrha(outDir: string, version: string, opts: { neverReady?: boolean } = {}): Promise<string> {
	const bin = join(outDir, `crha-${version}${opts.neverReady ? "-never-ready" : ""}`);
	const flags = [`-X github.com/Kodecable/ClusterRightHand/client/internal/version.Version=${version}`];
	if (opts.neverReady) {
		flags.push("-X github.com/Kodecable/ClusterRightHand/client/internal/agent.testNeverReady=1");
		// The installer is the new binary: its readiness wait is shortened so the rollback comes sooner.
		flags.push("-X github.com/Kodecable/ClusterRightHand/client/internal/upgrade.testReadyTimeout=30s");
	}
	await new Promise<void>((done, fail) => {
		const child = spawn("go", ["build", "-ldflags", flags.join(" "), "-o", bin, "./cmd/crha"], {
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
 * Puts `bin` into crhs's release cache as crha `version`'s archive, as `crha_release.download = false`
 * expects an operator to (doc/guide/reference/crhs-config.md "[crha_release]").
 */
export async function stageRelease(dataDir: string, version: string, bin: string): Promise<void> {
	const top = `crha-${version}-linux-${ARCH}`;
	const src = await mkdtemp(join(tmpdir(), "crh-release-src-"));
	await mkdir(join(src, top));
	await writeFile(join(src, top, "crha"), await readFile(bin), { mode: 0o755 });
	const dir = join(dataDir, "crha-releases", version);
	await mkdir(dir, { recursive: true });
	const tar = await run("tar", ["-C", src, "--owner=0", "--group=0", "-czf", join(dir, `${top}.tar.gz`), top]);
	if (tar.code !== 0) throw new Error(`tar: ${tar.stderr}`);
}

/** An in-process crhs of `version`, serving the release cache in `dataDir` without verification. */
export async function startCrhs(dataDir: string, version: string): Promise<InProcessCrhs> {
	const crhaReleases = new CrhaReleases({
		dataDir,
		version,
		config: { url: "https://github.com/Kodecable/ClusterRightHand", download: false, verify: false, github: null },
	});
	const crhs = await InProcessCrhs.create({}, { crhaReleases });
	await crhs.loginAdmin();
	return crhs;
}

export type Mode = "forward" | "native" | "ignore";

export interface NodeOptions {
	/**
	 * Run crha as root through a drop-in, as an administrator customizes a managed unit
	 * (`systemctl edit crha`): the usual way to run `ignore` mode as root.
	 */
	asRoot?: boolean;
}

/** One node: a systemd container set up with `crha enroll`. */
export class UpgradeNode {
	readonly name: string;
	readonly crhs: InProcessCrhs;
	nodeId = "";

	private constructor(name: string, crhs: InProcessCrhs) {
		this.name = name;
		this.crhs = crhs;
	}

	/** Starts the container, installs `bin`, enrolls the node in `mode`, approves it and waits for it. */
	static async create(crhs: InProcessCrhs, bin: string, mode: Mode, opts: NodeOptions = {}): Promise<UpgradeNode> {
		const image = await ensureImage();
		const node = new UpgradeNode(`crh-upgrade-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, crhs);
		const started = await podman(["run", "-d", "--name", node.name, "--systemd=always", "--network=host", image]);
		if (started.code !== 0) throw new Error(`podman run failed:\n${started.stderr}`);
		await waitFor(
			"systemd in the container",
			async () => {
				const state = (await node.exec(["systemctl", "is-system-running"])).stdout.trim();
				return state === "running" || state === "degraded";
			},
			60_000,
			500,
		);
		await node.install(bin);
		await node.#enroll(mode);
		if (opts.asRoot) await node.#runAsRoot();
		return node;
	}

	/** Runs a command in the container as root; never through a shell. */
	exec(args: string[], timeout?: number): Promise<ExecResult> {
		return podman(["exec", this.name, ...args], timeout);
	}

	async execOk(args: string[]): Promise<string> {
		const res = await this.exec(args);
		if (res.code !== 0) throw new Error(`${args.join(" ")} failed (${res.code}):\n${res.stdout}\n${res.stderr}`);
		return res.stdout;
	}

	/** Copies a file from the host into the container. */
	async copyIn(source: string, destination: string, mode: string): Promise<void> {
		const cp = await podman(["cp", source, `${this.name}:${destination}`]);
		if (cp.code !== 0) throw new Error(`podman cp: ${cp.stderr}`);
		await this.execOk(["chown", "root:root", destination]);
		await this.execOk(["chmod", mode, destination]);
	}

	/** Installs a crha binary as the tar's install.sh does. */
	async install(bin: string): Promise<void> {
		await this.copyIn(bin, CONTAINER_CRHA, "0755");
	}

	async #enroll(mode: Mode): Promise<void> {
		const scratch = await mkdtemp(join(tmpdir(), "crh-upgrade-node-"));
		const answers: Record<string, unknown> = {
			version: 1,
			server: this.crhs.url,
			token: await this.crhs.enrollmentToken(),
			tls_verify: "none",
			service: { start: true },
		};
		if (mode === "native") {
			// enroll offers ignore and forward; native is a crha.toml written first, which enroll keeps.
			await this.execOk(["mkdir", "-p", "/etc/crha"]);
			const config = join(scratch, "crha.toml");
			await writeFile(
				config,
				`server = "${this.crhs.url}"\ntls_verify = "none"\nstate_dir = "/var/lib/crha"\n\n[privileged]\nmode = "native"\n`,
			);
			await this.copyIn(config, "/etc/crha/crha.toml", "0644");
			answers.server = undefined;
			answers.tls_verify = undefined;
		} else if (mode === "forward") {
			const key = await this.crhs.api("/api/privilege/crhs-key");
			if (key.status !== 200) throw new Error(`crhs key: ${key.status}`);
			answers.privileged = {
				mode: "forward",
				local_root: true,
				// crhs may authorize alone: the upgrade is then authorized without a person.
				trust: `[[trust]]\nname = "crhs"\nrole = "crhs"\nformat = "sshsig"\nkey = "${key.json.key.authorizedKey}"\nkinds = ["execute"]`,
			};
		} else {
			answers.privileged = { mode: "ignore" };
		}
		const answersPath = join(scratch, "enroll.json");
		await writeFile(answersPath, JSON.stringify(answers));
		await chmod(answersPath, 0o600);
		await this.copyIn(answersPath, "/root/enroll.json", "0600");
		const out = await this.execOk([CONTAINER_CRHA, "enroll", "--answers", "/root/enroll.json"]);
		const id = /enrolled as node ([0-9a-f-]+)/.exec(out)?.[1];
		if (!id) throw new Error(`enroll printed no node id:\n${out}`);
		this.nodeId = id;
		const approve = await this.crhs.api(`/api/nodes/${id}/approve`, { body: {} });
		if (approve.status !== 200) throw new Error(`approve: ${approve.status} ${JSON.stringify(approve.json)}`);
		await this.waitVersion(undefined);
	}

	async #runAsRoot(): Promise<void> {
		const scratch = await mkdtemp(join(tmpdir(), "crh-upgrade-dropin-"));
		const dropIn = join(scratch, "root.conf");
		await writeFile(dropIn, "[Service]\nUser=root\nGroup=root\n");
		await this.execOk(["mkdir", "-p", "/etc/systemd/system/crha.service.d"]);
		await this.copyIn(dropIn, "/etc/systemd/system/crha.service.d/root.conf", "0644");
		await this.execOk(["systemctl", "daemon-reload"]);
		await this.execOk(["systemctl", "restart", "crha.service"]);
		await this.waitVersion(undefined);
	}

	/** The user crha.service runs as, with its drop-ins. */
	async serviceUser(): Promise<string> {
		return (await this.execOk(["systemctl", "show", "-p", "User", "--value", "crha.service"])).trim();
	}

	/** The node as crhs sees it. */
	// biome-ignore lint/suspicious/noExplicitAny: test helper returns untyped JSON
	async node(): Promise<any> {
		const res = await this.crhs.api(`/api/nodes/${this.nodeId}`);
		if (res.status !== 200) throw new Error(`node: ${res.status}`);
		return res.json.node;
	}

	/** Waits until the node is connected (with `version`, when given) and has reported self_upgrade. */
	async waitVersion(version: string | undefined, timeoutMs = 60_000): Promise<void> {
		await waitFor(
			`node ${this.name} connected${version ? ` with crha ${version}` : ""}`,
			async () => {
				const node = await this.node();
				return (
					node.connected === true &&
					node.facts?.selfUpgrade !== undefined &&
					(version === undefined || node.clientVersion === version)
				);
			},
			timeoutMs,
			500,
		);
	}

	/** The version crha.service's metadata names. */
	async unitVersion(): Promise<string> {
		const unit = await this.execOk(["cat", "/etc/systemd/system/crha.service"]);
		const meta = /^X-CRH-Meta=(.*)$/m.exec(unit)?.[1];
		return meta ? (JSON.parse(meta) as { version: string }).version : "";
	}

	/** The upgrade log's entries. */
	async upgradeLog(): Promise<{ step: string; msg: string; from: string; to: string }[]> {
		const res = await this.exec(["cat", "/var/lib/crha-upgrade/upgrade.jsonl"]);
		if (res.code !== 0) return [];
		return res.stdout
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	}

	/** The upgrade log and the journals of crha's units and the installer, for a failing test. */
	async diagnostics(): Promise<string> {
		const log = await this.exec(["cat", "/var/lib/crha-upgrade/upgrade.jsonl"]);
		const journal = await this.exec(["journalctl", "--no-pager", "-n", "200", "-u", "crha*", "-u", "crha-upgrade-*"]);
		return `upgrade log:\n${log.stdout}\njournal:\n${journal.stdout}`;
	}

	async destroy(): Promise<void> {
		await podman(["rm", "-f", "-t", "0", this.name]);
	}
}
