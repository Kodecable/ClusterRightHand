#!/usr/bin/env node
// Smoke-tests the release artifacts themselves, the crhs tarball and the OCI image, not just dist/crhs.
// Both run the bundle outside the repository, where a module the build failed to include does not
// resolve; a released image once crash-looped on @xterm/addon-serialize while every test passed.
// Plain Node TypeScript, no dependencies:
//   node scripts/smoke-release.ts --tarball dist/release/crhs-<v>-linux-<arch>.tar.gz --version <v>
//   node scripts/smoke-release.ts --image crhs-smoke:local --version <v>
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** The line `serve` prints once it accepts requests (server/src/main.ts). */
const LISTENING_MARKER = "crhs listening";
const START_TIMEOUT_MS = 60_000;
const IMAGE_START_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 30_000;

interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
}

interface Running {
	child: ChildProcess;
	exited: Promise<RunResult>;
	/** The output so far; a failure can report it before the process has exited. */
	output(): { stdout: string; stderr: string };
}

/**
 * The environment an artifact runs with: this process's, without NODE_PATH. pnpm's .bin shims set it
 * to the workspace's hoisted node_modules, which would resolve a package the artifact failed to
 * include and hide the failure the release has.
 */
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const { NODE_PATH: _nodePath, ...env } = process.env;
	return { ...env, ...extra };
}

function spawnCaptured(command: string, args: string[], options: RunOptions = {}): Running {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout = child.stdout;
	const stderr = child.stderr;
	const stdin = child.stdin;
	if (!stdout || !stderr || !stdin) {
		child.kill();
		throw new Error(`${command} was spawned without pipes`);
	}
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	let out = "";
	let err = "";
	stdout.on("data", (chunk: string) => {
		out += chunk;
	});
	stderr.on("data", (chunk: string) => {
		err += chunk;
	});
	// A command may exit before it reads stdin (or never start); its exit result carries the reason.
	stdin.on("error", () => undefined);
	const exited = new Promise<RunResult>((resolvePromise, reject) => {
		child.once("error", reject);
		// "close", not "exit": the streams may still hold output when the process exits.
		child.once("close", (code, signal) => resolvePromise({ code, signal, stdout: out, stderr: err }));
	});
	stdin.end(options.input ?? "");
	return { child, exited, output: () => ({ stdout: out, stderr: err }) };
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	return spawnCaptured(command, args, options).exited;
}

async function mustRun(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	const result = await run(command, args, options);
	if (result.code !== 0) {
		const detail = result.stderr.trim();
		throw new Error(
			`${command} ${args.join(" ")} exited with ${result.code ?? result.signal}${detail ? `:\n${detail}` : ""}`,
		);
	}
	return result;
}

function checkVersion(printed: string, expected: string, what: string): void {
	const actual = printed.trim();
	if (actual !== expected) throw new Error(`${what} printed ${JSON.stringify(actual)}, not ${expected}`);
}

function outputOf(running: Running): string {
	const { stdout, stderr } = running.output();
	return `${stdout}${stderr}`.trim() || "(no output)";
}

/** Resolves once stdout carries the listening line; rejects on an early exit or the timeout. */
function waitForListening(running: Running, timeoutMs: number): Promise<void> {
	const stdout = running.child.stdout;
	if (!stdout) return Promise.reject(new Error("crhs has no stdout pipe"));
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolvePromise();
		};
		timer = setTimeout(() => {
			finish(
				new Error(
					`crhs did not print ${JSON.stringify(LISTENING_MARKER)} within ${timeoutMs / 1000} s:\n${outputOf(running)}`,
				),
			);
		}, timeoutMs);
		stdout.on("data", () => {
			if (running.output().stdout.includes(LISTENING_MARKER)) finish();
		});
		running.exited.then(
			(result) => {
				finish(new Error(`crhs exited with ${result.code ?? result.signal} before listening:\n${outputOf(running)}`));
			},
			(error: unknown) => finish(new Error(`cannot start crhs: ${(error as Error).message}`)),
		);
	});
}

/** SIGTERM and the exit result; a process that ignores it is killed after STOP_TIMEOUT_MS. */
async function stopRunning(running: Running): Promise<RunResult> {
	const { child } = running;
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			running.exited,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`crhs did not exit within ${STOP_TIMEOUT_MS / 1000} s after SIGTERM`));
				}, STOP_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("the free-port probe has no address");
	await new Promise<void>((resolvePromise, reject) => {
		server.close((error) => (error ? reject(error) : resolvePromise()));
	});
	return address.port;
}

/** The answers file of server/test/bundle/bundle.test.ts, with the port and database path of the artifact. */
function answersFile(host: string, port: number, databasePath: string): string {
	return `${JSON.stringify(
		{
			version: 1,
			listen: { host, port },
			database: { driver: "sqlite", path: databasePath },
			public_url: "",
			admin: { username: "admin", display_name: "Admin User", password: "admin-password" },
			service: { install: false, start: false },
		},
		null,
		2,
	)}\n`;
}

