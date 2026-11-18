import type { AuthorizationOption, TaskAuthorizationView } from "@crh/api";

/** The authorization state of one task, as `tasks.authorization` stores it and the task views show it. */
export type TaskAuthorizationRecord = TaskAuthorizationView;

type SignOption = Extract<AuthorizationOption, { kind: "sign" }>;
type SignEntry = SignOption["entries"][number];
type SignPayload = NonNullable<SignOption["payload"]>;

/**
 * The stored record; malformed rows are treated as absent (the next authorization pass writes a new
 * one). A record without options parses with empty options: the next pass fills them in.
 */
export function parseTaskAuthorization(json: string | null): TaskAuthorizationRecord | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<TaskAuthorizationRecord> | null;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		return {
			options: parseOptions(value.options),
			crhsRejected: parseCrhsRejected(value.crhsRejected),
			rejectedBefore: typeof value.rejectedBefore === "string" ? value.rejectedBefore : null,
			dispatchedPath: value.dispatchedPath ?? null,
			payloadId: value.payloadId ?? null,
			attempt: value.attempt ?? 1,
			trustDigest: value.trustDigest ?? null,
			lastRejection: value.lastRejection ?? null,
			updatedAt: value.updatedAt ?? "",
		};
	} catch {
		return null;
	}
}

function parseCrhsRejected(value: unknown): TaskAuthorizationRecord["crhsRejected"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const window = (value as { window?: unknown }).window;
	return { window: typeof window === "number" ? window : null };
}

/** Reads the stored options; an unknown or damaged option is dropped (fail closed). */
function parseOptions(value: unknown): AuthorizationOption[] {
	if (!Array.isArray(value)) return [];
	const options: AuthorizationOption[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const option = item as Record<string, unknown>;
		if (option.kind === "awaiting_node") {
			options.push({ kind: "awaiting_node" });
			continue;
		}
		if (option.kind === "local_window" && typeof option.nodeId === "string" && typeof option.nodeName === "string") {
			options.push({ kind: "local_window", nodeId: option.nodeId, nodeName: option.nodeName });
			continue;
		}
		if (option.kind !== "sign" || typeof option.ttlMs !== "number") continue;
		const fingerprints = parseFingerprints(option.fingerprints);
		options.push({
			kind: "sign",
			entries: parseEntries(option.entries),
			...(fingerprints ? { fingerprints } : {}),
			ttlMs: option.ttlMs,
			payload: parsePayload(option.payload),
		});
	}
	return options;
}

/** A damaged or empty hint list is treated as absent; it only helps choose a signing key. */
function parseFingerprints(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const fingerprints = value.filter((item): item is string => typeof item === "string" && item.startsWith("SHA256:"));
	return fingerprints.length > 0 ? fingerprints : undefined;
}

function parseEntries(value: unknown): SignEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: SignEntry[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		if (typeof entry.name !== "string") continue;
		if (entry.role !== "user" && entry.role !== "crhs") continue;
		entries.push({
			name: entry.name,
			role: entry.role,
			...(entry.credential === "sshsig" || entry.credential === "webauthn" ? { credential: entry.credential } : {}),
			...(entry.cosign === "required" || entry.cosign === "available" || entry.cosign === "missing"
				? { cosign: entry.cosign }
				: {}),
		});
	}
	return entries;
}

/** The stored exact payload of a sign option; null when the option has none yet or it is damaged. */
function parsePayload(value: unknown): SignPayload | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const payload = value as Record<string, unknown>;
	if (
		typeof payload.payload !== "string" ||
		typeof payload.id !== "string" ||
		!Array.isArray(payload.taskIds) ||
		typeof payload.attempt !== "number" ||
		typeof payload.deadline !== "string"
	) {
		return null;
	}
	return {
		payload: payload.payload,
		id: payload.id,
		deadline: payload.deadline,
		taskIds: payload.taskIds.filter((id): id is string => typeof id === "string"),
		attempt: payload.attempt,
	};
}
