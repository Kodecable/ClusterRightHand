import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pg from "pg";
import { appendCliAudit, cliInput } from "../audit/cli.ts";
import { type DatabaseConfig, DEFAULT_CONFIG_PATH } from "../config.ts";
import { initMasterKey } from "../keys/setup.ts";
import { SettingsStore } from "../settings/settings.ts";
import { type Db, openDb } from "../storage/db.ts";
import { migrateToLatest } from "../storage/migrate.ts";
import { createUser, findUserByUsername } from "../users/service.ts";
import { CRH_VERSION } from "../version.ts";
import { type Answers, loadAnswersFile, SetupError, saveAnswersFile } from "./answers.ts";
import { answersForSaving, collectAnswers, type Layout, type ResolvedAnswers, resolveLayout } from "./questions.ts";

const SYSTEM_USER = "crhs";
const UNIT_PATH = "/etc/systemd/system/crhs.service";

/** One external command's outcome; a non-zero exit is a result, not an exception. */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Everything `init` touches outside the answers: the filesystem root (so tests can use a temp
 * prefix), the system commands and chown. Production uses the real host; tests inject fakes.
 */
export interface SetupHost {
	/** Prefix for every host path (`""` in production, a temp directory in tests). */
	root: string;
	nodePath: string;
	entryPath: string;
	version: string;
	isRoot(): boolean;
	exec(command: string, args: string[]): Promise<CommandResult>;
	chown(path: string, owner: string, group: string): Promise<void>;
}

/** The real host: the running Node and crhs.mjs, node:child_process and filesystem ownership. */
export function productionHost(): SetupHost {
	return {
		root: "",
		nodePath: process.execPath,
		entryPath: realpathSync(process.argv[1] ?? process.execPath),
		version: CRH_VERSION,
		isRoot: () => process.getuid?.() === 0,
		exec: runCommand,
		chown: async (path, owner, group) => {
			const result = await runCommand("chown", [`${owner}:${group}`, path]);
			if (result.code !== 0) {
				throw new SetupError(`chown ${owner}:${group} ${path} failed: ${result.stderr.trim()}`);
			}
		},
	};
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
			if (!error) return resolve({ code: 0, stdout, stderr });
			if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
			reject(error);
		});
	});
}

export interface RunInitOptions {
	/** `--config`: where crhs.toml goes in the host layout (ignored under CRHS_DATA_DIR). */
	configPath?: string;
	answersPath?: string;
	saveAnswersPath?: string;
	env?: NodeJS.ProcessEnv;
	host?: SetupHost;
	input?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	/** Where questions are written; stderr, so piped stdout stays clean. */
	stderr?: NodeJS.WritableStream;
	/** Tests inject input without a TTY; defaults to `input.isTTY`. */
	interactive?: boolean;
}

/** `crhs init`: answer the setup questions, then perform each step that is not already done. */
export async function runInit(options: RunInitOptions = {}): Promise<void> {
	const host = options.host ?? productionHost();
	const env = options.env ?? process.env;
	const input = options.input ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const say = (line: string): void => {
		stdout.write(`${line}\n`);
	};
	const layout = resolveLayout(env, options.configPath ?? DEFAULT_CONFIG_PATH);

	const fileAnswers: Answers = options.answersPath ? await loadAnswersFile(options.answersPath) : { version: 1 };
	const interactive = options.interactive ?? Boolean((input as { isTTY?: boolean }).isTTY);
	const { answers } = await collectAnswers(fileAnswers, layout, {
		input,
		promptOutput: stderr,
		interactive,
		say,
	});

	if (layout.host && answers.service.install && !host.isRoot()) {
		throw new SetupError(
			'installing the systemd service requires root; run as root or answer "no" to the service question',
		);
	}
	// The URL is the only credential checked before any file is written: a typo would otherwise
	// surface only when the server starts.
	if (answers.database.driver === "postgres") await checkPostgresUrl(answers.database.url);
	if (options.saveAnswersPath) await saveAnswersFile(options.saveAnswersPath, answersForSaving(answers));

	await applyAnswers(answers, layout, host, env.CRHS_LAUNCHER, say);
	printReminders(say, layout, options.answersPath, fileAnswers);
}

async function checkPostgresUrl(url: string): Promise<void> {
	const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
	try {
		await client.connect();
		await client.query("select 1");
	} catch (err) {
		throw new SetupError(`cannot connect to PostgreSQL: ${(err as Error).message}`);
	} finally {
		await client.end().catch(() => {});
	}
}