async function get(url: string, what: string): Promise<Response> {
	try {
		return await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`${what} failed: ${(error as Error).message}`);
	}
}

/** The checks both artifacts share: the bundled WebUI, an authenticated route and robots.txt. */
async function checkHttp(baseUrl: string): Promise<void> {
	const page = await get(`${baseUrl}/`, "GET /");
	const body = await page.text();
	if (page.status !== 200) throw new Error(`GET / returned ${page.status}, not 200`);
	const contentType = page.headers.get("content-type") ?? "";
	if (!contentType.includes("text/html")) {
		throw new Error(`GET / returned content-type ${JSON.stringify(contentType)}, not text/html`);
	}
	if (!body.includes('<div id="root">')) throw new Error("GET / did not return the bundled WebUI page");
	const me = await get(`${baseUrl}/api/me`, "GET /api/me");
	await me.text();
	if (me.status !== 401) throw new Error(`GET /api/me returned ${me.status}, not 401`);
	const robots = await get(`${baseUrl}/robots.txt`, "GET /robots.txt");
	await robots.text();
	if (robots.status !== 200) throw new Error(`GET /robots.txt returned ${robots.status}, not 200`);
}

/** The single top directory an archive extracts into. */
async function singleDirectory(root: string): Promise<string> {
	const entries = await readdir(root, { withFileTypes: true });
	const top = entries.length === 1 ? entries[0] : undefined;
	if (!top?.isDirectory()) throw new Error(`${root} did not receive exactly one top directory from the archive`);
	return join(root, top.name);
}

async function smokeTarball(tarball: string, version: string): Promise<void> {
	const archive = resolve(tarball);
	const match = /^crhs-(.+)-linux-(amd64|arm64)\.tar\.gz$/.exec(basename(archive));
	if (!match) throw new Error(`${tarball} is not crhs-<v>-linux-<arch>.tar.gz`);
	const [, archiveVersion, arch] = match;
	if (archiveVersion !== version) throw new Error(`${tarball} is ${archiveVersion}, not ${version}`);
	const root = await mkdtemp(join(tmpdir(), "crhs-release-"));
	let serving: Running | undefined;
	try {
		await mustRun("tar", ["-xzf", archive, "-C", root]);
		const top = await singleDirectory(root);
		const crhs = join(top, "bin", "crhs");
		const env = environment();
		const printed = await mustRun(crhs, ["--version"], { cwd: top, env });
		checkVersion(printed.stdout, version, `${crhs} --version`);

		const data = join(root, "data");
		const port = await freePort();
		const answers = join(root, "init.json");
		await writeFile(answers, answersFile("127.0.0.1", port, join(data, "crhs.db")), { mode: 0o600 });
		await mustRun(crhs, ["init", "--answers", answers], {
			cwd: top,
			env: environment({ CRHS_DATA_DIR: data }),
		});

		serving = spawnCaptured(crhs, ["--config", join(data, "crhs.toml"), "serve"], { cwd: top, env });
		await waitForListening(serving, START_TIMEOUT_MS);
		await checkHttp(`http://127.0.0.1:${port}`);
		const stopped = await stopRunning(serving);
		serving = undefined;
		if (stopped.code !== 0) {
			throw new Error(`crhs exited with ${stopped.code ?? stopped.signal} after SIGTERM, not 0`);
		}

		await checkClientArchives(archive, version, arch, root);
	} finally {
		if (serving) await stopRunning(serving).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
}

/** crha and crhu against the same version and arch, when the release directory has them next to crhs. */
async function checkClientArchives(archive: string, version: string, arch: string, root: string): Promise<void> {
	for (const tool of ["crha", "crhu"] as const) {
		const sibling = join(dirname(archive), `${tool}-${version}-linux-${arch}.tar.gz`);
		try {
			await access(sibling);
		} catch {
			// Not every caller packages the clients; the release workflow does, and then they are checked.
			continue;
		}
		const dir = join(root, tool);
		await mkdir(dir, { recursive: true });
		await mustRun("tar", ["-xzf", sibling, "-C", dir]);
		const binary = join(dir, `${tool}-${version}-linux-${arch}`, tool);
		const printed = await mustRun(binary, ["version"], { env: environment() });
		if (!printed.stdout.trim().startsWith(`${tool} ${version} (`)) {
			throw new Error(`${tool} printed ${JSON.stringify(printed.stdout.trim())}, not ${tool} ${version} ...`);
		}
	}
}

async function onPath(command: string): Promise<boolean> {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			await access(join(dir, command), constants.X_OK);
			return true;
		} catch {
			// not in this PATH entry
		}
	}
	return false;
}

