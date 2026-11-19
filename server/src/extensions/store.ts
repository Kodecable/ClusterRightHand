import type {
	ExtensionAvailability,
	ExtensionConfigView,
	ExtensionDescriptionSource,
	ExtensionGrant,
	ExtensionIdentityHeaders,
	ExtensionInput,
	ExtensionView,
} from "@crh/api";
import type { Selectable } from "kysely";
import { canonicalJson } from "../audit/audit.ts";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { ExtensionsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import { type BuiltinExtensionProvider, builtinProvider, RESERVED_EXTENSION_NAMES } from "./builtin.ts";
import type { ExtensionTool } from "./model.ts";

/**
 * Stored extensions and their grants (doc/design/extensions.md "Extensions"). One table holds both kinds:
 * MCP servers an administrator connects and crhs's built-in extensions. An MCP extension's request headers
 * live in one `secrets` row encrypted with the master key, like a model provider's API key, so the API can
 * report which headers are set but never their values. A built-in has no URL, headers or connection
 * settings; the registry supplies its tools.
 */

export type ExtensionRow = Selectable<ExtensionsTable>;

const SECRET_KIND = "extension_headers";
/** The `secrets` kind of a built-in's secret settings. */
const CONFIG_SECRET_KIND = "extension_config";

/** The default per-call timeout of an MCP extension: 5 minutes. */
export const DEFAULT_EXTENSION_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;

/** Lowercase letters, digits and `-`, not starting with a digit; at most 64 characters. */
export const EXTENSION_NAME_RE = /^[a-z-][a-z0-9-]{0,63}$/;

export function validateExtensionName(raw: string): string {
	if (!EXTENSION_NAME_RE.test(raw)) {
		throw new UserError(
			"the extension name must be at most 64 characters of lowercase letters, digits and '-', not starting with a digit",
		);
	}
	return raw;
}

/** What the MCP connection manager needs to reach an MCP extension. */
export interface McpExtensionConfig {
	id: string;
	name: string;
	url: string;
	headers: Record<string, string>;
	identityHeaders: ExtensionIdentityHeaders;
	timeoutMs: number;
	trustAnnotations: boolean;
	listDirectly: boolean;
	enabled: boolean;
}

function parseHeaderName(value: unknown, what: string): string {
	if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) || value === "") {
		throw new UserError(`${what} must be an HTTP header name such as "Authorization"`);
	}
	return value;
}

function textOrNull(value: unknown, what: string, max: number): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new UserError(`${what} must be a string`);
	const text = value.trim();
	if (text.length > max) throw new UserError(`${what} is at most ${max} characters`);
	return text === "" ? null : text;
}

/** The normalised URL compared when deciding whether an update moves the endpoint; like model providers. */
export function normalizeExtensionUrl(url: string): string {
	const text = url.trim();
	try {
		const parsed = new URL(text).toString();
		return parsed.endsWith("/") ? parsed.slice(0, -1) : parsed;
	} catch {
		return text.replace(/\/+$/, "");
	}
}

function parseUrl(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") throw new UserError("url is required");
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new UserError("url must be an absolute http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("url must be an http(s) URL");
	if (url.hash !== "") throw new UserError("url must not have a fragment");
	return url.toString();
}

function parseHeaders(value: unknown): Record<string, string> | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) throw new UserError("headers must be a list of { name, value }");
	const out: Record<string, string> = {};
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new UserError("headers must be a list of { name, value }");
		}
		const record = entry as Record<string, unknown>;
		const name = parseHeaderName(record.name, "header name");
		const key = name.toLowerCase();
		if (seen.has(key)) throw new UserError(`the header ${name} is set twice`);
		seen.add(key);
		if (typeof record.value !== "string") throw new UserError(`the header ${name} needs a string value`);
		if (record.value === "") continue;
		out[name] = record.value;
	}
	return Object.keys(out).length === 0 ? null : out;
}

