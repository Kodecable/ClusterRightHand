import { createHash, randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import type { NodesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import { availableGeneratedName, nameKey } from "../util/names.ts";

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
	let createdByUserId = "";
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
		createdByUserId = token.created_by_user_id;

		const name = await availableGeneratedName(trx, token.org_id, token.name_hint ?? input.hostname);
		const node: Selectable<NodesTable> = {
			id: newId(),
			org_id: token.org_id,
			name,
			name_key: nameKey(name),
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
			trust_report: null,
			trust_digest: null,
			trust_updated_at: null,
		};
		await trx.insertInto("nodes").values(node).execute();
		await trx.updateTable("enrollment_tokens").set({ used_by_node_id: node.id }).where("id", "=", token.id).execute();
		return node;
	});
	if (input.audit)
		void input.audit
			.record({
				actor: { type: "system", id: "enrollment", onBehalfOfUserId: createdByUserId },
				action: "node.enrollment_requested",
				target: { type: "node", id: enrolled.id },
				detail: { name: enrolled.name, hostname: input.hostname, client_version: input.clientVersion },
			})
			.catch((err: unknown) => console.error("audit: failed to record node.enrollment_requested:", err));
	return enrolled;
}
