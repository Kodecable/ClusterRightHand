/**
 * The terminal API (doc/design/pty.md "API"): the list, open, get, resize, association and close
 * routes, plus the page's two decision endpoints (a rule approval and a signature rejection).
 *
 * Access is the terminal's own rule: its user and administrators see and control it, a session share
 * viewer sees nothing. Opening checks only node access, as a task run from the WebUI does.
 */
import {
	ApprovalBodySchema,
	OkResponseSchema,
	PtyAuthorizationResponseSchema,
	PtyCreateBodySchema,
	PtyEnabledSchema,
	PtyErrorResponseSchema,
	PtyListResponseSchema,
	PtyRejectAuthorizationBodySchema,
	PtyResizeBodySchema,
	PtyResponseSchema,
} from "@crh/api/schemas";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { SessionUser } from "../auth/sessions.ts";
import { pendingAuthorizationOptions } from "../cluster/pending.ts";
import type { Db } from "../storage/db.ts";
import { awaitingSignature, type TerminalService } from "../terminals/registry.ts";
import { type Terminal, TerminalError } from "../terminals/types.ts";
import type { AppEnv } from "./context.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Terminals"];

const IdParam = z.object({ id: z.string() });
const SessionParam = z.object({ id: z.string(), sessionId: z.string() });

const enabledRoute = defineRoute({
	method: "get",
	path: "/ptys/enabled",
	tags: TAGS,
	summary: "Whether the terminal subsystem is on (the page and the agent tools)",
	agent: "deny",
	responses: { 200: { description: "The subsystem's state", ...json(PtyEnabledSchema) } },
});

const listRoute = defineRoute({
	method: "get",
	path: "/ptys",
	tags: TAGS,
	summary: "The terminals the caller may see: their own, or every one for an administrator",
	agent: "deny",
	responses: { 200: { description: "The terminals", ...json(PtyListResponseSchema) } },
});

const createRoute = defineRoute({
	method: "post",
	path: "/ptys",
	tags: TAGS,
	summary: "Open a terminal on a node the caller has access to",
	agent: "deny", // an interactive shell is never an agent's API request
	request: { body: { required: true, ...json(PtyCreateBodySchema) } },
	responses: {
		201: { description: "The opening or running terminal", ...json(PtyResponseSchema) },
		400: { description: "The request was refused", ...json(PtyErrorResponseSchema) },
	},
});

const getRoute = defineRoute({
	method: "get",
	path: "/ptys/{id}",
	tags: TAGS,
	summary: "One terminal",
	agent: "deny",
	request: { params: IdParam },
	responses: {
		200: { description: "The terminal", ...json(PtyResponseSchema) },
		404: { description: "No such terminal", ...json(PtyErrorResponseSchema) },
	},
});

const resizeRoute = defineRoute({
	method: "post",
	path: "/ptys/{id}/resize",
	tags: TAGS,
	summary: "Resize a terminal explicitly; attaching never resizes it",
	agent: "deny",
	request: { params: IdParam, body: { required: true, ...json(PtyResizeBodySchema) } },
	responses: {
		200: { description: "The terminal's new size", ...json(PtyResponseSchema) },
		409: { description: "The terminal has exited", ...json(PtyErrorResponseSchema) },
	},
});

const associateRoute = defineRoute({
	method: "put",
	path: "/ptys/{id}/sessions/{sessionId}",
	tags: TAGS,
	summary: "Associate one of the terminal user's sessions with the terminal",
	agent: "deny",
	request: { params: SessionParam },
	responses: {
		200: { description: "Associated", ...json(OkResponseSchema) },
		400: { description: "The association was refused", ...json(PtyErrorResponseSchema) },
	},
});

const unassociateRoute = defineRoute({
	method: "delete",
	path: "/ptys/{id}/sessions/{sessionId}",
	tags: TAGS,
	summary: "Remove a session's association with the terminal",
	agent: "deny",
	request: { params: SessionParam },
	responses: { 200: { description: "Unassociated", ...json(OkResponseSchema) } },
});

const closeRoute = defineRoute({
	method: "delete",
	path: "/ptys/{id}",
	tags: TAGS,
	summary: "Close a terminal",
	agent: "deny",
	request: { params: IdParam },
	responses: { 200: { description: "Closed", ...json(OkResponseSchema) } },
});

const authorizationRoute = defineRoute({
	method: "get",
	path: "/ptys/{id}/authorization",
	tags: TAGS,
	summary: "The signature wait of an opening privileged terminal",
	agent: "deny", // signing material and the challenge
	request: { params: IdParam },
	responses: { 200: { description: "The wait's phase and options", ...json(PtyAuthorizationResponseSchema) } },
});

const rejectAuthorizationRoute = defineRoute({
	method: "post",
	path: "/ptys/{id}/authorization/reject",
	tags: TAGS,
	summary: "Decline to sign an opening privileged terminal; it never opens",
	agent: "deny",
	request: { params: IdParam, body: { required: true, ...json(PtyRejectAuthorizationBodySchema) } },
	responses: { 200: { description: "Declined", ...json(OkResponseSchema) } },
});