/** CRH_CONTAINER_ENGINE, else docker when it is on PATH, else podman. */
async function containerEngine(): Promise<string> {
	const configured = process.env.CRH_CONTAINER_ENGINE;
	if (configured) return configured;
	if (await onPath("docker")) return "docker";
	if (await onPath("podman")) return "podman";
	throw new Error("neither docker nor podman is on PATH; set CRH_CONTAINER_ENGINE");
}

/** Polls GET / until it answers 200, failing as soon as the detached container has exited. */
async function waitForImageHttp(engine: string, name: string, baseUrl: string): Promise<void> {
	const deadline = Date.now() + IMAGE_START_TIMEOUT_MS;
	let last = "no answer";
	while (Date.now() < deadline) {
		const state = await run(engine, ["inspect", "-f", "{{.State.Status}}", name]);
		if (state.code !== 0) throw new Error(`cannot inspect container ${name}: ${state.stderr.trim()}`);
		const status = state.stdout.trim();
		if (status === "exited" || status === "dead") {
			throw new Error(`container ${name} exited before answering`);
		}
		try {
			const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
			await response.text();
			if (response.status === 200) return;
			last = `GET / returned ${response.status}`;
		} catch (error) {
			last = (error as Error).message;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error(`the image did not answer on ${baseUrl} within ${IMAGE_START_TIMEOUT_MS / 1000} s: ${last}`);
}

/** The host port of one container port, from `docker port <name> <port>`. */
function publishedPort(output: string, name: string): number {
	const line = output.trim().split("\n")[0]?.trim();
	if (!line) throw new Error(`container ${name} published no port`);
	const separator = line.lastIndexOf(":");
	const port = Number(separator < 0 ? "" : line.slice(separator + 1));
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`cannot read the host port of container ${name} from ${JSON.stringify(line)}`);
	}
	return port;
}

async function printLogs(engine: string, name: string): Promise<void> {
	const logs = await run(engine, ["logs", name]).catch(() => undefined);
	if (logs?.code !== 0) return;
	const text = `${logs.stdout}${logs.stderr}`.trimEnd();
	if (text) console.error(`container ${name} logs:\n${text}`);
}

async function smokeImage(reference: string, version: string): Promise<void> {
	const engine = await containerEngine();
	const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const name = `crhs-smoke-${suffix}`;
	const volume = `crhs-smoke-${suffix}`;
	try {
		// The entrypoint passes arguments to crhs, so this is the image's own bundle and Node.
		const printed = await mustRun(engine, ["run", "--rm", reference, "--version"]);
		checkVersion(printed.stdout, version, `${reference} --version`);

		await mustRun(engine, ["volume", "create", volume]);
		// The image runs as node, which owns /crhs-data: write the answers as that user, mode 0600.
		await mustRun(
			engine,
			[
				"run",
				"--rm",
				"-i",
				"--entrypoint",
				"sh",
				"-v",
				`${volume}:/crhs-data`,
				reference,
				"-c",
				"umask 077; cat > /crhs-data/init.json",
			],
			{ input: answersFile("0.0.0.0", 8080, "/crhs-data/crhs.db") },
		);
		// No arguments: the entrypoint runs init from init.json, then serves it.
		await mustRun(engine, [
			"run",
			"-d",
			"--name",
			name,
			"-v",
			`${volume}:/crhs-data`,
			"-p",
			"127.0.0.1::8080",
			reference,
		]);
		const portOutput = await mustRun(engine, ["port", name, "8080"]);
		const baseUrl = `http://127.0.0.1:${publishedPort(portOutput.stdout, name)}`;
		await waitForImageHttp(engine, name, baseUrl);
		await checkHttp(baseUrl);

		await mustRun(engine, ["stop", "-t", "30", name]);
		const exited = await mustRun(engine, ["inspect", "-f", "{{.State.ExitCode}}", name]);
		const code = exited.stdout.trim();
		if (code !== "0") throw new Error(`container ${name} exited with ${code} after stop, not 0`);
	} catch (error) {
		await printLogs(engine, name);
		throw error;
	} finally {
		await run(engine, ["rm", "-f", name]).catch(() => undefined);
		await run(engine, ["volume", "rm", "-f", volume]).catch(() => undefined);
	}
}

const { values } = parseArgs({
	options: {
		tarball: { type: "string" },
		image: { type: "string" },
		version: { type: "string" },
	},
});

try {
	const version = values.version;
	if (!version) throw new Error("--version is required");
	if (Boolean(values.tarball) === Boolean(values.image)) {
		throw new Error("pass exactly one of --tarball <path> and --image <ref>");
	}
	if (values.tarball) await smokeTarball(values.tarball, version);
	else await smokeImage(values.image as string, version);
} catch (error) {
	console.error(`smoke-release: ${(error as Error).message}`);
	process.exitCode = 1;
}
