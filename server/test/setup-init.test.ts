import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../src/settings/settings.ts";
import {
	type Answers,
	answersSchema,
	loadAnswersFile,
	parseAnswers,
	saveAnswersFile,
	withoutSecrets,
} from "../src/setup/answers.ts";
import { type CommandResult, runInit, type SetupHost } from "../src/setup/init.ts";
import { openDb } from "../src/storage/db.ts";
import { findUserByUsername } from "../src/users/service.ts";

interface CommandCall {
	command: string;
	args: string[];
}

interface ChownCall {
	path: string;
	owner: string;
	group: string;
}

interface FakeState {
	commands: CommandCall[];
	chowns: ChownCall[];
	userExists: boolean;
}

function fakeHost(prefix: string, state: FakeState): SetupHost {
	return {
		root: prefix,
		nodePath: "/usr/bin/node",
		entryPath: "/opt/crh/server/src/main.ts",
		version: "9.9.9",
		isRoot: () => true,
		async exec(command, args): Promise<CommandResult> {
			state.commands.push({ command, args });
			if (command === "id") return { code: state.userExists ? 0 : 1, stdout: "", stderr: "" };
			if (command === "useradd") {
				state.userExists = true;
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		async chown(path, owner, group): Promise<void> {
			state.chowns.push({ path, owner, group });
		},
	};
}

function sink(): { stream: Writable; text: () => string } {
	let text = "";
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			text += chunk.toString();
			callback();
		},
	});
	return { stream, text: () => text };
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "crhs-init-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeAnswers(dir: string, answers: Answers, mode = 0o600): Promise<string> {
	const path = join(dir, "answers.json");
	await writeFile(path, `${JSON.stringify(answers, null, 2)}\n`, { mode });
	return path;
}

function hostAnswers(overrides: Partial<Answers> = {}): Answers {
	return {
		version: 1,
		listen: { host: "127.0.0.1", port: 18080 },
		database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
		public_url: "https://crh.example.com/",
		admin: { username: "admin", display_name: "Admin User", password: "admin-password" },
		service: { install: true, start: true },
		...overrides,
	};
}

async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

const fieldNames = [
	"listen.host",
	"listen.port",
	"database.driver",
	"database.path",
	"public_url",
	"admin.username",
	"admin.display_name",
	"admin.password",
	"service.install",
	"service.start",
];

describe("answers file", () => {
	test("is strict about version, unknown fields and types", () => {
		expect(answersSchema.safeParse({ version: 1 }).success).toBe(true);
		expect(() => parseAnswers({ version: 1, extra: true })).toThrow(/invalid answers/);
		expect(() => parseAnswers({ version: 1, listen: { host: "127.0.0.1", wrong: 1 } })).toThrow(/invalid answers/);
		expect(() => parseAnswers({ version: 1, listen: { port: "8080" } })).toThrow(/listen.port/);
		expect(() => parseAnswers({ version: 2 })).toThrow(/version/);
		expect(() => parseAnswers({ version: 1, service: { install: "yes" } })).toThrow(/service.install/);
	});

	test("refuses a secret in a file group or others can read", async () => {
		const dir = await tempDir();
		const path = await writeAnswers(
			dir,
			hostAnswers({ database: { driver: "postgres", url: "postgres://crh:secret@db.example.com/crh" } }),
			0o644,
		);
		await expect(loadAnswersFile(path)).rejects.toThrow(/must not be accessible by group or others/);
		await rm(path);
		await writeAnswers(dir, hostAnswers());
		await expect(loadAnswersFile(path)).resolves.toMatchObject({ version: 1 });
	});

	test("drops secrets when saving", async () => {
		const dir = await tempDir();
		const path = join(dir, "saved.json");
		const answers: Answers = {
			version: 1,
			database: { driver: "postgres", url: "postgres://crh:secret@db.example.com/crh" },
			admin: { username: "admin", password: "secret" },
		};
		await saveAnswersFile(path, answers);
		expect(await modeOf(path)).toBe(0o600);
		const saved = JSON.parse(await readFile(path, "utf8")) as Answers;
		expect(saved).toEqual({
			version: 1,
			database: { driver: "postgres" },
			admin: { username: "admin" },
		});
		expect(withoutSecrets(answers)).toEqual(saved);
	});
});

