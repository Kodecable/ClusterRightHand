import type { McpServerGrant, McpServerIdentityHeaders, McpServerInput, McpServerView } from "@crh/api";
import type { Selectable } from "kysely";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { McpServersTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";

/**
 * Stored MCP servers and their grants (doc/design/extensions.md "MCP servers"). The request headers live in
 * one `secrets` row encrypted with the master key, like a model provider's API key, so the API can report
 * which headers are set but never their values.
 */

export type McpServerRow = Selectable<McpServersTable>;

const SECRET_KIND = "mcp_server_headers";

/** The default per-call timeout: 5 minutes (doc/design/extensions.md "External calls"). */
export const DEFAULT_MCP_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;

/** Lowercase letters, digits and `-`, not starting with a digit; at most 64 characters (a tool name shares the limit). */
export const MCP_SERVER_NAME_RE = /^[a-z-][a-z0-9-]{0,63}$/;

export function validateMcpServerName(raw: string): string {
	if (!MCP_SERVER_NAME_RE.test(raw)) {
		throw new UserError(
			"the server name must be at most 64 characters of lowercase letters, digits and '-', not starting with a digit",
		);
	}
	return raw;
}

/** A validated server input, before it is written. */
interface ValidatedServer {
	description: string | null;
	url: string;
	headers: Record<string, string> | null;
	identityHeaders: McpServerIdentityHeaders;
	enabled: boolean;
	listDirectly: boolean;
	trustAnnotations: boolean;
	timeoutMs: number;
	grants: McpServerGrant[] | undefined;
}

/** What the connection manager needs to reach a server. */
export interface McpServerConfig {
	id: string;
	name: string;
	url: string;
	headers: Record<string, string>;
	identityHeaders: McpServerIdentityHeaders;
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
export function normalizeMcpServerUrl(url: string): string {
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

function parseIdentityHeaders(value: unknown): McpServerIdentityHeaders {
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

function parseGrants(value: unknown): McpServerGrant[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new UserError("grants must be a list");
	const out: McpServerGrant[] = [];
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

function validateInput(input: McpServerInput): ValidatedServer {
	const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_MS / 1000;
	if (
		typeof timeoutSeconds !== "number" ||
		!Number.isInteger(timeoutSeconds) ||
		timeoutSeconds < MIN_TIMEOUT_SECONDS ||
		timeoutSeconds > MAX_TIMEOUT_SECONDS
	) {
		throw new UserError(`timeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
	}
	return {
		description: textOrNull(input.description, "description", 2000),
		url: parseUrl(input.url),
		headers: parseHeaders(input.headers),
		identityHeaders: parseIdentityHeaders(input.identityHeaders),
		enabled: parseBoolean(input.enabled, true),
		listDirectly: parseBoolean(input.listDirectly, false),
		trustAnnotations: parseBoolean(input.trustAnnotations, true),
		timeoutMs: timeoutSeconds * 1000,
		grants: parseGrants(input.grants),
	};
}

export function parseIdentityHeadersJson(raw: string | null): McpServerIdentityHeaders {
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

/** The decrypted request headers of a server; a missing secret id means none. */
export async function readMcpHeaders(db: Db, masterKey: MasterKey, row: McpServerRow): Promise<Record<string, string>> {
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
		throw new Error(`the stored headers of MCP server ${row.name} cannot be decrypted`);
	}
}

/** The server's connection configuration; `undefined` when the row is gone. */
export async function mcpServerConfig(db: Db, masterKey: MasterKey, row: McpServerRow): Promise<McpServerConfig> {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		headers: await readMcpHeaders(db, masterKey, row),
		identityHeaders: parseIdentityHeadersJson(row.identity_headers),
		timeoutMs: row.timeout_ms,
		trustAnnotations: row.trust_annotations === 1,
		listDirectly: row.list_directly === 1,
		enabled: row.enabled === 1,
	};
}

export async function listMcpServerRows(db: Db): Promise<McpServerRow[]> {
	return db.selectFrom("mcp_servers").selectAll().orderBy("name").execute();
}

export async function getMcpServerRow(db: Db, name: string): Promise<McpServerRow | undefined> {
	const orgId = await defaultOrgId(db);
	return db
		.selectFrom("mcp_servers")
		.selectAll()
		.where("org_id", "=", orgId)
		.where("name", "=", name)
		.executeTakeFirst();
}

/** The grants of one server, and of all servers at once (for a list view). */
export async function mcpServerGrants(db: Db, serverId?: string): Promise<Map<string, McpServerGrant[]>> {
	let query = db.selectFrom("mcp_server_grants").select(["server_id", "grantee_type", "grantee_id"]);
	if (serverId !== undefined) query = query.where("server_id", "=", serverId);
	const rows = await query.execute();
	const out = new Map<string, McpServerGrant[]>();
	for (const row of rows) {
		const list = out.get(row.server_id) ?? [];
		list.push({ granteeType: row.grantee_type, granteeId: row.grantee_id });
		out.set(row.server_id, list);
	}
	return out;
}

/**
 * The servers a user may use: enabled servers granted to the user directly or through one of their user
 * groups. Administrators are not special here; an administrator who should use a server needs a grant too.
 */
export async function mcpServersForUser(db: Db, userId: string): Promise<McpServerRow[]> {
	const orgId = await defaultOrgId(db);
	const groups = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_id", "=", userId)
		.execute();
	const groupIds = groups.map((group) => group.user_group_id);
	const grants = await db
		.selectFrom("mcp_server_grants")
		.select("server_id")
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
	const ids = [...new Set(grants.map((grant) => grant.server_id))];
	if (ids.length === 0) return [];
	return db
		.selectFrom("mcp_servers")
		.selectAll()
		.where("org_id", "=", orgId)
		.where("id", "in", ids)
		.where("enabled", "=", 1)
		.orderBy("name")
		.execute();
}

/** The names of the servers a session may use: granted, enabled and not turned off in the session. */
export async function mcpServerNamesForUser(
	db: Db,
	userId: string,
	disabled: readonly string[] = [],
): Promise<string[]> {
	const rows = await mcpServersForUser(db, userId);
	return rows.filter((row) => row.enabled === 1 && !disabled.includes(row.name)).map((row) => row.name);
}

/** Whether this user may use this server (an enabled server granted to the user or one of their groups). */
export async function userCanUseMcpServer(db: Db, user: { userId: string }, row: McpServerRow): Promise<boolean> {
	if (row.enabled !== 1) return false;
	const groups = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_id", "=", user.userId)
		.execute();
	const groupIds = groups.map((group) => group.user_group_id);
	const grant = await db
		.selectFrom("mcp_server_grants")
		.select("id")
		.where("server_id", "=", row.id)
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

/** Parses the `disabledMcpServers` body field: a list of server names. */
export function parseDisabledMcpServers(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry !== "")) {
		throw new UserError("disabledMcpServers must be a list of server names");
	}
	return [...new Set(value)];
}

/** The JSON list of server names a session's owner turned off. */
export function parseDisabledServers(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

async function assertGranteesExist(db: Db, orgId: string, grants: McpServerGrant[]): Promise<void> {
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

/** Creates or replaces the server with this name; returns its row. */
export async function saveMcpServer(
	db: Db,
	masterKey: MasterKey,
	name: string,
	input: McpServerInput,
	adminUserId: string,
): Promise<{ row: McpServerRow; created: boolean }> {
	validateMcpServerName(name);
	const valid = validateInput(input);
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	let created = false;
	await db.transaction().execute(async (trx) => {
		const existing = await trx
			.selectFrom("mcp_servers")
			.selectAll()
			.where("org_id", "=", orgId)
			.where("name", "=", name)
			.executeTakeFirst();
		// Moving a server with stored headers to another endpoint re-sends them there, so the administrator
		// must re-enter or remove them: a typo or a tampered update cannot redirect the credentials.
		if (
			existing?.headers_secret_id &&
			normalizeMcpServerUrl(existing.url) !== normalizeMcpServerUrl(valid.url) &&
			input.headers === undefined
		) {
			throw new UserError("changing url requires re-entering the headers");
		}
		let secretId = existing?.headers_secret_id ?? null;
		if (valid.headers === null) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
		} else if (valid.headers !== null) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = newId();
			await trx
				.insertInto("secrets")
				.values({
					id: secretId,
					org_id: orgId,
					kind: SECRET_KIND,
					ciphertext: masterKey.encrypt(
						Buffer.from(JSON.stringify(valid.headers), "utf8"),
						secretAad(secretId, SECRET_KIND),
					),
					created_at: now,
				})
				.execute();
		}
		const values = {
			description: valid.description,
			url: valid.url,
			headers_secret_id: secretId,
			identity_headers:
				valid.identityHeaders.username || valid.identityHeaders.session ? JSON.stringify(valid.identityHeaders) : null,
			enabled: valid.enabled ? 1 : 0,
			list_directly: valid.listDirectly ? 1 : 0,
			trust_annotations: valid.trustAnnotations ? 1 : 0,
			timeout_ms: valid.timeoutMs,
			updated_at: now,
		};
		let serverId: string;
		if (existing) {
			serverId = existing.id;
			await trx.updateTable("mcp_servers").set(values).where("id", "=", existing.id).execute();
		} else {
			created = true;
			serverId = newId();
			await trx
				.insertInto("mcp_servers")
				.values({ id: serverId, org_id: orgId, name, created_at: now, ...values })
				.execute();
		}
		if (valid.grants !== undefined) {
			await assertGranteesExist(trx, orgId, valid.grants);
			await trx.deleteFrom("mcp_server_grants").where("server_id", "=", serverId).execute();
			for (const grant of valid.grants) {
				await trx
					.insertInto("mcp_server_grants")
					.values({
						id: newId(),
						org_id: orgId,
						server_id: serverId,
						grantee_type: grant.granteeType,
						grantee_id: grant.granteeId,
						created_by_user_id: adminUserId,
						created_at: now,
					})
					.execute();
			}
		}
	});
	const row = await getMcpServerRow(db, name);
	if (!row) throw new NotFoundError("no such MCP server");
	return { row, created };
}

export async function deleteMcpServer(db: Db, name: string): Promise<void> {
	const row = await getMcpServerRow(db, name);
	if (!row) throw new NotFoundError("no such MCP server");
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("mcp_server_grants").where("server_id", "=", row.id).execute();
		await trx.deleteFrom("mcp_servers").where("id", "=", row.id).execute();
		if (row.headers_secret_id) await trx.deleteFrom("secrets").where("id", "=", row.headers_secret_id).execute();
	});
}

/** The administrator's view of a server, with the stored header names but never their values. */
export async function mcpServerView(
	db: Db,
	masterKey: MasterKey,
	row: McpServerRow,
	status: McpServerView["status"],
): Promise<McpServerView> {
	const grants = (await mcpServerGrants(db, row.id)).get(row.id) ?? [];
	let headerNames: string[] = [];
	if (row.headers_secret_id) {
		try {
			headerNames = Object.keys(await readMcpHeaders(db, masterKey, row));
		} catch {
			headerNames = [];
		}
	}
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		url: row.url,
		hasHeaders: row.headers_secret_id !== null,
		headerNames,
		identityHeaders: parseIdentityHeadersJson(row.identity_headers),
		enabled: row.enabled === 1,
		listDirectly: row.list_directly === 1,
		trustAnnotations: row.trust_annotations === 1,
		timeoutSeconds: row.timeout_ms / 1000,
		grants,
		status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
