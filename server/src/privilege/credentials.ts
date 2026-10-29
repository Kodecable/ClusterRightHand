/**
 * The owner's registered signing credentials (doc/m4.md#crhs-侧数据 `user_credentials`): the planner
 * only considers the user trust entries that match a credential of the task's owner.
 */
import type { Db } from "../storage/db.ts";
import type { OwnerCredentials } from "./planner.ts";

export async function ownerCredentials(db: Db, userId: string | null | undefined): Promise<OwnerCredentials> {
	if (!userId) return { sshKeyFingerprints: [], webauthnCredentialIds: [] };
	const rows = await db
		.selectFrom("user_credentials")
		.select(["kind", "fingerprint", "credential_id"])
		.where("user_id", "=", userId)
		.execute();
	return {
		sshKeyFingerprints: rows.flatMap((row) => (row.kind === "ssh" && row.fingerprint ? [row.fingerprint] : [])),
		webauthnCredentialIds: rows.flatMap((row) =>
			row.kind === "webauthn" && row.credential_id ? [row.credential_id] : [],
		),
	};
}