function parseIdentityHeaders(value: unknown): ExtensionIdentityHeaders {
	if (value === undefined || value === null) return { username: null, session: null };
	if (typeof value !== "object" || Array.isArray(value)) throw new UserError("identityHeaders must be an object");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "username" && key !== "session") throw new UserError(`unknown identity header field ${key}`);
	}
	const read = (key: "username" | "session"): string | null => {
		const raw = record[key];
		if (raw === undefined || raw === null || raw === "") return null;
		return parseHeaderName(raw, `identityHeaders.${key}`);
	};
	return { username: read("username"), session: read("session") };
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new UserError("expected a boolean");
	return value;
}

function parseAvailability(value: unknown, fallback: ExtensionAvailability): ExtensionAvailability {
	if (value === undefined) return fallback;
	if (value !== "everyone" && value !== "granted") throw new UserError("availability must be everyone or granted");
	return value;
}

function parseGrants(value: unknown): ExtensionGrant[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new UserError("grants must be a list");
	const out: ExtensionGrant[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new UserError("grants must be a list of { granteeType, granteeId }");
		}
		const record = entry as Record<string, unknown>;
		if (record.granteeType !== "user" && record.granteeType !== "user_group") {
			throw new UserError("granteeType must be user or user_group");
		}
		if (typeof record.granteeId !== "string" || record.granteeId === "") {
			throw new UserError("granteeId is required");
		}
		const key = `${record.granteeType}:${record.granteeId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ granteeType: record.granteeType, granteeId: record.granteeId });
	}
	return out;
}

function parseTimeoutSeconds(value: unknown, fallbackSeconds: number): number {
	if (value === undefined) return fallbackSeconds;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < MIN_TIMEOUT_SECONDS ||
		value > MAX_TIMEOUT_SECONDS
	) {
		throw new UserError(`timeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
	}
	return value;
}

function parseDescription(value: unknown): string | null {
	return textOrNull(value, "description", 2000);
}

/** The fields a built-in extension accepts; anything about connecting to a server is an MCP field. */
const MCP_ONLY_FIELDS = ["url", "headers", "identityHeaders", "trustAnnotations", "timeoutSeconds"] as const;

export function parseIdentityHeadersJson(raw: string | null): ExtensionIdentityHeaders {
	if (!raw) return { username: null, session: null };
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		return {
			username: typeof value.username === "string" ? value.username : null,
			session: typeof value.session === "string" ? value.session : null,
		};
	} catch {
		return { username: null, session: null };
	}
}

/** The decrypted request headers of an MCP extension; a missing secret id means none. */
export async function readExtensionHeaders(
	db: Db,
	masterKey: MasterKey,
	row: ExtensionRow,
): Promise<Record<string, string>> {
	if (!row.headers_secret_id) return {};
	const secret = await db
		.selectFrom("secrets")
		.select(["ciphertext"])
		.where("id", "=", row.headers_secret_id)
		.executeTakeFirst();
	if (!secret) return {};
	try {
		return JSON.parse(
			masterKey.decrypt(secret.ciphertext, secretAad(row.headers_secret_id, SECRET_KIND)).toString("utf8"),
		) as Record<string, string>;
	} catch {
		throw new Error(`the stored headers of extension ${row.name} cannot be decrypted`);
	}
}

/** The connection configuration of an MCP extension. */
export async function mcpExtensionConfig(db: Db, masterKey: MasterKey, row: ExtensionRow): Promise<McpExtensionConfig> {
	if (row.kind !== "mcp" || row.url === null) throw new Error(`extension ${row.name} is not an MCP extension`);
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		headers: await readExtensionHeaders(db, masterKey, row),
		identityHeaders: parseIdentityHeadersJson(row.identity_headers),
		timeoutMs: row.timeout_ms ?? DEFAULT_EXTENSION_TIMEOUT_MS,
		trustAnnotations: row.trust_annotations === 1,
		listDirectly: row.list_directly === 1,
		enabled: row.enabled === 1,
	};
}

export async function listExtensionRows(db: Db): Promise<ExtensionRow[]> {
	return db.selectFrom("extensions").selectAll().orderBy("name").execute();
}

