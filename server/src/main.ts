#!/usr/bin/env node
import type { Server } from "node:http";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { ModelConfig } from "./agent/models.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { rejectExpiredTokenWaits } from "./api/api-token-waits.ts";
import { createApp } from "./api/app.ts";
import { createClientAddress } from "./api/client-address.ts";
import { RequestDrain } from "./api/drain.ts";
import { Audit } from "./audit/audit.ts";
import { configureHashGate } from "./auth/hash-gate.ts";
import { deleteExpiredWebSessions } from "./auth/sessions.ts";
import { addUser, changePassword, exportKeys, importKeys, initKeys } from "./cli/commands.ts";
import { readSecret } from "./cli/prompt.ts";
import { AgentServer } from "./cluster/agent-server.ts";
import { Cluster } from "./cluster/cluster.ts";
import { loadServerIdentity } from "./cluster/identity.ts";
import { nodeRoute } from "./cluster/ssh/nodes.ts";
import { TaskGroups } from "./cluster/task-groups.ts";
import { type Config, type ConfigFile, DEFAULT_CONFIG_PATH, loadConfigFile } from "./config.ts";
import { bindMasterKey, KeyError, type MasterKey, readMasterKeyFile } from "./keys/master-key.ts";
import { loadAuthorizationSigningKeys } from "./privilege/key.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { importSettingsFromFile, SettingsStore } from "./settings/settings.ts";
import { SetupError } from "./setup/answers.ts";
import { runInit } from "./setup/init.ts";
import { createStorageOpener, type Db, openAgentStorage, openDb } from "./storage/db.ts";
import { migrateToLatest } from "./storage/migrate.ts";
import { startRetentionSweep } from "./storage/retention.ts";
import { UserError } from "./util/errors.ts";
import { CRH_VERSION } from "./version.ts";

const USAGE = `usage: crhs [--config <path>] <command>

commands:
  version, --version                    print the version and exit
  serve                                 run the server (default)
  init [--answers <file>] [--save-answers <file>]
                                        set up this host; missing answers are asked on a terminal
  user add <username> [--admin] [--display-name <name>]
                                        create a user; the password is read from the terminal or stdin
  user passwd <username>                set a user's password
  keys init                             create the master key file (master_key_file)
  keys export --out <file>              write the master key and server keys to a passphrase-encrypted age file
  keys import <file>                    restore the master key file from an export, after checking it against the database`;

