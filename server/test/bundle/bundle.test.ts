import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The smoke test of dist/crhs (pnpm build:crhs): a scratch copy outside the repository, so every bare
// import resolves from the bundle's own node_modules and the WebUI comes from the bundled default.

const bundleDir = fileURLToPath(new URL("../../../dist/crhs", import.meta.url));
const pgUrl = process.env.CRH_TEST_PG_URL;

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCrhs(dir: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}): Promise<Result> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(dir, "crhs.mjs"), ...args], {
			cwd: dir,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

function startCrhs(dir: string, args: string[]): { child: ChildProcess; started: Promise<void> } {
	const child = spawn(process.execPath, [join(dir, "crhs.mjs"), ...args], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const { stdout, stderr } = child;
	if (!stdout || !stderr) throw new Error("crhs was spawned without output pipes");
	let output = "";
	let listening = false;
	const started = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`crhs did not start within 30 s:\n${output}`)), 30_000);
		stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
			if (!listening && output.includes("crhs listening")) {
				listening = true;
				clearTimeout(timer);
				resolve();
			}
		});
		stderr.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`crhs exited with ${code} before listening:\n${output}`));
		});
	});
	return { child, started };
}

/** SIGTERM, then the exit code; the started promise is rejection-safe here (a failed test already failed). */
function stop(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	child.kill("SIGTERM");
	return exited;
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address === "string" || address === null) throw new Error("no port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function writeConfig(path: string, keyFile: string, port: number, database: string): Promise<void> {
	await writeFile(
		path,
		`master_key_file = ${JSON.stringify(join(appDir, keyFile))}
[listen]
host = "127.0.0.1"
port = ${port}

[database]
${database}
`,
	);
}

let tempRoot: string;
let appDir: string;

beforeAll(async () => {
	try {
		await access(join(bundleDir, "crhs.mjs"));
	} catch {
		throw new Error("run pnpm build:crhs first");
	}
	tempRoot = await mkdtemp(join(tmpdir(), "crhs-bundle-"));
	appDir = join(tempRoot, "crhs");
	await cp(bundleDir, appDir, { recursive: true });
});

afterAll(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("prints the bundled version", async () => {
	const result = await runCrhs(appDir, ["--version"]);
	expect(result.code, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe((await readFile(join(appDir, "VERSION"), "utf8")).trim());
});

describe("SQLite", () => {
	test("initializes with crhs init and serves the bundled WebUI", async () => {
		const port = await freePort();
		const data = join(appDir, "data");
		const answersPath = join(appDir, "init.json");
		await writeFile(
			answersPath,
			JSON.stringify({
				version: 1,
				listen: { host: "127.0.0.1", port },
				database: { driver: "sqlite", path: join(data, "crhs.db") },
				public_url: "",
				admin: { username: "admin", display_name: "Admin User", password: "admin-password" },
				service: { install: false, start: false },
			}),
			{ mode: 0o600 },
		);

		const init = await runCrhs(appDir, ["init", "--answers", answersPath], "", { CRHS_DATA_DIR: data });
		expect(init.code, init.stderr).toBe(0);

		const serving = startCrhs(appDir, ["--config", join(data, "crhs.toml"), "serve"]);
		let exitCode: number | null = null;
		try {
			await serving.started;
			const page = await fetch(`http://127.0.0.1:${port}/`);
			expect(page.status).toBe(200);
			expect(page.headers.get("content-type")).toContain("text/html");
			expect(await page.text()).toContain('<div id="root">');
			expect((await fetch(`http://127.0.0.1:${port}/api/me`)).status).toBe(401);
		} finally {
			exitCode = await stop(serving.child);
		}
		expect(exitCode).toBe(0);
	}, 60_000);
});

describe.skipIf(!pgUrl)("PostgreSQL (requires CRH_TEST_PG_URL)", () => {
	test("initializes and serves on a freshly created database", async () => {
		if (!pgUrl) throw new Error("unreachable");
		const client = new pg.Client({ connectionString: pgUrl });
		await client.connect();
		const name = `crh_bundle_${randomBytes(6).toString("hex")}`;
		const url = new URL(pgUrl);
		url.pathname = `/${name}`;
		const port = await freePort();
		const config = join(appDir, "crhs-pg.toml");
		try {
			await client.query(`create database ${client.escapeIdentifier(name)}`);
			await writeConfig(config, "master-pg.key", port, `driver = "postgres"\nurl = ${JSON.stringify(url.toString())}`);
			const init = await runCrhs(appDir, ["--config", config, "keys", "init"]);
			expect(init.code, init.stderr).toBe(0);

			const serving = startCrhs(appDir, ["--config", config, "serve"]);
			let exitCode: number | null = null;
			try {
				await serving.started;
			} finally {
				exitCode = await stop(serving.child);
			}
			expect(exitCode).toBe(0);
		} finally {
			await client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`);
			await client.end();
		}
	}, 120_000);
});