export async function getExtensionRow(db: Db, name: string): Promise<ExtensionRow | undefined> {
	const orgId = await defaultOrgId(db);
	return db
		.selectFrom("extensions")
		.selectAll()
		.where("org_id", "=", orgId)
		.where("name", "=", name)
		.executeTakeFirst();
}

/** The grants of one extension, and of all extensions at once (for a list view). */
export async function extensionGrants(db: Db, extensionId?: string): Promise<Map<string, ExtensionGrant[]>> {
	let query = db.selectFrom("extension_grants").select(["extension_id", "grantee_type", "grantee_id"]);
	if (extensionId !== undefined) query = query.where("extension_id", "=", extensionId);
	const rows = await query.execute();
	const out = new Map<string, ExtensionGrant[]>();
	for (const row of rows) {
		const list = out.get(row.extension_id) ?? [];
		list.push({ granteeType: row.grantee_type, granteeId: row.grantee_id });
		out.set(row.extension_id, list);
	}
	return out;
}

/**
 * The extensions a user may use: enabled extensions available to everyone, plus enabled extensions granted
 * to the user directly or through one of their user groups. Administrators are not special here; an
 * administrator who should use a granted-only extension needs a grant too.
 */
export async function extensionsForUser(db: Db, userId: string): Promise<ExtensionRow[]> {
	const orgId = await defaultOrgId(db);
	const groups = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_id", "=", userId)
		.execute();
	const groupIds = groups.map((group) => group.user_group_id);
	const grants = await db
		.selectFrom("extension_grants")
		.select("extension_id")
		.where("org_id", "=", orgId)
		.where((eb) =>
			eb.or([
				eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
				...(groupIds.length === 0
					? []
					: [eb.and([eb("grantee_type", "=", "user_group"), eb("grantee_id", "in", groupIds)])]),
			]),
		)
		.execute();
	const ids = [...new Set(grants.map((grant) => grant.extension_id))];
	return db
		.selectFrom("extensions")
		.selectAll()
		.where("org_id", "=", orgId)
		.where("enabled", "=", 1)
		.where((eb) =>
			ids.length === 0
				? eb("availability", "=", "everyone")
				: eb.or([eb("availability", "=", "everyone"), eb("id", "in", ids)]),
		)
		.orderBy("name")
		.execute();
}

/** The names of the extensions a session may use: available to its owner and not turned off in the session. */
export async function extensionNamesForUser(
	db: Db,
	userId: string,
	disabled: readonly string[] = [],
): Promise<string[]> {
	const rows = await extensionsForUser(db, userId);
	return rows.filter((row) => !disabled.includes(row.name)).map((row) => row.name);
}

/** Whether this user may use this extension (enabled, and available to everyone or granted to the user). */
export async function userCanUseExtension(db: Db, user: { userId: string }, row: ExtensionRow): Promise<boolean> {
	if (row.enabled !== 1) return false;
	if (row.availability === "everyone") return true;
	const groups = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_id", "=", user.userId)
		.execute();
	const groupIds = groups.map((group) => group.user_group_id);
	const grant = await db
		.selectFrom("extension_grants")
		.select("id")
		.where("extension_id", "=", row.id)
		.where((eb) =>
			eb.or([
				eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", user.userId)]),
				...(groupIds.length === 0
					? []
					: [eb.and([eb("grantee_type", "=", "user_group"), eb("grantee_id", "in", groupIds)])]),
			]),
		)
		.limit(1)
		.executeTakeFirst();
	return grant !== undefined;
}

/** Parses the `disabledExtensions` body field: a list of extension names. */
export function parseDisabledExtensions(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry !== "")) {
		throw new UserError("disabledExtensions must be a list of extension names");
	}
	return [...new Set(value)];
}