/** How long a graceful shutdown may take before the process exits non-zero instead. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: "string", short: "c", default: DEFAULT_CONFIG_PATH },
		admin: { type: "boolean", default: false },
		"display-name": { type: "string" },
		out: { type: "string", short: "o" },
		answers: { type: "string" },
		"save-answers": { type: "string" },
		help: { type: "boolean", short: "h", default: false },
		version: { type: "boolean", default: false },
	},
});

if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

if (values.version || positionals[0] === "version") {
	console.log(CRH_VERSION);
	process.exit(0);
}

const [command = "serve", ...args] = positionals;

if (command === "init") {
	try {
		await runInit({
			configPath: values.config,
			answersPath: values.answers,
			saveAnswersPath: values["save-answers"],
		});
	} catch (err) {
		if (!(err instanceof SetupError || err instanceof UserError || err instanceof KeyError)) throw err;
		console.error(`crhs: ${err.message}`);
		process.exitCode = 1;
	}
} else {
	await runCommand(command, args);
}

async function runCommand(command: string, args: string[]): Promise<void> {
	let configFile: ConfigFile;
	try {
		configFile = await loadConfigFile(values.config);
	} catch (err) {
		console.error(`crhs: ${values.config}: ${(err as Error).message}`);
		process.exit(2);
	}
	const config: Config = configFile.config;
	const db = openDb(config.database);
	await migrateToLatest(db);

	// Settings an old crhs.toml still holds are imported into the database only when it has no value for
	// them; a key that is already stored is a startup error (two sources would silently disagree).
	let settings: SettingsStore;
	try {
		await importSettingsFromFile(db, configFile.moved, (message) => console.warn(`crhs: ${message}`));
		settings = await SettingsStore.load(db);
	} catch (err) {
		console.error(`crhs: ${values.config}: ${(err as Error).message}`);
		process.exit(2);
	}
	// Every Argon2id computation, including `user add` and `user passwd`, goes through this one gate.
	// It reads System settings from the database, which is why this happens after the database is open.
	configureHashGate({
		concurrency: settings.current().auth.argon2Concurrency,
		queue: settings.current().auth.argon2Queue,
	});

	let dbDestroyed = false;
	try {
		if (command === "serve") {
			const masterKey = await readMasterKeyFile(config.masterKeyFile);
			await bindMasterKey(db, masterKey);
			await runServer(config, db, masterKey, settings);
		} else {
			try {
				if (command === "keys" && args[0] === "init") {
					await initKeys(config, db);
					console.log(`created ${config.masterKeyFile}; back it up with "crhs keys export"`);
				} else if (command === "keys" && args[0] === "export" && values.out) {
					const data = await exportKeys(config, db, values.out, await readExportPassphrase());
					console.log(`exported the master key and ${data.keys.length} server key(s) to ${values.out}`);
				} else if (command === "keys" && args[0] === "import" && args[1]) {
					const key = await importKeys(config, db, args[1], await readSecret("Export passphrase: "));
					console.log(`restored ${config.masterKeyFile} (master key id ${key.id})`);
				} else if (command === "user" && args[0] === "add" && args[1]) {
					const user = await addUser(db, args[1], {
						password: await readNewPassword(),
						kind: values.admin ? "admin" : "member",
						displayName: values["display-name"],
					});
					console.log(`created ${user.kind} ${user.username} (${user.id})`);
				} else if (command === "user" && args[0] === "passwd" && args[1]) {
					const user = await changePassword(db, args[1], await readNewPassword());
					console.log(`password updated for ${user.username}`);
				} else {
					console.error(USAGE);
					process.exitCode = 2;
				}
			} finally {
				await db.destroy();
				dbDestroyed = true;
			}
		}
	} catch (err) {
		if (!(err instanceof UserError || err instanceof KeyError)) throw err;
		console.error(`crhs: ${err.message}`);
		process.exitCode = 1;
		// serve keeps its database open on purpose; a command closed it in the finally above.
		if (!dbDestroyed) await db.destroy();
	}
}

async function readNewPassword(): Promise<string> {
	const password = await readSecret("Password: ");
	if (process.stdin.isTTY && (await readSecret("Repeat password: ")) !== password) {
		throw new UserError("passwords do not match");
	}
	return password;
}

async function readExportPassphrase(): Promise<string> {
	const passphrase = await readSecret("Export passphrase: ");
	if (process.stdin.isTTY && (await readSecret("Repeat passphrase: ")) !== passphrase) {
		throw new KeyError("passphrases do not match");
	}
	return passphrase;
}

async function runServer(config: Config, db: Db, masterKey: MasterKey, settings: SettingsStore): Promise<void> {
	const identity = await loadServerIdentity(db, masterKey);
	// The first key is created on first start; its public key is what nodes put in a crhs trust entry.
	// Administrators can add and delete keys while crhs runs (doc/design/privilege.md "Authorization signing key").
	const signingKeys = await loadAuthorizationSigningKeys(db, masterKey);
	const audit = new Audit(db);
	const cluster = new Cluster(db, {
		sshRoute: (node) => nodeRoute(db, masterKey, node),
		signingKeys,
		settings,
		audit,
	});
	const agents = new AgentServer(db, identity, cluster, audit);
	const taskGroups = new TaskGroups(db, cluster, { audit });
	await taskGroups.recover();
	// Tasks a previous process left dispatched or running end as the nodes' connections did not survive it
	// (doc/design/execution.md "Reconnect"): a client node gets the reconnect grace, an SSH node does not. Tasks
	// still between their claim and their dispatch end here too, after the task groups that own them.
	await cluster.recover();
	const models = new ModelConfig(db, masterKey);
	await models.reload();
	// A function, so that a Harness a storage error closed is reopened on fresh storage.
	const agentStorage = createStorageOpener(() => openAgentStorage(config.database));
	const runtime = await AgentRuntime.open({
		db,
		storage: agentStorage.open,
		models,
		cluster,
		taskGroups,
		audit,
	});
	// Signature waits that outlived their deadline while crhs was down end before requests are served.
	await cluster.expireAuthorizationWaits();
	// A token that expired while crhs was down must not leave its waiting work behind either.
	await rejectExpiredTokenWaits(db, cluster, taskGroups);
	// Recovery (leftover pending runs, then runs that ended while the process was down) happens before the loop.
	const scheduler = new Scheduler({ db, runtime, audit });
	const drain = new RequestDrain();
	const app = createApp(db, {
		clientAddress: createClientAddress(() => settings.current().realIpHeader),
		settings,
		serverFingerprint: identity.fingerprint,
		serverPublicKey: identity.keyPair.publicKey,
		cluster,
		taskGroups,
		signingKeys,
		masterKey,
		webRoot: config.webRoot,
		audit,
		agent: { runtime, models },
		scheduler,
		drain,
	});
	await scheduler.start();
	// serve() is typed for HTTP/2 too; crhs listens over HTTP/1, whose connections can be drained.
	const server = serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (info) => {
		console.log(
			`crhs listening on http://${info.address}:${info.port} (identity ${identity.fingerprint}, ${signingKeys.describe()})`,
		);
	}) as Server;
	server.on("upgrade", (req, socket, head) => {
		if (!agents.handleUpgrade(req, socket, head)) socket.destroy();
	});
	// The last sweeps are awaited at shutdown, so they cannot write after the database is destroyed.
	let sweepRun: Promise<void> = Promise.resolve();
	// Every five minutes: expired login sessions, signature waits past their deadline, and the waiting
	// work of expired API tokens.
	const sweep = setInterval(
		() => {
			sweepRun = Promise.all([
				deleteExpiredWebSessions(db).catch((err: unknown) => console.error("session sweep failed:", err)),
				cluster
					.expireAuthorizationWaits()
					.catch((err: unknown) => console.error("authorization wait sweep failed:", err)),
				rejectExpiredTokenWaits(db, cluster, taskGroups).catch((err: unknown) =>
					console.error("API token expiry sweep failed:", err),
				),
			]).then(() => {});
		},
		5 * 60 * 1000,
	);
	// Retention deletes rows past their configured age: once shortly after startup, then hourly. The
	// getter reads System settings at each run, so a changed window applies without a restart.
	const retention = startRetentionSweep(db, () => settings.current().retention);
	let shuttingDown = false;
	// Awaited end to end, so nothing writes to the database after db.destroy().
	const shutdown = async () => {
		// 1. Stop taking new work: refuse new requests, end the open event streams, and stop agent handshakes.
		clearInterval(sweep);
		server.close();
		server.closeIdleConnections();
		drain.begin();
		agents.stopAccepting();
		await sweepRun;
		await retention.stop();
		// 2. Stop the scheduler before the agent runtime closes: it must not start another submit, and an
		// in-flight one is awaited here (doc/design/scheduling.md). Then close the agent runtime before ending any wait.
		// An agent tool call is a durable task, not a request: the Harness aborts and joins it without recording
		// a result, so after a restart it reruns and reattaches to the same cluster task. Ending the waits first
		// would let the call return a non-final state, which durable records as its outcome.
		await scheduler.stop();
		await runtime.close();
		await agentStorage.close();
		// 3. Only HTTP and MCP waits are left: end them, so each returns its current state at once and step 4
		// does not wait out its timeout.
		cluster.endWaits();
		taskGroups.endWaits();
		// 4. Wait for the requests already being handled, then drop whatever connection is left.
		await drain.waitForIdle();
		server.closeAllConnections();
		// 5. Close node links and SSH sessions, then wait for the work the close started.
		await cluster.close();
		await taskGroups.close();
		await agents.close();
		await audit.flush();
		// 6. The database goes last.
		await db.destroy();
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			if (shuttingDown) {
				console.error(`crhs: ${signal} during shutdown, exiting`);
				process.exit(1);
			}
			shuttingDown = true;
			const timer = setTimeout(() => {
				console.error(`crhs: shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS} ms, exiting`);
				process.exit(1);
			}, SHUTDOWN_TIMEOUT_MS);
			shutdown().then(
				() => {
					clearTimeout(timer);
					process.exit(0);
				},
				(err: unknown) => {
					clearTimeout(timer);
					console.error("crhs: shutdown failed:", err);
					process.exit(1);
				},
			);
		});
	}
}
