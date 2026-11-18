import { type Kysely, sql } from "kysely";

/**
 * Removes every SSH signing credential registered without proof of possession
 * (doc/design/privilege.md "Signing methods"). The old registration accepted any public key line
 * from a signed-in user, so a key could be registered without the private key. Passkey rows are
 * untouched; an SSH key is registered again with a signature over a server challenge.
 *
 * Nothing references a credential's id: `authorizations` names its issuer user and stores the
 * signatures themselves, which prove possession and stay valid until their deadline. The deletion
 * is data only and cannot be undone, so `down` is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`delete from signing_credentials where kind = 'ssh'`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// The rows cannot be restored.
}