/** The JSON list of extension names a session's owner turned off. */
export function parseDisabledExtensionNames(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

async function assertGranteesExist(db: Db, orgId: string, grants: ExtensionGrant[]): Promise<void> {
	for (const grant of grants) {
		const table = grant.granteeType === "user" ? "users" : "user_groups";
		const row = await db
			.selectFrom(table)
			.select("id")
			.where("org_id", "=", orgId)
			.where("id", "=", grant.granteeId)
			.executeTakeFirst();
		if (!row) throw new UserError(`no such ${grant.granteeType.replace("_", " ")}`);
	}
}

type ConfigValue = string | number | boolean;

/** A URL setting: an absolute http(s) URL with a host and no credentials, like an MCP extension's URL. */
function parseSettingUrl(key: string, value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new UserError(`the setting ${key} must be an absolute http(s) URL`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
		throw new UserError(`the setting ${key} must be an http(s) URL with a host`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new UserError(`the setting ${key} must not contain a username or password`);
	}
}

/** A built-in row's stored settings: the plain values and the names of the secret ones that are set. */
function storedConfig(row: Pick<ExtensionRow, "config">): { values: Record<string, ConfigValue>; secrets: string[] } {
	if (!row.config) return { values: {}, secrets: [] };
	try {
		const value = JSON.parse(row.config) as { values?: unknown; secrets?: unknown };
		const values =
			typeof value.values === "object" && value.values !== null && !Array.isArray(value.values)
				? (value.values as Record<string, ConfigValue>)
				: {};
		const secrets = Array.isArray(value.secrets)
			? value.secrets.filter((entry): entry is string => typeof entry === "string")
			: [];
		return { values, secrets };
	} catch {
		return { values: {}, secrets: [] };
	}
}

/** The required settings of a built-in that are not set; it cannot be enabled or called until they are. */
export function missingBuiltinConfig(row: Pick<ExtensionRow, "config">, provider: BuiltinExtensionProvider): string[] {
	const stored = storedConfig(row);
	return (provider.config ?? [])
		.filter((field) => field.required)
		.filter((field) =>
			field.kind === "secret" ? !stored.secrets.includes(field.key) : stored.values[field.key] === undefined,
		)
		.map((field) => field.key);
}

async function readConfigSecrets(
	db: Db,
	masterKey: MasterKey,
	secretId: string | null,
): Promise<Record<string, string>> {
	if (!secretId) return {};
	const secret = await db.selectFrom("secrets").select(["ciphertext"]).where("id", "=", secretId).executeTakeFirst();
	if (!secret) return {};
	return JSON.parse(
		masterKey.decrypt(secret.ciphertext, secretAad(secretId, CONFIG_SECRET_KIND)).toString("utf8"),
	) as Record<string, string>;
}

/** A built-in's settings for a call: defaults, the plain values set, and the secrets decrypted. */
export async function readBuiltinConfig(
	db: Db,
	masterKey: MasterKey,
	row: ExtensionRow,
	provider: BuiltinExtensionProvider,
): Promise<Record<string, ConfigValue>> {
	const stored = storedConfig(row);
	let secrets: Record<string, string>;
	try {
		secrets = await readConfigSecrets(db, masterKey, row.config_secret_id);
	} catch {
		throw new Error(`the stored settings of extension ${row.name} cannot be decrypted`);
	}
	const out: Record<string, ConfigValue> = {};
	for (const field of provider.config ?? []) {
		const value = field.kind === "secret" ? secrets[field.key] : stored.values[field.key];
		if (value !== undefined) out[field.key] = value;
		else if (field.default !== null) out[field.key] = field.default;
	}
	return out;
}

/** The administrator's view of a built-in's settings; secret values never leave crhs. */
function builtinConfigView(row: ExtensionRow): ExtensionConfigView | null {
	const provider = row.kind === "builtin" ? builtinProvider(row.name) : undefined;
	if (!provider?.config || provider.config.length === 0) return null;
	const stored = storedConfig(row);
	const values: Record<string, ConfigValue> = {};
	for (const field of provider.config) {
		const value = stored.values[field.key];
		if (field.kind !== "secret" && value !== undefined) values[field.key] = value;
	}
	return {
		fields: [...provider.config],
		values,
		secretsSet: provider.config
			.filter((field) => field.kind === "secret" && stored.secrets.includes(field.key))
			.map((field) => field.key),
		missing: missingBuiltinConfig(row, provider),
	};
}

/**
 * Applies a settings change to a built-in inside the caller's transaction: omitted keys keep their value,
 * null (or an empty string) removes one so its default applies, and a secret is re-encrypted with the
 * others. Returns the new columns.
 */
async function applyBuiltinConfig(
	trx: Db,
	masterKey: MasterKey,
	row: ExtensionRow,
	provider: BuiltinExtensionProvider,
	input: Record<string, ConfigValue | null>,
	orgId: string,
	now: string,
): Promise<{ config: string | null; config_secret_id: string | null }> {
	const fields = new Map((provider.config ?? []).map((field) => [field.key, field]));
	if (fields.size === 0) throw new UserError(`the extension ${row.name} has no settings`);
	const stored = storedConfig(row);
	const values = { ...stored.values };
	// Every stored secret the request replaces or removes; the rest would have to be kept.
	const rewritten = new Set(
		Object.keys(input).filter((key) => fields.get(key)?.kind === "secret" && stored.secrets.includes(key)),
	);
	const kept = stored.secrets.filter((key) => !rewritten.has(key));
	let secrets: Record<string, string> | undefined;
	const storedSecrets = async (): Promise<Record<string, string>> => {
		try {
			return await readConfigSecrets(trx, masterKey, row.config_secret_id);
		} catch {
			// Rare (a changed master key, a damaged row), but a secret must never be dropped silently.
			if (kept.length === 0) return {};
			throw new UserError(
				`the stored secret settings of ${row.name} cannot be decrypted, so they cannot be kept; ` +
					`enter ${kept.join(", ")} again`,
			);
		}
	};
	for (const [key, value] of Object.entries(input)) {
		const field = fields.get(key);
		if (!field) throw new UserError(`the extension ${row.name} has no setting ${key}`);
		if (value !== null) {
			const expected = field.kind === "secret" || field.kind === "url" ? "string" : field.kind;
			if (typeof value !== expected) throw new UserError(`the setting ${key} must be a ${expected}`);
			if (typeof value === "string" && value.length > 4000) throw new UserError(`the setting ${key} is too long`);
		}
		if (field.kind === "url" && typeof value === "string" && value !== "") parseSettingUrl(key, value);
		if (field.kind === "secret") {
			secrets ??= await storedSecrets();
			if (value === null || value === "") delete secrets[key];
			else secrets[key] = value as string;
		} else if (value === null || value === "") {
			delete values[key];
		} else {
			values[key] = value;
		}
	}
	// A URL setting carries the secrets to its endpoint, like an MCP extension's URL its headers: moving it
	// needs the secrets entered again (or removed), so a typo or a tampered update cannot redirect them.
	for (const field of fields.values()) {
		if (field.kind !== "url" || !(field.key in input)) continue;
		const effective = (from: Record<string, ConfigValue>) => from[field.key] ?? field.default ?? null;
		if (effective(values) === effective(stored.values) || kept.length === 0) continue;
		throw new UserError(`changing ${field.key} requires entering ${kept.join(", ")} again, or removing it`);
	}
	let secretId = row.config_secret_id;
	let secretNames = stored.secrets;
	if (secrets !== undefined) {
		if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
		secretId = null;
		secretNames = Object.keys(secrets);
		if (secretNames.length > 0) {
			secretId = newId();
			await trx
				.insertInto("secrets")
				.values({
					id: secretId,
					org_id: orgId,
					kind: CONFIG_SECRET_KIND,
					ciphertext: masterKey.encrypt(
						Buffer.from(JSON.stringify(secrets), "utf8"),
						secretAad(secretId, CONFIG_SECRET_KIND),
					),
					created_at: now,
				})
				.execute();
		}
	}
	const empty = Object.keys(values).length === 0 && secretNames.length === 0;
	return { config: empty ? null : JSON.stringify({ values, secrets: secretNames }), config_secret_id: secretId };
}

/**
 * Updates the fields of a built-in row; the connection fields are not part of its input, and neither is the
 * description: it is a constant of crhs, so a new version's wording reaches every installation.
 */
async function saveBuiltin(
	db: Db,
	masterKey: MasterKey,
	row: ExtensionRow,
	input: ExtensionInput,
	adminUserId: string,
): Promise<{ row: ExtensionRow; created: false }> {
	for (const field of [...MCP_ONLY_FIELDS, "description"] as const) {
		if (input[field] !== undefined) throw new UserError(`${field} cannot be set on a built-in extension`);
	}
	const provider = builtinProvider(row.name);
	if (!provider) throw new UserError(`the built-in extension ${row.name} is not available in this crhs`);
	const now = new Date().toISOString();
	const grants = parseGrants(input.grants);
	const orgId = await defaultOrgId(db);
	await db.transaction().execute(async (trx) => {
		const config =
			input.config === undefined
				? { config: row.config, config_secret_id: row.config_secret_id }
				: await applyBuiltinConfig(trx, masterKey, row, provider, input.config, orgId, now);
		const enabled = parseBoolean(input.enabled, row.enabled === 1);
		// A required setting such as an API key must be there before sessions can use the extension.
		const missing = missingBuiltinConfig(config, provider);
		if (enabled && missing.length > 0) {
			throw new UserError(`set ${missing.join(", ")} before enabling ${row.name}`);
		}
		await trx
			.updateTable("extensions")
			.set({
				...config,
				enabled: enabled ? 1 : 0,
				list_directly: parseBoolean(input.listDirectly, row.list_directly === 1) ? 1 : 0,
				availability: parseAvailability(input.availability, row.availability),
				updated_at: now,
			})
			.where("id", "=", row.id)
			.execute();
		if (grants !== undefined) {
			await assertGranteesExist(trx, orgId, grants);
			await trx.deleteFrom("extension_grants").where("extension_id", "=", row.id).execute();
			for (const grant of grants) {
				await trx
					.insertInto("extension_grants")
					.values({
						id: newId(),
						org_id: orgId,
						extension_id: row.id,
						grantee_type: grant.granteeType,
						grantee_id: grant.granteeId,
						created_by_user_id: adminUserId,
						created_at: now,
					})
					.execute();
			}
		}
	});
	const updated = (await getExtensionRow(db, row.name)) as ExtensionRow;
	return { row: updated, created: false };
}

/** Creates or updates an extension; a new extension is always an MCP extension. Returns its row. */
export async function saveExtension(
	db: Db,
	masterKey: MasterKey,
	name: string,
	input: ExtensionInput,
	adminUserId: string,
): Promise<{ row: ExtensionRow; created: boolean }> {
	validateExtensionName(name);
	const existing = await getExtensionRow(db, name);
	if (!existing && RESERVED_EXTENSION_NAMES.has(name)) {
		throw new UserError(`the extension name ${name} is reserved for a built-in extension`);
	}
	if (existing?.kind === "builtin") return saveBuiltin(db, masterKey, existing, input, adminUserId);
	if (input.config !== undefined)
		throw new UserError("settings are for built-in extensions; an MCP extension uses headers");
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const url = input.url === undefined ? (existing?.url ?? undefined) : parseUrl(input.url);
	if (url === undefined) throw new UserError("url is required");
	const headers = parseHeaders(input.headers);
	const identityHeaders =
		input.identityHeaders === undefined
			? parseIdentityHeadersJson(existing?.identity_headers ?? null)
			: parseIdentityHeaders(input.identityHeaders);
	const availability = parseAvailability(input.availability, existing?.availability ?? "granted");
	const timeoutMs =
		parseTimeoutSeconds(input.timeoutSeconds, (existing?.timeout_ms ?? DEFAULT_EXTENSION_TIMEOUT_MS) / 1000) * 1000;
	const grants = parseGrants(input.grants);
	let created = false;
	await db.transaction().execute(async (trx) => {
		// Moving an MCP extension with stored headers to another endpoint re-sends them there, so the
		// administrator must re-enter or remove them: a typo or a tampered update cannot redirect credentials.
		if (
			existing?.headers_secret_id &&
			normalizeExtensionUrl(existing.url ?? "") !== normalizeExtensionUrl(url) &&
			input.headers === undefined
		) {
			throw new UserError("changing url requires re-entering the headers");
		}
		let secretId = existing?.headers_secret_id ?? null;
		if (input.headers !== undefined) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
			if (headers !== null) {
				secretId = newId();
				await trx
					.insertInto("secrets")
					.values({
						id: secretId,
						org_id: orgId,
						kind: SECRET_KIND,
						ciphertext: masterKey.encrypt(
							Buffer.from(JSON.stringify(headers), "utf8"),
							secretAad(secretId, SECRET_KIND),
						),
						created_at: now,
					})
					.execute();
			}
		}
		const values = {
			description:
				input.description === undefined ? (existing?.description ?? null) : parseDescription(input.description),
			url,
			headers_secret_id: secretId,
			identity_headers: identityHeaders.username || identityHeaders.session ? JSON.stringify(identityHeaders) : null,
			enabled: parseBoolean(input.enabled, existing ? existing.enabled === 1 : true) ? 1 : 0,
			list_directly: parseBoolean(input.listDirectly, existing ? existing.list_directly === 1 : false) ? 1 : 0,
			availability,
			trust_annotations: parseBoolean(input.trustAnnotations, existing ? existing.trust_annotations === 1 : true)
				? 1
				: 0,
			timeout_ms: timeoutMs,
			updated_at: now,
		};
		const extensionId = existing?.id ?? newId();
		if (existing) {
			await trx.updateTable("extensions").set(values).where("id", "=", existing.id).execute();
		} else {
			created = true;
			await trx
				.insertInto("extensions")
				.values({ id: extensionId, org_id: orgId, name, kind: "mcp", created_at: now, ...values })
				.execute();
		}
		if (grants !== undefined) {
			await assertGranteesExist(trx, orgId, grants);
			await trx.deleteFrom("extension_grants").where("extension_id", "=", extensionId).execute();
			for (const grant of grants) {
				await trx
					.insertInto("extension_grants")
					.values({
						id: newId(),
						org_id: orgId,
						extension_id: extensionId,
						grantee_type: grant.granteeType,
						grantee_id: grant.granteeId,
						created_by_user_id: adminUserId,
						created_at: now,
					})
					.execute();
			}
		}
	});
	const row = await getExtensionRow(db, name);
	if (!row) throw new NotFoundError("no such extension");
	return { row, created };
}

export async function deleteExtension(db: Db, name: string): Promise<void> {
	const row = await getExtensionRow(db, name);
	if (!row) throw new NotFoundError("no such extension");
	if (row.kind === "builtin") throw new UserError("built-in extensions cannot be deleted");
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("extension_grants").where("extension_id", "=", row.id).execute();
		await trx.deleteFrom("extensions").where("id", "=", row.id).execute();
		if (row.headers_secret_id) await trx.deleteFrom("secrets").where("id", "=", row.headers_secret_id).execute();
	});
}

