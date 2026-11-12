import { join } from "node:path";
import { createPrompter } from "../cli/prompt.ts";
import { DEFAULT_CONFIG_PATH, parsePublicUrl } from "../config.ts";
import { type Answers, SetupError } from "./answers.ts";

/** Where `init` puts its files: the fixed host layout, or everything under `CRHS_DATA_DIR` (the OCI image). */
export interface Layout {
	/** Fixed host layout (system user, ownership, systemd unit) when true; data-directory layout otherwise. */
	host: boolean;
	dataDir: string | null;
	configPath: string;
	masterKeyPath: string;
	defaultDatabasePath: string;
}

export function resolveLayout(env: NodeJS.ProcessEnv = process.env, configPath = DEFAULT_CONFIG_PATH): Layout {
	const dataDir = env.CRHS_DATA_DIR;
	if (dataDir) {
		return {
			host: false,
			dataDir,
			configPath: join(dataDir, "crhs.toml"),
			masterKeyPath: join(dataDir, "master.key"),
			defaultDatabasePath: join(dataDir, "crhs.db"),
		};
	}
	return {
		host: true,
		dataDir: null,
		configPath,
		masterKeyPath: "/etc/crhs/master.key",
		defaultDatabasePath: "/var/lib/crhs/crhs.db",
	};
}

/** The fully answered setup questions, without the answers the file left out. */
export interface ResolvedAnswers {
	listen: { host: string; port: number };
	database: { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };
	/** Normalized, or "" when the operator left it empty. */
	publicUrl: string;
	admin: { username: string; displayName: string; password: string };
	service: { install: boolean; start: boolean };
}

export interface AnswerIo {
	input: NodeJS.ReadableStream;
	/** Where questions are written (the terminal's stderr, normally). */
	promptOutput: NodeJS.WritableStream;
	/** True when stdin is a terminal; otherwise every question must come from the answers file. */
	interactive: boolean;
	say: (line: string) => void;
}

export interface CollectedAnswers {
	answers: ResolvedAnswers;
	/** Whether any question was asked on the terminal (and therefore whether the run was confirmed). */
	asked: boolean;
}

/** The question fields the answers file does not hold; used to refuse a non-interactive run as a whole. */
function missingFields(fileAnswers: Answers, layout: Layout): string[] {
	const driver = fileAnswers.database?.driver ?? "sqlite";
	const install = layout.host && (fileAnswers.service?.install ?? true);
	const fields: [string, unknown][] = [
		["listen.host", fileAnswers.listen?.host],
		["listen.port", fileAnswers.listen?.port],
		["database.driver", fileAnswers.database?.driver],
	];
	if (driver === "postgres") fields.push(["database.url", fileAnswers.database?.url]);
	else fields.push(["database.path", fileAnswers.database?.path]);
	fields.push(
		["public_url", fileAnswers.public_url],
		["admin.username", fileAnswers.admin?.username],
		["admin.display_name", fileAnswers.admin?.display_name],
		["admin.password", fileAnswers.admin?.password],
		["service.install", layout.host ? fileAnswers.service?.install : false],
	);
	if (install) fields.push(["service.start", fileAnswers.service?.start]);
	return fields.filter(([, value]) => value === undefined).map(([field]) => field);
}

/**
 * Resolves the setup questions: a value from the answers file is used as is, a missing one is asked on
 * a terminal (Enter takes the shown default). Without a terminal, all missing fields are reported in
 * one error before anything is asked or changed. An interactive run then shows a summary and asks to
 * proceed; a run answered entirely by the file does not.
 */
