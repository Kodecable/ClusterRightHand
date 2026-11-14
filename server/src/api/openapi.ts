import { ErrorResponseSchema } from "@crh/api/schemas";
import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { AppEnv } from "./context.ts";
import { jsonError } from "./context.ts";

/**
 * Route definitions that validate requests and describe themselves (doc/design/extensions.md). A route
 * group builds its routes with `defineRoute` on an `apiRouter()`; the request schemas validate before the
 * handler runs, and the API document is generated from the same definitions.
 *
 * A handler answers only its successes; a missing object or a rejected request is thrown (NotFoundError,
 * UserError) and answered by the API's one error handler (errors.ts), which the document lists for every route.
 *
 * Every route states whether an agent may call it through `api_request`: `allow` runs it, `ask` needs an
 * approval, `deny` refuses. The field is required, so a new route cannot forget the decision.
 */

export type AgentAccess = "allow" | "ask" | "deny";

/** The OpenAPI extension that carries a route's agent access. */
export const AGENT_ACCESS_EXTENSION = "x-crh-agent";

export type ApiRouteConfig = RouteConfig & {
	agent: AgentAccess;
	/** One line for the API document. */
	summary: string;
};

/** The standard error answers every route may give; listed once so each route only adds its successes. */
const ERROR_RESPONSES = {
	400: { description: "The request was rejected", content: { "application/json": { schema: ErrorResponseSchema } } },
	404: { description: "No such object", content: { "application/json": { schema: ErrorResponseSchema } } },
} as const;

/** A JSON request or response body with this schema. */
export const json = <S>(schema: S) => ({ content: { "application/json": { schema } } });

export function defineRoute<const R extends ApiRouteConfig>(config: R) {
	const { agent, ...rest } = config;
	return createRoute({
		...rest,
		[AGENT_ACCESS_EXTENSION]: agent,
		responses: { ...ERROR_RESPONSES, ...rest.responses },
	} as unknown as Omit<R, "agent"> & { [AGENT_ACCESS_EXTENSION]: AgentAccess });
}

/**
 * A route group whose failed request validation answers like every other rejected request: a 400 with the
 * first problem as the message, `<field>: <problem>` when it concerns a field.
 */
export function apiRouter() {
	return new OpenAPIHono<AppEnv>({
		defaultHook: (result, c) => {
			if (result.success) return;
			const issue = result.error.issues[0];
			const field = issue?.path.join(".");
			const message = issue === undefined ? "invalid request" : field ? `${field}: ${issue.message}` : issue.message;
			return jsonError(c, 400, message);
		},
	});
}

/** The OpenAPI 3.1 document of every route defined with defineRoute, as mounted under `app`. */
export function apiDocument(app: OpenAPIHono<AppEnv>): ReturnType<OpenAPIHono<AppEnv>["getOpenAPI31Document"]> {
	return app.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "crhs API", version: "1" },
	});
}