describe("init", () => {
	test("without a terminal reports every missing answer at once", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const input = new PassThrough();
		input.end();
		const stdout = sink();
		const stderr = sink();
		let message = "";
		try {
			await runInit({
				host: fakeHost(prefix, state),
				env: {},
				interactive: false,
				input,
				stdout: stdout.stream,
				stderr: stderr.stream,
			});
		} catch (err) {
			message = (err as Error).message;
		}
		for (const field of fieldNames) expect(message).toContain(field);
		expect(message).toContain("missing answers for");
		expect(state.commands).toEqual([]);
	});

	test("sets up a host layout with a fake root and command runner", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answersPath = await writeAnswers(prefix, hostAnswers());
		const stdout = sink();
		const stderr = sink();

		await runInit({
			host: fakeHost(prefix, state),
			env: {},
			answersPath,
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		const output = stdout.text() + stderr.text();
		expect(output).toContain("created: system user crhs");
		expect(output).toContain("wrote: /etc/crhs/crhs.toml");
		expect(output).toContain("migrated: database");
		expect(output).toContain("created: /etc/crhs/master.key");
		expect(output).toContain("created admin admin");
		expect(output).toContain("set: public_url");
		expect(output).toContain("wrote: /etc/systemd/system/crhs.service");
		expect(output).toContain("back up /etc/crhs/master.key");

		expect(await modeOf(join(prefix, "etc/crhs"))).toBe(0o750);
		expect(await modeOf(join(prefix, "var/lib/crhs"))).toBe(0o700);
		expect(await modeOf(join(prefix, "etc/crhs/crhs.toml"))).toBe(0o640);
		expect(await modeOf(join(prefix, "etc/crhs/master.key"))).toBe(0o600);
		expect(await modeOf(join(prefix, "etc/systemd/system/crhs.service"))).toBe(0o644);

		const config = await readFile(join(prefix, "etc/crhs/crhs.toml"), "utf8");
		expect(config).toContain('[listen]\nhost = "127.0.0.1"\nport = 18080');
		expect(config).toContain('[database]\ndriver = "sqlite"\npath = "/var/lib/crhs/crhs.db"');
		expect(config).toContain('master_key_file = "/etc/crhs/master.key"');
		expect(config).not.toContain("web_root");

		const unit = await readFile(join(prefix, "etc/systemd/system/crhs.service"), "utf8");
		expect(unit).toContain("# This file is managed by crhs. DO NOT EDIT; customize with systemctl edit.");
		expect(unit).toContain("X-CRH-Managed=1");
		expect(unit).toContain('X-CRH-Meta={"v":1,"version":"9.9.9","config":"/etc/crhs/crhs.toml"}');
		expect(unit).toContain("ExecStart=/usr/bin/node /opt/crh/server/src/main.ts serve --config /etc/crhs/crhs.toml");
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("ProtectSystem=strict");
		expect(unit).toContain("ReadWritePaths=-/var/lib/crhs");
		expect(unit).toContain("WantedBy=multi-user.target");

		expect(state.commands).toEqual([
			{ command: "id", args: ["-u", "crhs"] },
			{
				command: "useradd",
				args: ["--system", "--user-group", "--home-dir", "/var/lib/crhs", "--shell", "/usr/sbin/nologin", "crhs"],
			},
			{ command: "systemctl", args: ["daemon-reload"] },
			{ command: "systemctl", args: ["enable", "--now", "crhs"] },
		]);
		expect(state.chowns.slice(0, 4)).toEqual([
			{ path: join(prefix, "etc/crhs"), owner: "root", group: "crhs" },
			{ path: join(prefix, "var/lib/crhs"), owner: "crhs", group: "crhs" },
			{ path: join(prefix, "etc/crhs/crhs.toml"), owner: "root", group: "crhs" },
			{ path: join(prefix, "etc/crhs/master.key"), owner: "crhs", group: "crhs" },
		]);
		// The service runs as crhs, so the SQLite files init created as root are handed over.
		const dbChowns = state.chowns.slice(4);
		expect(dbChowns.map((call) => call.path)).toContain(join(prefix, "var/lib/crhs/crhs.db"));
		expect(dbChowns.every((call) => call.owner === "crhs" && call.path.includes("crhs.db"))).toBe(true);

		const db = openDb({ driver: "sqlite", path: join(prefix, "var/lib/crhs/crhs.db") });
		try {
			const admin = await findUserByUsername(db, "admin");
			expect(admin).toMatchObject({ kind: "admin", display_name: "Admin User" });
			expect(admin?.password_hash).toBeTruthy();
			expect((await SettingsStore.load(db)).current().publicUrl).toBe("https://crh.example.com");
		} finally {
			await db.destroy();
		}
	});

	test("skips every step on a second run", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answersPath = await writeAnswers(prefix, hostAnswers());
		const firstOut = sink();
		await runInit({
			host: fakeHost(prefix, state),
			env: {},
			answersPath,
			interactive: false,
			stdout: firstOut.stream,
			stderr: firstOut.stream,
		});

		state.commands = [];
		state.chowns = [];
		const secondOut = sink();
		await runInit({
			host: fakeHost(prefix, state),
			env: {},
			answersPath,
			interactive: false,
			stdout: secondOut.stream,
			stderr: secondOut.stream,
		});

		const output = secondOut.text();
		for (const step of [
			"system user crhs",
			"/etc/crhs",
			"/var/lib/crhs",
			"/etc/crhs/crhs.toml",
			"database migrations",
			"/etc/crhs/master.key",
			"administrator admin",
			"public_url",
			"/etc/systemd/system/crhs.service",
		]) {
			expect(output).toContain(`skipped: ${step}`);
		}
		expect(output).not.toContain("created:");
		expect(output).not.toContain("wrote:");
		expect(output).not.toContain("migrated:");
		expect(state.commands).toEqual([{ command: "id", args: ["-u", "crhs"] }]);
		expect(state.chowns.every((call) => call.path.includes("crhs.db"))).toBe(true);
	});

	test("keeps everything under CRHS_DATA_DIR and installs no unit", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answersPath = await writeAnswers(
			prefix,
			hostAnswers({
				database: { driver: "sqlite", path: "/crhs-data/crhs.db" },
				public_url: "",
				service: { install: false, start: false },
			}),
		);
		const stdout = sink();
		await runInit({
			host: fakeHost(prefix, state),
			env: { CRHS_DATA_DIR: "/crhs-data" },
			answersPath,
			interactive: false,
			stdout: stdout.stream,
			stderr: stdout.stream,
		});

		const dataDir = join(prefix, "crhs-data");
		expect(await modeOf(dataDir)).toBe(0o700);
		const config = await readFile(join(dataDir, "crhs.toml"), "utf8");
		expect(config).toContain('master_key_file = "/crhs-data/master.key"');
		expect(config).toContain('path = "/crhs-data/crhs.db"');
		expect(await modeOf(join(dataDir, "crhs.toml"))).toBe(0o640);
		expect(await modeOf(join(dataDir, "master.key"))).toBe(0o600);
		expect((await stat(join(dataDir, "crhs.db"))).isFile()).toBe(true);
		expect(state.commands).toEqual([]);
		expect(state.chowns).toEqual([]);
	});

	test("rejects service.install under CRHS_DATA_DIR before touching anything", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answersPath = await writeAnswers(
			prefix,
			hostAnswers({ database: { driver: "sqlite", path: "/crhs-data/crhs.db" } }),
		);
		await expect(
			runInit({
				host: fakeHost(prefix, state),
				env: { CRHS_DATA_DIR: "/crhs-data" },
				answersPath,
				interactive: false,
				stdout: sink().stream,
				stderr: sink().stream,
			}),
		).rejects.toThrow(/service.install must be false/);
		expect(state.commands).toEqual([]);
	});

	test("requires root to install the systemd service", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answersPath = await writeAnswers(prefix, hostAnswers());
		await expect(
			runInit({
				host: { ...fakeHost(prefix, state), isRoot: () => false },
				env: {},
				answersPath,
				interactive: false,
				stdout: sink().stream,
				stderr: sink().stream,
			}),
		).rejects.toThrow(/requires root/);
		expect(state.commands).toEqual([]);
	});

	test("asks missing questions on a terminal and saves answers without secrets", async () => {
		const prefix = await tempDir();
		const state: FakeState = { commands: [], chowns: [], userExists: false };
		const answers = hostAnswers({
			service: { install: false, start: false },
		});
		delete answers.admin?.password;
		const answersPath = await writeAnswers(prefix, answers);
		const savedPath = join(prefix, "saved.json");
		const input = new PassThrough();
		input.write("admin-password\nadmin-password\n\n");
		const stdout = sink();
		const stderr = sink();

		await runInit({
			host: fakeHost(prefix, state),
			env: {},
			answersPath,
			saveAnswersPath: savedPath,
			interactive: true,
			input,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		expect(stderr.text()).toContain("Proceed? [Y/n]");
		expect(stdout.text()).toContain("created admin admin");
		expect(await modeOf(savedPath)).toBe(0o600);
		const saved = JSON.parse(await readFile(savedPath, "utf8")) as Answers;
		expect(saved.admin?.password).toBeUndefined();
		expect(saved.database?.url).toBeUndefined();
		expect(saved.admin).toEqual({ username: "admin", display_name: "Admin User" });
		expect(saved.database).toEqual({ driver: "sqlite", path: "/var/lib/crhs/crhs.db" });
		const db = openDb({ driver: "sqlite", path: join(prefix, "var/lib/crhs/crhs.db") });
		try {
			expect(await findUserByUsername(db, "admin")).toBeDefined();
		} finally {
			await db.destroy();
		}
	});
});