export async function collectAnswers(fileAnswers: Answers, layout: Layout, io: AnswerIo): Promise<CollectedAnswers> {
	if (!layout.host && fileAnswers.service?.install === true) {
		throw new SetupError("service.install must be false when CRHS_DATA_DIR is set");
	}
	const missing = missingFields(fileAnswers, layout);
	if (!io.interactive) {
		if (missing.length > 0) {
			throw new SetupError(
				`missing answers for ${missing.join(", ")}; put them in the --answers file or run on a terminal`,
			);
		}
		return { answers: resolveQuestions(fileAnswers, layout), asked: false };
	}
	const asked = missing.length > 0;
	const prompter = asked ? createPrompter(io.input, io.promptOutput) : undefined;
	const ask = async (prompt: string): Promise<string> => {
		if (!prompter) throw new SetupError("internal error: a question has no terminal");
		return prompter.question(prompt);
	};
	const askSecret = async (prompt: string): Promise<string> => {
		if (!prompter) throw new SetupError("internal error: a secret has no terminal");
		return prompter.secret(prompt);
	};
	const take = async (value: string | undefined, prompt: string, fallback?: string): Promise<string> => {
		if (value !== undefined) return value;
		const suffix = fallback === undefined ? "" : ` [${fallback}]`;
		const text = (await ask(`${prompt}${suffix}: `)).trim();
		if (text !== "") return text;
		if (fallback !== undefined) return fallback;
		throw new SetupError(`${prompt} must not be empty`);
	};
	const yesNo = async (label: string, fallback: boolean): Promise<boolean> => {
		const answer = (await ask(`${label}? [${fallback ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
		if (answer === "") return fallback;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		throw new SetupError(`${label}: answer yes or no`);
	};

	try {
		const listen = {
			// A container must listen on all interfaces; the fixed host layout keeps the loopback default.
			host: await take(fileAnswers.listen?.host, "Listen address", layout.host ? "127.0.0.1" : "0.0.0.0"),
			port: await resolvePort(fileAnswers.listen?.port, ask),
		};
		const driver = await take(fileAnswers.database?.driver, "Database driver (sqlite or postgres)", "sqlite");
		if (driver !== "sqlite" && driver !== "postgres") {
			throw new SetupError(`database.driver must be "sqlite" or "postgres", got ${JSON.stringify(driver)}`);
		}
		let database: ResolvedAnswers["database"];
		if (driver === "sqlite") {
			database = {
				driver: "sqlite",
				path: await take(fileAnswers.database?.path, "SQLite file", layout.defaultDatabasePath),
			};
		} else {
			const url = fileAnswers.database?.url ?? (await askSecret("PostgreSQL URL: ")).trim();
			if (url === "") throw new SetupError("database.url must not be empty");
			database = { driver: "postgres", url };
		}
		const publicText = fileAnswers.public_url ?? (await take(undefined, "Public URL (empty for none)", ""));
		const publicUrl = parsePublicUrlAnswer(publicText);

		const username = await take(fileAnswers.admin?.username, "Administrator username", "admin");
		const displayName = await take(fileAnswers.admin?.display_name, "Administrator display name", username);
		let password = fileAnswers.admin?.password;
		if (password === undefined) {
			password = await askSecret("Administrator password: ");
			const repeat = await askSecret("Repeat password: ");
			if (password !== repeat) throw new SetupError("passwords do not match");
		}

		let install = false;
		let start = false;
		if (layout.host) {
			install = fileAnswers.service?.install ?? (await yesNo("Install the systemd service", true));
			if (install) start = fileAnswers.service?.start ?? (await yesNo("Start the service", true));
		}

		const answers: ResolvedAnswers = {
			listen,
			database,
			publicUrl,
			admin: { username, displayName, password },
			service: { install, start },
		};

		if (asked) {
			io.say("crhs init: settings");
			io.say(`  listen: ${listen.host}:${listen.port}`);
			io.say(
				`  database: ${database.driver === "sqlite" ? `SQLite ${database.path}` : "PostgreSQL (checked on connect)"}`,
			);
			io.say(`  public URL: ${publicUrl === "" ? "(none)" : publicUrl}`);
			io.say(`  administrator: ${username} (${displayName})`);
			io.say(`  service: ${install ? (start ? "install and start" : "install") : "do not install"}`);
			const proceed = (await ask("Proceed? [Y/n] ")).trim().toLowerCase();
			if (proceed !== "" && proceed !== "y" && proceed !== "yes") {
				throw new SetupError(proceed === "n" || proceed === "no" ? "aborted" : "please answer yes or no");
			}
		}
		return { answers, asked };
	} finally {
		prompter?.close();
	}
}

/** Answers with the secrets, for `--save-answers`; saveAnswersFile removes the secret fields. */
export function answersForSaving(answers: ResolvedAnswers): Answers {
	return {
		version: 1,
		listen: { host: answers.listen.host, port: answers.listen.port },
		database:
			answers.database.driver === "sqlite" ? { driver: "sqlite", path: answers.database.path } : { driver: "postgres" },
		public_url: answers.publicUrl,
		admin: { username: answers.admin.username, display_name: answers.admin.displayName },
		service: { install: answers.service.install, start: answers.service.start },
	};
}

/** The all-from-file path: every missing field already failed, so this never asks. */
function resolveQuestions(fileAnswers: Answers, layout: Layout): ResolvedAnswers {
	const driver = fileAnswers.database?.driver ?? "sqlite";
	const database =
		driver === "postgres"
			? { driver: "postgres" as const, url: requireField(fileAnswers.database?.url, "database.url") }
			: { driver: "sqlite" as const, path: requireField(fileAnswers.database?.path, "database.path") };
	const publicText = fileAnswers.public_url ?? "";
	const install = layout.host && (fileAnswers.service?.install ?? true);
	return {
		listen: {
			host: requireField(fileAnswers.listen?.host, "listen.host"),
			port: requireField(fileAnswers.listen?.port, "listen.port"),
		},
		database,
		publicUrl: parsePublicUrlAnswer(publicText),
		admin: {
			username: requireField(fileAnswers.admin?.username, "admin.username"),
			displayName: requireField(fileAnswers.admin?.display_name, "admin.display_name"),
			password: requireField(fileAnswers.admin?.password, "admin.password"),
		},
		service: { install, start: install ? requireField(fileAnswers.service?.start, "service.start") : false },
	};
}

function requireField<T>(value: T | undefined, field: string): T {
	if (value === undefined) throw new SetupError(`missing answer for ${field}`);
	return value;
}

/** Empty means "no public URL"; anything else is validated by config.ts and reported as a setup error. */
function parsePublicUrlAnswer(value: string): string {
	const text = value.trim();
	if (text === "") return "";
	try {
		return parsePublicUrl(text) ?? "";
	} catch (err) {
		throw new SetupError((err as Error).message);
	}
}

async function resolvePort(value: number | undefined, ask: (prompt: string) => Promise<string>): Promise<number> {
	const text = value === undefined ? (await ask("Listen port [8080]: ")).trim() || "8080" : String(value);
	const port = Number(text);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new SetupError("listen.port must be an integer between 0 and 65535");
	}
	return port;
}
