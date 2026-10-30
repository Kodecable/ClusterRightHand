import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import * as m0001 from "./migrations/0001_init.ts";
import * as m0002 from "./migrations/0002_users_and_sharing.ts";
import * as m0003 from "./migrations/0003_keys.ts";
import * as m0004 from "./migrations/0004_nodes.ts";
import * as m0005 from "./migrations/0005_tasks.ts";
import * as m0006 from "./migrations/0006_task_groups.ts";
import * as m0007 from "./migrations/0007_ssh.ts";
import * as m0008 from "./migrations/0008_policy_and_audit.ts";
import * as m0009 from "./migrations/0009_agent.ts";
import * as m0010 from "./migrations/0010_session_usage.ts";
import * as m0011 from "./migrations/0011_model_provider_headers.ts";
import * as m0012 from "./migrations/0012_session_submission.ts";
import * as m0013 from "./migrations/0013_session_quota.ts";
import * as m0014 from "./migrations/0014_quota_requests.ts";
import * as m0015 from "./migrations/0015_session_state.ts";
import * as m0016 from "./migrations/0016_awaiting_state.ts";
import * as m0017 from "./migrations/0017_root_session_quota.ts";
import * as m0018 from "./migrations/0018_approval_handler.ts";
import * as m0019 from "./migrations/0019_cbor_protocol.ts";
import * as m0020 from "./migrations/0020_output_mode.ts";
import * as m0021 from "./migrations/0021_task_group_privileged.ts";
import * as m0022 from "./migrations/0022_m4_privilege.ts";
import * as m0023 from "./migrations/0023_credential_origins.ts";

/** Migrations are listed explicitly so they work the same from source and from a bundle. */
const migrations: Record<string, Migration> = {
	"0001_init": m0001,
	"0002_users_and_sharing": m0002,
	"0003_keys": m0003,
	"0004_nodes": m0004,
	"0005_tasks": m0005,
	"0006_task_groups": m0006,
	"0007_ssh": m0007,
	"0008_policy_and_audit": m0008,
	"0009_agent": m0009,
	"0010_session_usage": m0010,
	"0011_model_provider_headers": m0011,
	"0012_session_submission": m0012,
	"0013_session_quota": m0013,
	"0014_quota_requests": m0014,
	"0015_session_state": m0015,
	"0016_awaiting_state": m0016,
	"0017_root_session_quota": m0017,
	"0018_approval_handler": m0018,
	"0019_cbor_protocol": m0019,
	"0020_output_mode": m0020,
	"0021_task_group_privileged": m0021,
	"0022_m4_privilege": m0022,
	"0023_credential_origins": m0023,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

// biome-ignore lint/suspicious/noExplicitAny: the migrator works on any schema
export async function migrateToLatest(db: Kysely<any>, options: { schema?: string } = {}): Promise<void> {
	// With a schema, the migrator only looks for its bookkeeping tables there (PostgreSQL); otherwise its
	// table introspection can see the same-named tables of another schema in the database.
	const migrator = new Migrator({ db, provider, migrationTableSchema: options.schema });
	const { error, results } = await migrator.migrateToLatest();
	const failed = results?.find((r) => r.status === "Error");
	if (error || failed) {
		throw new Error(`migration ${failed?.migrationName ?? "?"} failed`, { cause: error });
	}
}
