import ssh2 from "ssh2";
import { secretAad } from "../../keys/export.ts";
import type { MasterKey } from "../../keys/master-key.ts";
import type { Db } from "../../storage/db.ts";
import { defaultOrgId, NotFoundError, UserError } from "../../users/service.ts";
import { newId } from "../../util/id.ts";
import { assertNameAvailable, availableGeneratedName, nameKey, validateName } from "../names.ts";
import type { NodeRow } from "../nodes.ts";
import type { SshHop, SshRoute } from "./connection.ts";

const SECRET_KIND = "ssh_private_key";
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_JUMPS = 5;

export interface SshCredentialUser {
	id: string;
	name: string;
}

export interface SshCredential {
	id: string;
	name: string;
	publicKey: string;
	createdAt: string;
	/** The nodes this credential authenticates; its key is used on every hop of their route. */
	usedBy: SshCredentialUser[];
}

/**
 * An ed25519 key pair that ssh2 can load again. ssh2's keygen strips every leading zero byte of the DER
 * BIT STRING, not just the unused-bits byte, so a public key starting with 0x00 (1 in 256) comes out
 * 31 bytes long and both halves are unusable ("Malformed OpenSSH private key"; OpenSSH rejects them too).
 * Upstream: https://github.com/mscdex/ssh2/issues/1514 — drop the retry once that is fixed.
 */
export function generateKeyPair(comment: string): { private: string; public: string } {
	for (let attempt = 0; attempt < 20; attempt++) {
		const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment });
		if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair;
	}
	throw new Error("could not generate a usable SSH key");
}

/** crhs generates the key; only the public half ever leaves it (for authorized_keys). */
export async function createSshCredential(db: Db, masterKey: MasterKey, name: string): Promise<SshCredential> {
	const label = name.trim() || "crh";
	const pair = generateKeyPair(`crh:${label}`);
	const orgId = await defaultOrgId(db);
	const secretId = newId();
	const now = new Date().toISOString();
	const cred = { id: newId(), name: label, publicKey: pair.public, createdAt: now, usedBy: [] };
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("secrets")
			.values({
				id: secretId,
				org_id: orgId,
				kind: SECRET_KIND,
				ciphertext: masterKey.encrypt(Buffer.from(pair.private), secretAad(secretId, SECRET_KIND)),
				created_at: now,
			})
			.execute();
		await trx
			.insertInto("ssh_credentials")
			.values({
				id: cred.id,
				org_id: orgId,
				name: label,
				public_key: pair.public,
				secret_id: secretId,
				created_at: now,
			})
			.execute();
	});
	return cred;
}

/**
 * The nodes that use each credential, keyed by credential id: a node's `ssh_credential_id` authenticates
 * every hop of its route. One query over nodes, so listing every credential stays at two queries.
 */
export async function sshCredentialUsage(db: Db, credentialId?: string): Promise<Map<string, SshCredentialUser[]>> {
	const nodes = await db.selectFrom("nodes").select(["id", "name", "ssh_credential_id"]).orderBy("name").execute();
	const usage = new Map<string, SshCredentialUser[]>();
	for (const node of nodes) {
		const id = node.ssh_credential_id;
		if (!id || (credentialId !== undefined && id !== credentialId)) continue;
		const users = usage.get(id) ?? [];
		users.push({ id: node.id, name: node.name });
		usage.set(id, users);
	}
	return usage;
}

export async function listSshCredentials(db: Db): Promise<SshCredential[]> {
	const [rows, usage] = await Promise.all([
		db.selectFrom("ssh_credentials").selectAll().orderBy("created_at").execute(),
		sshCredentialUsage(db),
	]);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		publicKey: r.public_key,
		createdAt: r.created_at,
		usedBy: usage.get(r.id) ?? [],
	}));
}

/** The private key of a credential; SSH credentials are organization-owned and managed by administrators. */
async function credentialKey(db: Db, masterKey: MasterKey, credentialId: string): Promise<string> {
	const cred = await db.selectFrom("ssh_credentials").selectAll().where("id", "=", credentialId).executeTakeFirst();
	if (!cred) throw new NotFoundError("no such SSH credential");
	const secret = await db.selectFrom("secrets").selectAll().where("id", "=", cred.secret_id).executeTakeFirstOrThrow();
	return masterKey.decrypt(secret.ciphertext, secretAad(secret.id, secret.kind)).toString("utf8");
}

export interface SshTargetInput {
	host: string;
	port?: number;
	user: string;
	hostKey?: string;
	jumps?: { host: string; port?: number; user: string; hostKey?: string }[];
	credentialId: string;
}

function hop(h: { host: string; port?: number; user: string; hostKey?: string }, what: string): SshHop {
	if (typeof h.host !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(h.host))
		throw new UserError(`${what}: invalid host`);
	if (typeof h.user !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(h.user))
		throw new UserError(`${what}: invalid user`);
	const port = h.port ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`${what}: invalid port`);
	const hostKey = h.hostKey ?? "";
	if (hostKey !== "" && !HOST_KEY.test(hostKey))
		throw new UserError(`${what}: host key must look like SHA256:<base64>`);
	return { host: h.host, port, user: h.user, hostKey };
}

