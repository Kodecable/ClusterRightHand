import { hostname, userInfo } from "node:os";
import type { Db } from "../storage/db.ts";
import { Audit, type AuditActor, type AuditInput } from "./audit.ts";

/** The actor of every action a `crhs` command performs: the CLI itself, not a signed-in user. */
export const CLI_ACTOR: AuditActor = { type: "system", id: "cli" };

/** Where a CLI action came from: the OS account and host that ran it. */
export interface CliDetail {
	via: "cli";
	os_user: string;
	uid: number | null;
	host: string;
}

/** The OS account facts an audit record needs. */
export interface OsIdentity {
	username: string;
	uid: number;
}

/**
 * The OS identity behind a CLI action. `userInfo()` throws when the uid has no passwd entry (some
 * containers and service accounts); the process uid and the environment's user name then stand in.
 */
export function cliDetail(env: NodeJS.ProcessEnv = process.env, info: () => OsIdentity = userInfo): CliDetail {
	let osUser: string;
	let uid: number | null;
	try {
		const identified = info();
		osUser = identified.username;
		uid = identified.uid;
	} catch {
		osUser = env.USER ?? env.LOGNAME ?? "";
		uid = process.getuid?.() ?? null;
	}
	return { via: "cli", os_user: osUser, uid, host: hostname() };
}

/** An audit input for a CLI action: the CLI actor, the CLI detail fragment and the action's own fields. */
export function cliInput(
	action: string,
	detail: Record<string, unknown> = {},
	target?: AuditInput["target"],
): AuditInput {
	return { actor: CLI_ACTOR, action, target, detail: { ...cliDetail(), ...detail } };
}

/** Appends a CLI event; a failure is thrown so the caller can refuse the change instead of losing the record. */
export function appendCliAudit(db: Db, input: AuditInput): Promise<void> {
	return new Audit(db).append(input);
}