/**
 * The description the model is shown and where it comes from (doc/design/extensions.md "Extensions"): a
 * built-in's constant; for an MCP extension the administrator's text, else what the server last reported,
 * its `instructions` (written for the model) before its `serverInfo.description` (written for people).
 */
export function effectiveExtensionDescription(
	row: Pick<ExtensionRow, "kind" | "name" | "description" | "server_instructions" | "server_description">,
): { text: string | null; source: ExtensionDescriptionSource | null } {
	if (row.kind === "builtin") {
		const text = builtinProvider(row.name)?.description ?? null;
		return { text, source: text === null ? null : "builtin" };
	}
	if (row.description !== null) return { text: row.description, source: "admin" };
	if (row.server_instructions) return { text: row.server_instructions, source: "instructions" };
	if (row.server_description) return { text: row.server_description, source: "server" };
	return { text: null, source: null };
}

/** What an MCP server reported at its last refresh, as the extension row caches it. */
export interface ExtensionCache {
	instructions: string | null;
	description: string | null;
	tools: ExtensionTool[];
	toolsRev: number;
	refreshedAt: string | null;
	refreshError: string | null;
}

/** The cached tool list of a row; a damaged value reads as no list, which the next refresh replaces. */
export function cachedTools(row: Pick<ExtensionRow, "tools">): ExtensionTool[] {
	if (!row.tools) return [];
	try {
		const value = JSON.parse(row.tools) as unknown;
		return Array.isArray(value) ? (value as ExtensionTool[]) : [];
	} catch {
		return [];
	}
}

