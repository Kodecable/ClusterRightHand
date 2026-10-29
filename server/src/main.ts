#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ModelConfig } from "./agent/models.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { createApp } from "./api/app.ts";
import { Audit } from "./audit/audit.ts";
import { deleteExpiredWebSessions } from "./auth/sessions.ts";
import { readSecret } from "./cli/prompt.ts";
import { AgentServer } from "./cluster/agent-server.ts";
import { Cluster } from "./cluster/cluster.ts";
import { loadServerIdentity } from "./cluster/identity.ts";
import { nodeRoute } from "./cluster/ssh/nodes.ts";
import { TaskGroups } from "./cluster/task-groups.ts";
import { type Config, DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { buildKeyExport, decryptKeyExport, encryptKeyExport, verifyKeyExportAgainstDb } from "./keys/export.ts";
import { bindMasterKey, KeyError, MasterKey, readMasterKeyFile, writeMasterKeyFile } from "./keys/master-key.ts";
import { loadAuthorizationSigningKey } from "./privilege/key.ts";
import { type Db, openAgentStorage, openDb } from "./storage/db.ts";
import { migrateToLatest } from "./storage/migrate.ts";
import { createUser, findUserByUsername, setPassword, UserError } from "./users/service.ts";

const USAGE = `usage: crhs [--config <path>] <command>

commands:
  serve                                 run the server (default)
  user add <username> [--admin] [--display-name <name>]
                                        create a user; the password is read from the terminal or stdin
  user passwd <username>                set a user's password
  keys init                             create the master key file (master_key_file)
  keys export --out <file>              write the master key and server keys to a passphrase-encrypted age file
  keys import <file>                    restore the master key file from an export, after checking it against the database`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: "string", short: "c", default: DEFAULT_CONFIG_PATH },
		admin: { type: "boolean", default: false },
		"display-name": { type: "string" },
		out: { type: "string", short: "o" },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

let config: Config;
try {
	config = await loadConfig(values.config);
} catch (err) {
	console.error(`crhs: ${values.config}: ${(err as Error).message}`);
	process.exit(2);
}
const db = openDb(config.database);
await migrateToLatest(db);

const [command = "serve", ...args] = positionals;
try {
	if (command === "serve") {
		const masterKey = await readMasterKeyFile(config.masterKeyFile);
		await bindMasterKey(db, masterKey);
		await runServer(config, db, masterKey);
	} else if (command === "keys" && args[0] === "init") {
		await initKeys(config, db);
	} else if (command === "keys" && args[0] === "export" && values.out) {
		await exportKeys(config, db, values.out);
	} else if (command === "keys" && args[0] === "import" && args[1]) {
		await importKeys(config, db, args[1]);
	} else if (command === "user" && args[0] === "add" && args[1]) {
		await addUser(db, args[1]);
	} else if (command === "user" && args[0] === "passwd" && args[1]) {
		await changePassword(db, args[1]);
	} else {
		console.error(USAGE);
		process.exitCode = 2;
		await db.destroy();
	}
} catch (err) {
	if (!(err instanceof UserError || err instanceof KeyError)) throw err;
	console.error(`crhs: ${err.message}`);
	process.exitCode = 1;
	await db.destroy();
}

async function readNewPassword(): Promise<string> {
	const password = await readSecret("Password: ");
	if (process.stdin.isTTY && (await readSecret("Repeat password: ")) !== password) {
		throw new UserError("passwords do not match");
	}
	return password;
}

async function addUser(db: Db, username: string): Promise<void> {
	const password = await readNewPassword();
	const user = await createUser(db, {
		username,
		password,
		kind: values.admin ? "admin" : "member",
		displayName: values["display-name"],
	});
	console.log(`created ${user.kind} ${user.username} (${user.id})`);
	await db.destroy();
}