/** Validates user input into a route (unpinned hops allowed, for probing). */
export async function routeFromInput(db: Db, masterKey: MasterKey, input: SshTargetInput): Promise<SshRoute> {
	const jumps = input.jumps ?? [];
	if (!Array.isArray(jumps) || jumps.length > MAX_JUMPS) throw new UserError(`at most ${MAX_JUMPS} jump hosts`);
	return {
		hops: [...jumps.map((j, i) => hop(j, `jump ${i + 1}`)), hop(input, "target")],
		privateKey: await credentialKey(db, masterKey, input.credentialId),
	};
}

/** Adds an SSH node; every hop's host key must be pinned (confirmed by the user after probing). */
export async function createSshNode(
	db: Db,
	masterKey: MasterKey,
	input: SshTargetInput & { name?: string },
	approvedByUserId: string | null = null,
): Promise<NodeRow> {
	const route = await routeFromInput(db, masterKey, input);
	if (route.hops.some((h) => !h.hostKey)) throw new UserError("every hop needs a confirmed host key");
	const target = route.hops[route.hops.length - 1] as SshHop;
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	if (input.name !== undefined && typeof input.name !== "string") throw new UserError("name must be a string");
	const explicitName = input.name?.trim() ? validateName(input.name, "node name") : undefined;
	return db.transaction().execute(async (trx) => {
		if (explicitName) await assertNameAvailable(trx, orgId, explicitName);
		const name = explicitName ?? (await availableGeneratedName(trx, orgId, target.host));
		const node: NodeRow = {
			id: newId(),
			org_id: orgId,
			name,
			name_key: nameKey(name),
			transport: "ssh",
			status: "active",
			public_key: null,
			hostname: target.host,
			facts: null,
			client_version: null,
			// SSH has no crha and no privileged mode; tasks run as the SSH user (D81).
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: approvedByUserId,
			ssh_host: target.host,
			ssh_port: target.port,
			ssh_user: target.user,
			ssh_host_key: target.hostKey,
			ssh_credential_id: input.credentialId,
			ssh_jumps: JSON.stringify(route.hops.slice(0, -1)),
			trust_report: null,
			trust_digest: null,
			trust_updated_at: null,
		};
		await trx.insertInto("nodes").values(node).execute();
		return node;
	});
}

/** Deletes an unused credential and its private key; an in-use credential is refused by the route. */
export async function deleteSshCredential(db: Db, credentialId: string): Promise<void> {
	await db.transaction().execute(async (trx) => {
		const cred = await trx
			.selectFrom("ssh_credentials")
			.select("secret_id")
			.where("id", "=", credentialId)
			.executeTakeFirst();
		if (!cred) throw new NotFoundError("no such SSH credential");
		await trx.deleteFrom("ssh_credentials").where("id", "=", credentialId).execute();
		await trx.deleteFrom("secrets").where("id", "=", cred.secret_id).execute();
	});
}

export interface SshNodeDetails {
	/** Jump hosts in order, then the node itself; every host key is pinned. */
	hops: SshHop[];
	credential: { id: string; name: string | null };
}

/** How crhs reaches an SSH node, for administrators. */
export async function sshNodeDetails(db: Db, node: NodeRow): Promise<SshNodeDetails | undefined> {
	if (node.transport !== "ssh" || !node.ssh_host || !node.ssh_user || !node.ssh_credential_id) return undefined;
	const cred = await db
		.selectFrom("ssh_credentials")
		.select("name")
		.where("id", "=", node.ssh_credential_id)
		.executeTakeFirst();
	// Only the route fields are part of the response, whatever else a stored jump may carry.
	const jumps = (JSON.parse(node.ssh_jumps ?? "[]") as SshHop[]).map(({ host, port, user, hostKey }) => ({
		host,
		port,
		user,
		hostKey,
	}));
	return {
		hops: [
			...jumps,
			{ host: node.ssh_host, port: node.ssh_port ?? 22, user: node.ssh_user, hostKey: node.ssh_host_key ?? "" },
		],
		credential: { id: node.ssh_credential_id, name: cred?.name ?? null },
	};
}

/** The connection route of an SSH node, for the transport. */
export async function nodeRoute(db: Db, masterKey: MasterKey, node: NodeRow): Promise<SshRoute> {
	if (node.transport !== "ssh" || !node.ssh_host || !node.ssh_user || !node.ssh_credential_id || !node.ssh_host_key) {
		throw new Error(`node ${node.id} is not a complete SSH node`);
	}
	const jumps = JSON.parse(node.ssh_jumps ?? "[]") as SshHop[];
	return {
		hops: [
			...jumps,
			{ host: node.ssh_host, port: node.ssh_port ?? 22, user: node.ssh_user, hostKey: node.ssh_host_key },
		],
		privateKey: await credentialKey(db, masterKey, node.ssh_credential_id),
	};
}