export function extensionCacheOf(row: ExtensionRow): ExtensionCache {
	return {
		instructions: row.server_instructions,
		description: row.server_description,
		tools: cachedTools(row),
		toolsRev: row.tools_rev,
		refreshedAt: row.refreshed_at,
		refreshError: row.refresh_error,
	};
}

/** Stores what a refresh found; a failed refresh writes only its error and keeps the last list. */
export async function saveExtensionCache(db: Db, name: string, cache: ExtensionCache): Promise<void> {
	const orgId = await defaultOrgId(db);
	await db
		.updateTable("extensions")
		.set({
			server_instructions: cache.instructions,
			server_description: cache.description,
			tools: JSON.stringify(cache.tools),
			tools_rev: cache.toolsRev,
			refreshed_at: cache.refreshedAt,
			refresh_error: cache.refreshError,
		})
		.where("org_id", "=", orgId)
		.where("name", "=", name)
		.where("kind", "=", "mcp")
		.execute();
}

/** The part of a tool that decides whether it changed: everything the model and the rules see. */
function toolDefinition(tool: ExtensionTool): string {
	return canonicalJson({
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
	});
}

/** Whether two definitions of a tool take the same arguments. */
export function sameInputSchema(a: ExtensionTool, b: ExtensionTool): boolean {
	return canonicalJson(a.inputSchema) === canonicalJson(b.inputSchema);
}