async function applyAnswers(
	answers: ResolvedAnswers,
	layout: Layout,
	host: SetupHost,
	launcher: string | undefined,
	say: (line: string) => void,
): Promise<void> {
	if (layout.host) {
		await ensureSystemUser(host, say);
		await ensureDirectory(host, "/etc/crhs", 0o750, "root", SYSTEM_USER, say);
		await ensureDirectory(host, "/var/lib/crhs", 0o700, SYSTEM_USER, SYSTEM_USER, say);
	} else {
		if (!layout.dataDir) throw new SetupError("CRHS_DATA_DIR is empty");
		await ensureDirectory(host, layout.dataDir, 0o700, undefined, undefined, say);
	}
	await ensureConfig(answers, layout, host, say);

	const db = openDb(databaseConfig(answers, host));
	try {
		const migrated = await migrateToLatest(db);
		say(migrated.length === 0 ? "skipped: database migrations" : "migrated: database");
		await ensureMasterKey(layout, host, db, say);
		await ensureAdministrator(answers, db, say);
		await ensurePublicUrl(answers, db, say);
	} finally {
		await db.destroy();
	}
	// init runs as root, but the service runs as crhs and must be able to write the SQLite files.
	if (layout.host && answers.database.driver === "sqlite") {
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = at(host, `${answers.database.path}${suffix}`);
			if (await exists(file)) await host.chown(file, SYSTEM_USER, SYSTEM_USER);
		}
	}
	await ensureServiceUnit(answers, layout, host, launcher, say);
}

async function ensureSystemUser(host: SetupHost, say: (line: string) => void): Promise<void> {
	const existing = await host.exec("id", ["-u", SYSTEM_USER]);
	if (existing.code === 0) {
		say(`skipped: system user ${SYSTEM_USER}`);
		return;
	}
	const created = await host.exec("useradd", [
		"--system",
		"--user-group",
		"--home-dir",
		"/var/lib/crhs",
		"--shell",
		"/usr/sbin/nologin",
		SYSTEM_USER,
	]);
	if (created.code !== 0) throw new SetupError(`useradd ${SYSTEM_USER} failed: ${created.stderr.trim()}`);
	say(`created: system user ${SYSTEM_USER}`);
}

async function ensureDirectory(
	host: SetupHost,
	path: string,
	mode: number,
	owner: string | undefined,
	group: string | undefined,
	say: (line: string) => void,
): Promise<void> {
	const actual = at(host, path);
	if (await exists(actual)) {
		say(`skipped: ${path}`);
		return;
	}
	await mkdir(actual, { recursive: true, mode });
	await chmod(actual, mode);
	if (owner !== undefined && group !== undefined) await host.chown(actual, owner, group);
	say(`created: ${path}`);
}

async function ensureConfig(
	answers: ResolvedAnswers,
	layout: Layout,
	host: SetupHost,
	say: (line: string) => void,
): Promise<void> {
	const actual = at(host, layout.configPath);
	if (await exists(actual)) {
		say(`skipped: ${layout.configPath}`);
		return;
	}
	await writeFile(actual, renderConfig(answers, layout), { mode: 0o640, flag: "wx" });
	await chmod(actual, 0o640);
	if (layout.host) await host.chown(actual, "root", SYSTEM_USER);
	say(`wrote: ${layout.configPath}`);
}

async function ensureMasterKey(layout: Layout, host: SetupHost, db: Db, say: (line: string) => void): Promise<void> {
	const actual = at(host, layout.masterKeyPath);
	if (await exists(actual)) {
		say(`skipped: ${layout.masterKeyPath}`);
		return;
	}
	const key = await initMasterKey(actual, db);
	if (layout.host) await host.chown(actual, SYSTEM_USER, SYSTEM_USER);
	try {
		await appendCliAudit(
			db,
			cliInput("keys.initialized", { master_key_file: layout.masterKeyPath, master_key_id: key.id }),
		);
	} catch (err) {
		throw new SetupError(
			`created ${layout.masterKeyPath} but could not record its audit event: ${(err as Error).message}`,
		);
	}
	say(`created: ${layout.masterKeyPath}`);
}

async function ensureAdministrator(answers: ResolvedAnswers, db: Db, say: (line: string) => void): Promise<void> {
	const existing = await findUserByUsername(db, answers.admin.username);
	if (existing) {
		say(`skipped: administrator ${existing.username}`);
		return;
	}
	// The administrator and its audit event are one transaction: init never leaves an unrecorded admin.
	const settings = await SettingsStore.load(db);
	const user = await db.transaction().execute(async (trx) => {
		const created = await createUser(
			trx,
			{
				username: answers.admin.username,
				displayName: answers.admin.displayName,
				kind: "admin",
				password: answers.admin.password,
			},
			{ library: settings.current().library.user },
		);
		await appendCliAudit(
			trx,
			cliInput(
				"user.created",
				{ username: created.username, kind: created.kind, display_name: created.displayName },
				{ type: "user", id: created.id },
			),
		);
		return created;
	});
	say(`created admin ${user.username} (${user.id})`);
}