async function changePassword(db: Db, username: string): Promise<void> {
	const user = await findUserByUsername(db, username);
	if (!user) throw new UserError(`no such user: ${username}`);
	await setPassword(db, user.id, await readNewPassword());
	console.log(`password updated for ${user.username}`);
	await db.destroy();
}

async function initKeys(config: Config, db: Db): Promise<void> {
	const key = MasterKey.generate();
	await bindMasterKey(db, key); // fails if the database already belongs to another master key
	await writeMasterKeyFile(config.masterKeyFile, key);
	console.log(`created ${config.masterKeyFile}; back it up with "crhs keys export"`);
	await db.destroy();
}

async function exportKeys(config: Config, db: Db, out: string): Promise<void> {
	const key = await readMasterKeyFile(config.masterKeyFile);
	await bindMasterKey(db, key);
	const passphrase = await readSecret("Export passphrase: ");
	if (process.stdin.isTTY && (await readSecret("Repeat passphrase: ")) !== passphrase) {
		throw new KeyError("passphrases do not match");
	}
	const data = await buildKeyExport(db, key);
	try {
		await writeFile(out, await encryptKeyExport(data, passphrase), { mode: 0o600, flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new KeyError(`${out} already exists`);
		throw err;
	}
	console.log(`exported the master key and ${data.keys.length} server key(s) to ${out}`);
	await db.destroy();
}

async function importKeys(config: Config, db: Db, file: string): Promise<void> {
	const data = await decryptKeyExport(await readFile(file, "utf8"), await readSecret("Export passphrase: "));
	const key = await verifyKeyExportAgainstDb(db, data);
	await bindMasterKey(db, key);
	await writeMasterKeyFile(config.masterKeyFile, key);
	console.log(`restored ${config.masterKeyFile} (master key id ${key.id})`);
	await db.destroy();
}

async function runServer(config: Config, db: Db, masterKey: MasterKey): Promise<void> {
	const identity = await loadServerIdentity(db, masterKey);
	// Created on first start; its public key is what nodes put in a crhs trust entry (doc/privilege.md).
	const authorizationKey = await loadAuthorizationSigningKey(db, masterKey);
	const audit = new Audit(db);
	const cluster = new Cluster(db, {
		sshRoute: (node) => nodeRoute(db, masterKey, node),
		authorizationKey,
		audit,
	});
	const agents = new AgentServer(db, identity, cluster, audit);
	const taskGroups = new TaskGroups(db, cluster, { audit });
	await taskGroups.recover();
	const models = new ModelConfig(db, masterKey);
	await models.reload();
	// A function, so that a Harness a storage error closed is reopened on fresh storage.
	let closeAgentStorage = async () => {};
	const openStorage = async () => {
		await closeAgentStorage();
		const opened = await openAgentStorage(config.database);
		closeAgentStorage = opened.close;
		return opened.storage;
	};
	const runtime = await AgentRuntime.open({
		db,
		storage: openStorage,
		models,
		cluster,
		groups: taskGroups,
		audit,
	});
	const app = createApp(db, {
		clientAddress: (c) => getConnInfo(c).remote.address,
		serverFingerprint: identity.fingerprint,
		serverPublicKey: identity.keyPair.publicKey,
		cluster,
		taskGroups,
		authorizationKey,
		masterKey,
		webRoot: config.webRoot,
		audit,
		agent: { runtime, models },
	});
	const server = serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (info) => {
		console.log(
			`crhs listening on http://${info.address}:${info.port} (identity ${identity.fingerprint}, signing key ${authorizationKey.fingerprint})`,
		);
	});
	server.on("upgrade", (req, socket, head) => {
		if (!agents.handleUpgrade(req, socket, head)) socket.destroy();
	});
	const sweep = setInterval(() => void deleteExpiredWebSessions(db), 60 * 60 * 1000);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			clearInterval(sweep);
			void runtime.close().then(() => closeAgentStorage());
			cluster.close();
			agents.close();
			server.close();
			void db.destroy();
		});
	}
}