/**
 * A new listing against the cached one: an unchanged tool keeps its rev; if anything was added, removed or
 * changed, `tools_rev` goes up by one and the added and changed tools take it.
 */
export function revisedTools(
	previous: readonly ExtensionTool[],
	previousRev: number,
	listed: readonly ExtensionTool[],
): { tools: ExtensionTool[]; toolsRev: number } {
	const before = new Map(previous.map((tool) => [tool.name, tool]));
	const nextRev = previousRev + 1;
	let changed = listed.length !== previous.length;
	const tools = listed.map((tool) => {
		const old = before.get(tool.name);
		if (old && toolDefinition(old) === toolDefinition(tool)) return { ...tool, rev: old.rev ?? previousRev };
		changed = true;
		return { ...tool, rev: nextRev };
	});
	if (!changed) return { tools, toolsRev: previousRev };
	return { tools, toolsRev: nextRev };
}

/** The administrator's view of an extension, with stored header names but never their values. */
export async function extensionView(
	db: Db,
	masterKey: MasterKey,
	row: ExtensionRow,
	status: ExtensionView["status"],
): Promise<ExtensionView> {
	const grants = (await extensionGrants(db, row.id)).get(row.id) ?? [];
	const isMcp = row.kind === "mcp";
	let headerNames: string[] = [];
	if (isMcp && row.headers_secret_id) {
		try {
			headerNames = Object.keys(await readExtensionHeaders(db, masterKey, row));
		} catch {
			headerNames = [];
		}
	}
	const effective = effectiveExtensionDescription(row);
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		description: isMcp ? row.description : null,
		effectiveDescription: effective.text,
		descriptionSource: effective.source,
		url: isMcp ? row.url : null,
		hasHeaders: isMcp && row.headers_secret_id !== null,
		headerNames,
		identityHeaders: parseIdentityHeadersJson(row.identity_headers),
		enabled: row.enabled === 1,
		listDirectly: row.list_directly === 1,
		availability: row.availability,
		trustAnnotations: isMcp ? row.trust_annotations === 1 : null,
		timeoutSeconds: isMcp && row.timeout_ms !== null ? row.timeout_ms / 1000 : null,
		grants,
		config: builtinConfigView(row),
		status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