async function ensurePublicUrl(answers: ResolvedAnswers, db: Db, say: (line: string) => void): Promise<void> {
	if (answers.publicUrl === "") return;
	const settings = await SettingsStore.load(db);
	if (settings.current().publicUrl === answers.publicUrl) {
		say("skipped: public_url");
		return;
	}
	await settings.patch(db, { publicUrl: answers.publicUrl }, null);
	say("set: public_url");
}

async function ensureServiceUnit(
	answers: ResolvedAnswers,
	layout: Layout,
	host: SetupHost,
	launcher: string | undefined,
	say: (line: string) => void,
): Promise<void> {
	if (!answers.service.install) return;
	const actual = at(host, UNIT_PATH);
	if (await exists(actual)) {
		say(`skipped: ${UNIT_PATH}`);
		return;
	}
	await mkdir(dirname(actual), { recursive: true });
	await writeFile(actual, renderUnit(answers, layout, host, launcher), { mode: 0o644, flag: "wx" });
	await chmod(actual, 0o644);
	say(`wrote: ${UNIT_PATH}`);
	await systemctl(host, ["daemon-reload"]);
	await systemctl(host, answers.service.start ? ["enable", "--now", SYSTEM_USER] : ["enable", SYSTEM_USER]);
}

async function systemctl(host: SetupHost, args: string[]): Promise<void> {
	const result = await host.exec("systemctl", args);
	if (result.code !== 0) throw new SetupError(`systemctl ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

/** The TOML crhs reads: no `web_root`, so a bundled crhs serves the WebUI next to crhs.mjs. */
function renderConfig(answers: ResolvedAnswers, layout: Layout): string {
	const lines = [`master_key_file = ${tomlString(layout.masterKeyPath)}`, "", "[listen]"];
	lines.push(`host = ${tomlString(answers.listen.host)}`, `port = ${answers.listen.port}`, "", "[database]");
	if (answers.database.driver === "sqlite") {
		lines.push('driver = "sqlite"', `path = ${tomlString(answers.database.path)}`);
	} else {
		lines.push('driver = "postgres"', `url = ${tomlString(answers.database.url)}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderUnit(answers: ResolvedAnswers, layout: Layout, host: SetupHost, launcher: string | undefined): string {
	const meta = JSON.stringify({ v: 1, version: host.version, config: layout.configPath });
	// The packaged wrapper sets CRHS_LAUNCHER, so the unit follows /opt/crhs/current across versions.
	const execStart = launcher
		? `${launcher} serve --config ${layout.configPath}`
		: `${host.nodePath} ${host.entryPath} serve --config ${layout.configPath}`;
	// ProtectSystem=strict leaves only these writable: the state directory and a SQLite file kept elsewhere.
	const writable = new Set(["/var/lib/crhs"]);
	if (answers.database.driver === "sqlite") writable.add(dirname(answers.database.path));
	return `# This file is managed by crhs. DO NOT EDIT; customize with systemctl edit.
[Unit]
Description=ClusterRightHand server
After=network-online.target
Wants=network-online.target
X-CRH-Managed=1
X-CRH-Meta=${meta}

[Service]
User=${SYSTEM_USER}
Group=${SYSTEM_USER}
ExecStart=${execStart}
Restart=on-failure
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${[...writable].map((path) => `-${path}`).join(" ")}

[Install]
WantedBy=multi-user.target
`;
}

function databaseConfig(answers: ResolvedAnswers, host: SetupHost): DatabaseConfig {
	if (answers.database.driver === "postgres") return answers.database;
	return { driver: "sqlite", path: at(host, answers.database.path) };
}

function printReminders(
	say: (line: string) => void,
	layout: Layout,
	answersPath: string | undefined,
	fileAnswers: Answers,
): void {
	say(`back up ${layout.masterKeyPath} and run "crhs keys export" to keep an offline copy`);
	say("put a reverse proxy with TLS in front of crhs");
	if (!layout.host && answersPath && fileAnswers.admin?.password !== undefined) {
		say(`delete ${answersPath}: it holds the administrator's password`);
	}
}

/** The host path under the test prefix (`""` keeps the real path). */
function at(host: SetupHost, path: string): string {
	return host.root === "" ? path : join(host.root, path);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/** A TOML basic string; JSON's escaping is valid TOML for every path and URL crhs stores. */
function tomlString(value: string): string {
	return JSON.stringify(value);
}
