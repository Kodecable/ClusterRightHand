/**
 * Re-arming a waiting `call` job after a restart (doc/design/jobs.md "Background extension calls" and "Job model"):
 * the runner and the tool invocation lived in the previous process, so a call still `awaiting_approval` has
 * nobody to start when it is approved. At startup, every waiting call behind a `call` job is started again in
 * the crhs-owned runner from what its row keeps, exactly as `call_tool` builds it: the extension, tool and
 * arguments, the acting user, and the identity headers. A replayed tool invocation then finds that same call
 * (`CallRunner.start` is keyed by the external call id) instead of starting a second one.
 */
import type { Audit } from "../audit/audit.ts";
import { type CallResultConverter, type CallRunner, callDetails } from "../extensions/call-runner.ts";
import { type ExternalCallRow, finishExternalCall } from "../extensions/external-calls.ts";
import { extensionOf } from "../extensions/registry.ts";
import { extensionsForUser } from "../extensions/store.ts";
import type { ImageCache } from "../library/image-cache.ts";
import type { Db } from "../storage/db.ts";
import { parseJson } from "../util/json.ts";
import { errorResult } from "../util/tool-result.ts";
import type { Jobs } from "./jobs.ts";

export interface RearmCallOptions {
	db: Db;
	/** The MCP connections behind extension tools; a built-in extension does not need one. */
	mcp?: import("../extensions/connections.ts").McpConnections;
	jobs: Jobs;
	/**
	 * How a call's raw result becomes the cluster tools' output form (the tools layer supplies it). Injected
	 * rather than imported, because the job layer never imports the tools at runtime (doc/design/jobs.md
	 * "Adapters").
	 */
	convert: CallResultConverter;
	/** The process's call runner; a re-armed call starts in it. */
	callRunner: CallRunner;
	imageCache?: ImageCache;
	audit?: Audit;
}

/**
 * Starts a runner for every waiting external call that belongs to an unsettled `call` job. Returns how many were
 * re-armed. A call whose extension or acting user is gone is left for its approval to be rejected; nothing else
 * is changed, so a call the previous process already decided is never started.
 */
export async function rearmWaitingCallJobs(options: RearmCallOptions): Promise<number> {
	const rows = await options.db
		.selectFrom("external_calls")
		.innerJoin("jobs", (join) =>
			join.onRef("jobs.resource_id", "=", "external_calls.id").on("jobs.resource_type", "=", "external_call"),
		)
		.selectAll("external_calls")
		.select("jobs.call_key as job_call_key")
		.where("external_calls.state", "=", "awaiting_approval")
		.where("jobs.kind", "=", "call")
		.where("jobs.state", "!=", "settled")
		.execute();
	let rearmed = 0;
	for (const row of rows) {
		if (options.callRunner.get(row.id)) continue;
		const extensionRow = (await extensionsForUser(options.db, row.on_behalf_of_user_id)).find(
			(candidate) => candidate.name === row.extension_name,
		);
		const extension = extensionRow ? extensionOf(extensionRow, options.mcp) : undefined;
		if (!extension) {
			console.error(
				`jobs: the waiting call ${row.id} cannot be re-armed: the extension ${row.extension_name} is unavailable`,
			);
			await failUnarmedCall(
				options,
				row,
				"the extension is unavailable",
				`the extension ${row.extension_name} is unavailable, so this call cannot run; ask the user to call it again`,
			);
			continue;
		}
		const user = await options.db
			.selectFrom("users")
			.select("username")
			.where("id", "=", row.on_behalf_of_user_id)
			.executeTakeFirst();
		if (!user) {
			console.error(`jobs: the waiting call ${row.id} cannot be re-armed: its acting user is gone`);
			await failUnarmedCall(
				options,
				row,
				"the acting user is gone",
				"the user this call was made for no longer exists, so it cannot run; call it again",
			);
			continue;
		}
		const args = parseJson<Record<string, unknown>>(row.arguments) ?? {};
		options.callRunner.start({
			db: options.db,
			callKey: row.job_call_key,
			row,
			extension,
			tool: row.tool_name,
			arguments: args,
			userId: row.on_behalf_of_user_id,
			identity: { username: user.username, sessionId: row.actor_id },
			convert: options.convert,
			...(options.imageCache ? { imageCache: options.imageCache } : {}),
			jobs: options.jobs,
			...(options.audit ? { audit: options.audit } : {}),
		});
		rearmed += 1;
	}
	return rearmed;
}

/**
 * Ends a waiting call that cannot be re-armed (doc/design/jobs.md "Background extension calls"): failing it at
 * startup is better than leaving an approval that nobody could ever run, blocking the job limit and scheduled-run
 * finality. The finish is audited like a runner finish, and the reason is kept in the job's result for `job_wait`.
 */
async function failUnarmedCall(
	options: RearmCallOptions,
	row: ExternalCallRow,
	reason: string,
	message: string,
): Promise<void> {
	try {
		await finishExternalCall(options.db, row.id, { state: "failed" });
	} catch (err) {
		console.error(`jobs: failing the un-re-armable call ${row.id} failed:`, err);
		return;
	}
	void options.audit?.record({
		actor: {
			type: row.actor_type,
			id: row.actor_id,
			onBehalfOfUserId: row.on_behalf_of_user_id,
		},
		action: "external_call.finished",
		target: { type: "external_call", id: row.id },
		detail: {
			extension: row.extension_name,
			tool: row.tool_name,
			state: "failed",
			reason,
		},
	});
	try {
		const callKey = (row as ExternalCallRow & { job_call_key: string }).job_call_key;
		await options.jobs.callResult(callKey, errorResult("text", "failed", message, callDetails(row)));
	} catch (err) {
		// The row is failed either way; the next projection still settles the job.
		console.error(`jobs: keeping the un-re-armable call's message failed:`, err);
	}
}
