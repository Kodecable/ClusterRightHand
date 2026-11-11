import type { Kysely } from "kysely";

/** The columns this migration reads and rewrites; both names exist so `up` and `down` typecheck. */
interface Nodes {
	nodes: {
		id: string;
		ssh_credential_id: string | null;
		ssh_jumps: string | null;
		ssh_host_key: string | null;
		ssh_host_fingerprint: string | null;
	};
}

/**
 * Each hop of an SSH route authenticates with its own credential, and the pinned value is a host
 * fingerprint (doc/design/execution.md "Jump hosts"). Stored jumps gain `credentialId` (the node's former
 * credential, used on every hop before) and rename `hostKey` to `hostFingerprint`; `nodes.ssh_host_key`
 * becomes `nodes.ssh_host_fingerprint`. `down` reverses both.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const d = db as Kysely<Nodes>;
	const nodes = await d
		.selectFrom("nodes")
		.select(["id", "ssh_credential_id", "ssh_jumps"])
		.where("ssh_jumps", "is not", null)
		.execute();
	for (const node of nodes) {
		if (node.ssh_jumps === null) continue;
		const jumps = JSON.parse(node.ssh_jumps) as Record<string, unknown>[];
		const next = jumps.map((jump) => {
			const { hostKey, ...rest } = jump;
			return { ...rest, hostFingerprint: hostKey, credentialId: node.ssh_credential_id };
		});
		await d
			.updateTable("nodes")
			.set({ ssh_jumps: JSON.stringify(next) })
			.where("id", "=", node.id)
			.execute();
	}
	await d.schema.alterTable("nodes").renameColumn("ssh_host_key", "ssh_host_fingerprint").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const d = db as Kysely<Nodes>;
	await d.schema.alterTable("nodes").renameColumn("ssh_host_fingerprint", "ssh_host_key").execute();
	const nodes = await d.selectFrom("nodes").select(["id", "ssh_jumps"]).where("ssh_jumps", "is not", null).execute();
	for (const node of nodes) {
		if (node.ssh_jumps === null) continue;
		const jumps = JSON.parse(node.ssh_jumps) as Record<string, unknown>[];
		const next = jumps.map((jump) => {
			const { hostFingerprint, ...rest } = jump;
			delete rest.credentialId;
			return { ...rest, hostKey: hostFingerprint };
		});
		await d
			.updateTable("nodes")
			.set({ ssh_jumps: JSON.stringify(next) })
			.where("id", "=", node.id)
			.execute();
	}
}
