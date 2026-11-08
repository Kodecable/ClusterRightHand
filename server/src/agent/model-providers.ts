// Stored model providers: listing, saving (with their API key secret) and deleting.

import type { Selectable } from "kysely";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import type { ModelProvidersTable } from "../storage/schema.ts";
import { defaultOrgId, NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import type { CustomModel, SessionIdConfig } from "./model-types.ts";
import { type ModelProviderInput, validate } from "./model-validate.ts";

export interface ModelProviderView {
	id: string;
	providerId: string;
	kind: ModelProvidersTable["kind"];
	builtin: string | null;
	name: string;
	baseUrl: string | null;
	hasApiKey: boolean;
	models: CustomModel[] | null;
	/** Extra request headers (custom only). */
	headers: Record<string, string> | null;
	/** Fields that carry the crh session id (custom only). */
	sessionId: SessionIdConfig | null;
	enabled: boolean;
}

const SECRET_KIND = "model_api_key";

/** A stored JSON column, or null when absent or unreadable. */
export function parseJson<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function toView(row: Selectable<ModelProvidersTable>): ModelProviderView {
	return {
		id: row.id,
		providerId: row.provider_id,
		kind: row.kind,
		builtin: row.builtin,
		name: row.name,
		baseUrl: row.base_url,
		hasApiKey: row.secret_id !== null,
		models: parseJson<CustomModel[]>(row.models),
		headers: parseJson<Record<string, string>>(row.headers),
		sessionId: parseJson<SessionIdConfig>(row.session_id),
		enabled: row.enabled === 1,
	};
}

export async function listModelProviders(db: Db): Promise<ModelProviderView[]> {
	return (await db.selectFrom("model_providers").selectAll().orderBy("provider_id").execute()).map(toView);
}

/**
 * A base URL as compared when deciding whether an update moves the endpoint: case and default ports are
 * normalised by `URL`, and one trailing slash is ignored. An unparsable value falls back to its trimmed text.
 */
export function normalizeBaseUrl(baseUrl: string | null): string | null {
	if (baseUrl === null) return null;
	const trimmed = baseUrl.trim();
	try {
		const url = new URL(trimmed).toString();
		return url.endsWith("/") ? url.slice(0, -1) : url;
	} catch {
		return trimmed === "" ? null : trimmed.replace(/\/+$/, "");
	}
}

/** Creates or replaces the provider with this provider id (administrators only; checked by the caller). */
export async function saveModelProvider(
	db: Db,
	masterKey: MasterKey,
	input: ModelProviderInput,
): Promise<ModelProviderView> {
	const valid = validate(input);
	const now = new Date().toISOString();
	const orgId = await defaultOrgId(db);
	await db.transaction().execute(async (trx) => {
		const existing = await trx
			.selectFrom("model_providers")
			.selectAll()
			.where("provider_id", "=", valid.providerId)
			.executeTakeFirst();
		// Moving an existing custom provider to another endpoint re-sends its stored key there, so the
		// administrator must re-enter the key: a typo or a tampered update cannot redirect the secret.
		const hasStoredKey = existing?.kind === "custom" && existing.secret_id !== null;
		// A new key, or removing the key (null), both mean the stored key is not sent to the new endpoint.
		const newApiKey = valid.apiKey === null || (typeof valid.apiKey === "string" && valid.apiKey !== "");
		if (
			hasStoredKey &&
			valid.kind === "custom" &&
			normalizeBaseUrl(existing?.base_url ?? null) !== normalizeBaseUrl(valid.baseUrl) &&
			!newApiKey
		) {
			throw new UserError("changing baseUrl requires re-entering the API key");
		}
		let secretId = existing?.secret_id ?? null;
		if (valid.apiKey === null && secretId) {
			await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
		} else if (typeof valid.apiKey === "string" && valid.apiKey) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = newId();
			await trx
				.insertInto("secrets")
				.values({
					id: secretId,
					org_id: orgId,
					kind: SECRET_KIND,
					ciphertext: masterKey.encrypt(Buffer.from(valid.apiKey), secretAad(secretId, SECRET_KIND)),
					created_at: now,
				})
				.execute();
		}
		const headers =
			valid.kind === "custom" && input.headers !== undefined ? valid.headers : (existing?.headers ?? null);
		const sessionId =
			valid.kind === "custom" && input.sessionId !== undefined ? valid.sessionId : (existing?.session_id ?? null);
		const values = {
			kind: valid.kind,
			builtin: valid.kind === "builtin" ? valid.providerId : null,
			name: valid.name?.trim() || existing?.name || valid.providerId,
			base_url: valid.baseUrl,
			secret_id: secretId,
			models: valid.kind === "custom" ? JSON.stringify(valid.models) : null,
			headers:
				valid.kind === "custom"
					? typeof headers === "string"
						? headers
						: headers && Object.keys(headers).length > 0
							? JSON.stringify(headers)
							: null
					: null,
			session_id:
				valid.kind === "custom"
					? typeof sessionId === "string"
						? sessionId
						: sessionId
							? JSON.stringify(sessionId)
							: null
					: null,
			enabled: valid.enabled === false ? 0 : 1,
			updated_at: now,
		};
		if (existing) {
			await trx.updateTable("model_providers").set(values).where("id", "=", existing.id).execute();
		} else {
			await trx
				.insertInto("model_providers")
				.values({ id: newId(), org_id: orgId, provider_id: valid.providerId, created_at: now, ...values })
				.execute();
		}
	});
	return (await listModelProviders(db)).find((p) => p.providerId === valid.providerId) as ModelProviderView;
}

export async function deleteModelProvider(db: Db, providerId: string): Promise<void> {
	const row = await db
		.selectFrom("model_providers")
		.selectAll()
		.where("provider_id", "=", providerId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such model provider");
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("model_providers").where("id", "=", row.id).execute();
		if (row.secret_id) await trx.deleteFrom("secrets").where("id", "=", row.secret_id).execute();
	});
}