const approvalRoute = defineRoute({
	method: "post",
	path: "/ptys/{id}/approval",
	tags: TAGS,
	summary: "Approve or reject an agent's waiting terminal request, optionally appending an allow rule",
	agent: "deny", // an approval decision
	request: {
		params: IdParam,
		body: { required: true, ...json(ApprovalBodySchema) },
	},
	responses: {
		200: { description: "The decision was taken", ...json(OkResponseSchema) },
		409: { description: "The request is no longer waiting for approval", ...json(PtyErrorResponseSchema) },
	},
});

/** Maps a terminal refusal to its HTTP answer. */
function ptyError(c: Context<AppEnv>, err: unknown): never {
	if (err instanceof TerminalError) {
		const status =
			err.code === "not_found" || err.code === "node_not_found" || err.code === "session_not_found"
				? 404
				: err.code === "not_waiting" || err.code === "approval_pending" || err.code === "exited"
					? 409
					: 400;
		throw new HTTPException(status, { res: c.json({ error: err.message, code: err.code }, status) });
	}
	throw err;
}

async function view(terminals: TerminalService, terminal: Terminal) {
	return terminals.view(terminal);
}

export interface TerminalRoutesOptions {
	terminals: TerminalService;
	db: Db;
}

/** The terminal routes; expects requireUser to have run. */
export function terminalRoutes(options: TerminalRoutesOptions) {
	const app = apiRouter();
	const { terminals } = options;

	app.openapi(enabledRoute, async (c) => c.json({ enabled: terminals.enabled }, 200));

	app.openapi(listRoute, async (c) => c.json(await terminals.list(c.get("user")), 200));

	app.openapi(createRoute, async (c) => {
		const body = c.req.valid("json");
		try {
			const terminal = await terminals.openForPerson({
				user: c.get("user"),
				node: body.node,
				...(body.argv === undefined ? {} : { argv: body.argv }),
				...(body.privileged === undefined ? {} : { privileged: body.privileged }),
				...(body.size === undefined ? {} : { rows: body.size.rows, cols: body.size.cols }),
			});
			return c.json({ terminal: await view(terminals, terminal) }, 201);
		} catch (err) {
			return ptyError(c, err);
		}
	});

	app.openapi(getRoute, async (c) => {
		const { id } = c.req.valid("param");
		try {
			const terminal = await terminals.requireTerminal(c.get("user"), id);
			return c.json({ terminal: await view(terminals, terminal) }, 200);
		} catch (err) {
			return ptyError(c, err);
		}
	});

	app.openapi(resizeRoute, async (c) => {
		const { id } = c.req.valid("param");
		const body = c.req.valid("json");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		try {
			await terminals.resize(terminal, body.rows, body.cols);
		} catch (err) {
			return ptyError(c, err);
		}
		return c.json({ terminal: await view(terminals, terminal) }, 200);
	});

	app.openapi(associateRoute, async (c) => {
		const { id, sessionId } = c.req.valid("param");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		try {
			await terminals.associate(terminal, sessionId, c.get("user"));
		} catch (err) {
			return ptyError(c, err);
		}
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(unassociateRoute, async (c) => {
		const { id, sessionId } = c.req.valid("param");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		await terminals.unassociate(terminal, sessionId, c.get("user"));
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(closeRoute, async (c) => {
		const { id } = c.req.valid("param");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		await terminals.close(terminal, "manual");
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(authorizationRoute, async (c) => {
		const { id } = c.req.valid("param");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		const auth = terminal.authorization;
		if (auth === null || !awaitingSignature(terminal)) {
			// The wait ends when the plan is sent to the node, so the phase cannot disagree with the view
			// while `pty.open` is in flight (doc/design/pty.md "Privilege").
			return c.json({ phase: "ended" as const, authorization: null }, 200);
		}
		const record = {
			options: auth.options,
			crhsRejected: auth.crhsRejected,
			rejectedBefore: auth.rejectedBefore,
			dispatchedPath: auth.path,
			payloadId: null,
			attempt: auth.attempt,
			trustDigest: null,
			lastRejection: auth.lastRejection,
			updatedAt: auth.updatedAt,
		};
		const planned = await pendingAuthorizationOptions(options.db, terminal.userId, terminal.nodeId, record as never);
		if (planned.length === 0) {
			return c.json({ phase: "preparing" as const, authorization: null }, 200);
		}
		return c.json(
			{
				phase: "waiting" as const,
				authorization: { options: planned, lastRejection: auth.lastRejection },
			},
			200,
		);
	});

	app.openapi(rejectAuthorizationRoute, async (c) => {
		const { id } = c.req.valid("param");
		const body = c.req.valid("json");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		try {
			terminals.rejectAuthorization(terminal, body.reason);
		} catch (err) {
			return ptyError(c, err);
		}
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(approvalRoute, async (c) => {
		const { id } = c.req.valid("param");
		const body = c.req.valid("json");
		let terminal: Terminal;
		try {
			terminal = await terminals.requireTerminal(c.get("user"), id);
		} catch (err) {
			return ptyError(c, err);
		}
		try {
			await terminals.decideApproval(terminal, c.get("user") as SessionUser, body);
		} catch (err) {
			return ptyError(c, err);
		}
		return c.json({ ok: true as const }, 200);
	});

	return app;
}
