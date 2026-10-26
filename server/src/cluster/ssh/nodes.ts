import ssh2 from "ssh2";
import type { SessionUser } from "../../auth/sessions.ts";
import { secretAad } from "../../keys/export.ts";
import type { MasterKey } from "../../keys/master-key.ts";
import type { Db } from "../../storage/db.ts";
import { defaultOrgId, NotFoundError, UserError } from "../../users/service.ts";
import { newId } from "../../util/id.ts";
import { uniqueNodeName } from "../enrollment.ts";
import type { NodeRow } from "../nodes.ts";
import type { SshHop, SshRoute } from "./connection.ts";

const SECRET_KIND = "ssh_private_key";
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_JUMPS = 5;

export interface SshCredential {
	id: string;
	name: string;
	publicKey: string;
	ownerUserId: string;
	createdAt: string;
}

/** crhs generates the key; only the public half ever leaves it (for authorized_keys). */
export async function createSshCredential(
	db: Db,
	masterKey: MasterKey,
	owner: SessionUser,
	name: string,
): Promise<SshCredential> {
	const label = name.trim() || "crh";
	const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: `crh:${label}` });
	const orgId = await defaultOrgId(db);
	const secretId = newId();
	const now = new Date().toISOString();
	const cred = { id: newId(), name: label, publicKey: pair.public, ownerUserId: owner.userId, createdAt: now };
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
				owner_user_id: owner.userId,
				name: label,
				public_key: pair.public,
				secret_id: secretId,
				created_at: now,
			})
			.execute();
	});
	return cred;
}

export async function listSshCredentials(db: Db, user: SessionUser): Promise<SshCredential[]> {
	let q = db.selectFrom("ssh_credentials").selectAll().orderBy("created_at");
	if (user.kind !== "admin") q = q.where("owner_user_id", "=", user.userId);
	return (await q.execute()).map((r) => ({
		id: r.id,
		name: r.name,
		publicKey: r.public_key,
		ownerUserId: r.owner_user_id,
		createdAt: r.created_at,
	}));
}

/** The private key of a credential the user may use (their own; administrators: any). */
async function credentialKey(db: Db, masterKey: MasterKey, credentialId: string, user?: SessionUser): Promise<string> {
	const cred = await db.selectFrom("ssh_credentials").selectAll().where("id", "=", credentialId).executeTakeFirst();
	if (!cred || (user && user.kind !== "admin" && cred.owner_user_id !== user.userId)) {
		throw new NotFoundError("no such SSH credential");
	}
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
export async function routeFromInput(
	db: Db,
	masterKey: MasterKey,
	user: SessionUser,
	input: SshTargetInput,
): Promise<SshRoute> {
	const jumps = input.jumps ?? [];
	if (!Array.isArray(jumps) || jumps.length > MAX_JUMPS) throw new UserError(`at most ${MAX_JUMPS} jump hosts`);
	return {
		hops: [...jumps.map((j, i) => hop(j, `jump ${i + 1}`)), hop(input, "target")],
		privateKey: await credentialKey(db, masterKey, input.credentialId, user),
	};
}

/** Adds an SSH node; every hop's host key must be pinned (confirmed by the user after probing). */
export async function createSshNode(
	db: Db,
	masterKey: MasterKey,
	user: SessionUser,
	input: SshTargetInput & { name: string; groups?: string[] },
): Promise<NodeRow> {
	const route = await routeFromInput(db, masterKey, user, input);
	if (route.hops.some((h) => !h.hostKey)) throw new UserError("every hop needs a confirmed host key");
	const target = route.hops[route.hops.length - 1] as SshHop;
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const node: NodeRow = {
		id: newId(),
		org_id: orgId,
		owner_user_id: user.userId,
		name: await uniqueNodeName(db, orgId, input.name || target.host),
		transport: "ssh",
		status: "active",
		public_key: null,
		hostname: target.host,
		facts: null,
		client_version: null,
		privileged_mode: "native",
		last_seen_at: null,
		created_at: now,
		approved_at: now,
		approved_by_user_id: user.userId,
		ssh_host: target.host,
		ssh_port: target.port,
		ssh_user: target.user,
		ssh_host_key: target.hostKey,
		ssh_credential_id: input.credentialId,
		ssh_jumps: JSON.stringify(route.hops.slice(0, -1)),
	};
	await db.transaction().execute(async (trx) => {
		await trx.insertInto("nodes").values(node).execute();
		// SSH nodes have no crha to report groups; crhs maintains them (doc/access-control.md).
		for (const g of new Set(input.groups ?? [])) {
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(g)) throw new UserError(`invalid group name ${g}`);
			await trx.insertInto("node_groups").values({ node_id: node.id, group_name: g, refreshed_at: now }).execute();
		}
	});
	return node;
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
