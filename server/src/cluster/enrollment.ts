import { createHash, randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import type { NodesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";

export class EnrollmentError extends UserError {}

const TOKEN_PREFIX = "crh1";
const INVALID_TOKEN = "invalid, expired or already used enrollment token";

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

export interface CreatedEnrollmentToken {
	id: string;
	/** `crh1.<serverFingerprint>.<secret>`; shown once, only its hash is stored. */
	token: string;
	expiresAt: string;
}

export async function createEnrollmentToken(
	db: Db,
	input: { userId: string; nameHint?: string; ttlMs?: number; serverFingerprint: string; now?: Date },
): Promise<CreatedEnrollmentToken> {
	const now = input.now ?? new Date();
	const user = await db.selectFrom("users").select("org_id").where("id", "=", input.userId).executeTakeFirst();
	if (!user) throw new NotFoundError("no such user");
	const secret = randomBytes(32).toString("base64url");
	const id = newId();
	const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 3_600_000)).toISOString();
	await db
		.insertInto("enrollment_tokens")
		.values({
			id,
			org_id: user.org_id,
			created_by_user_id: input.userId,
			token_hash: hashSecret(secret),
			name_hint: input.nameHint?.trim() || null,
			expires_at: expiresAt,
			used_at: null,
			used_by_node_id: null,
			created_at: now.toISOString(),
		})
		.execute();
	return { id, token: `${TOKEN_PREFIX}.${input.serverFingerprint}.${secret}`, expiresAt };
}

export function parseEnrollmentToken(token: string): { fingerprint: string; secret: string } {
	const parts = token.trim().split(".");
	const [prefix, fingerprint, secret] = parts;
	if (parts.length !== 3 || prefix !== TOKEN_PREFIX || !fingerprint || !secret) {
		throw new EnrollmentError("malformed enrollment token");
	}
	return { fingerprint, secret };
}

/** A valid node name: lowercase `[a-z0-9._-]`, at most 63 characters. */
export function sanitizeNodeName(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.slice(0, 63);
	return name.replace(/^-+|-+$/g, "") || "node";
}

export async function uniqueNodeName(
	db: Pick<Db, "selectFrom">,
	orgId: string,
	raw: string,
	exceptNodeId?: string,
): Promise<string> {
	const base = sanitizeNodeName(raw);
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? "" : `-${n}`;
		const candidate = base.slice(0, 63 - suffix.length) + suffix;
		let q = db.selectFrom("nodes").select("id").where("org_id", "=", orgId).where("name", "=", candidate);
		if (exceptNodeId) q = q.where("id", "!=", exceptNodeId);
		if (!(await q.executeTakeFirst())) return candidate;
	}
}

export async function enrollNode(
	db: Db,
	input: {
		secret: string;
		publicKey: Uint8Array;
		hostname: string;
		facts: unknown;
		clientVersion: string;
		now?: Date;
		audit?: Audit;
	},
): Promise<Selectable<NodesTable>> {
	const now = (input.now ?? new Date()).toISOString();
	const publicKey = Buffer.from(input.publicKey).toString("base64");
	const enrolled = await db.transaction().execute(async (trx) => {
		if (await trx.selectFrom("nodes").select("id").where("public_key", "=", publicKey).executeTakeFirst()) {
			throw new EnrollmentError("public key is already registered");
		}
		const tokenHash = hashSecret(input.secret);
		const claimed = await trx
			.updateTable("enrollment_tokens")
			.set({ used_at: now })
			.where("token_hash", "=", tokenHash)
			.where("used_at", "is", null)
			.where("expires_at", ">", now)
			.executeTakeFirst();
		if (claimed.numUpdatedRows !== 1n) throw new EnrollmentError(INVALID_TOKEN);
		const token = await trx
			.selectFrom("enrollment_tokens")
			.selectAll()
			.where("token_hash", "=", tokenHash)
			.executeTakeFirstOrThrow();

		const node: Selectable<NodesTable> = {
			id: newId(),
			org_id: token.org_id,
			owner_user_id: token.created_by_user_id,
			name: await uniqueNodeName(trx, token.org_id, token.name_hint ?? input.hostname),
			transport: "client",
			status: "pending",
			public_key: publicKey,
			hostname: input.hostname,
			facts: JSON.stringify(input.facts ?? null),
			client_version: input.clientVersion,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: null,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_key: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		};
		await trx.insertInto("nodes").values(node).execute();
		await trx.updateTable("enrollment_tokens").set({ used_by_node_id: node.id }).where("id", "=", token.id).execute();
		return node;
	});
	void input.audit?.record({
		actor: { type: "system", id: "enrollment", onBehalfOfUserId: enrolled.owner_user_id },
		action: "node.enrollment_requested",
		target: { type: "node", id: enrolled.id },
		detail: { name: enrolled.name, hostname: input.hostname, client_version: input.clientVersion },
	});
	return enrolled;
}
