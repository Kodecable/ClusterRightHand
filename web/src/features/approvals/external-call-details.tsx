import type { ExternalCallView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Panel } from "@/components/section";
import { MONO_CELL } from "@/lib/utils";

/** An api_request's target is the route it calls; its details are that request, not a built-in tool. */
export function isApiRequestCall(call: ExternalCallView): boolean {
	return call.extension === "crhs-api" && call.tool === "api_request";
}

/** The body as crhs sends it: a string holding a JSON object or list is sent as that JSON (api-request.ts). */
function requestBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	try {
		const value: unknown = JSON.parse(body);
		return typeof value === "object" && value !== null ? value : body;
	} catch {
		return body;
	}
}

function argument(call: ExternalCallView, name: string): unknown {
	const args = call.arguments;
	return typeof args === "object" && args !== null && !Array.isArray(args)
		? (args as Record<string, unknown>)[name]
		: undefined;
}

/**
 * What an external call actually asks for, on its own detail page (doc/design/webui.md "Shared
 * components"): the API request's method, path, query and body, or the extension tool, its annotations and
 * arguments. The compact approval panel keeps only the one-line action; this is the detail behind it.
 */
export function ExternalCallDetails({ call }: { call: ExternalCallView }) {
	const { t } = useLingui();
	const method = call.operation.method;
	const apiRequest = isApiRequestCall(call);
	const apiMethod = typeof argument(call, "method") === "string" ? String(argument(call, "method")).toUpperCase() : "";
	const apiPath = typeof argument(call, "path") === "string" ? String(argument(call, "path")) : "";
	const apiQuery = argument(call, "query");
	const apiBody = requestBody(argument(call, "body"));
	return (
		<Panel as="section" aria-label={t`Request details`} data-testid="external-call-details">
			<div className="grid min-w-0 gap-1.5">
				{apiRequest ? (
					<>
						<p className="text-xs text-muted-foreground" data-testid="external-call-api-request">
							<Trans>Method</Trans>: <code className={MONO_CELL}>{apiMethod}</code>
							{" · "}
							<Trans>Path</Trans>: <code className={MONO_CELL}>{apiPath}</code>
							{" · "}
							{method.endsWith(".read") ? <Trans>Operation: read</Trans> : <Trans>Operation: write</Trans>}
						</p>
						{apiQuery !== undefined && (
							<p className="text-xs text-muted-foreground" data-testid="external-call-query">
								<Trans>Query</Trans>: <code className={MONO_CELL}>{JSON.stringify(apiQuery)}</code>
							</p>
						)}
						{apiBody !== undefined && (
							<pre
								data-testid="external-call-body"
								title={t`Body`}
								className="max-h-40 w-full min-w-0 overflow-auto rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap"
							>
								{JSON.stringify(apiBody, null, 2)}
							</pre>
						)}
					</>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							<Trans>Extension</Trans>: <code className={MONO_CELL}>{call.extension}</code>
							{" · "}
							<Trans>Tool</Trans>: <code className={MONO_CELL}>{call.tool}</code>
							{" · "}
							{method.endsWith(".read") ? <Trans>Operation: read</Trans> : <Trans>Operation: write</Trans>}
						</p>
						{call.annotations !== null && (
							<p className="text-xs text-muted-foreground" data-testid="external-call-annotations">
								<Trans>Annotations</Trans>: <code className={MONO_CELL}>{JSON.stringify(call.annotations)}</code>
							</p>
						)}
						<pre
							data-testid="external-call-arguments"
							title={t`Arguments`}
							className="max-h-40 w-full min-w-0 overflow-auto rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap"
						>
							{JSON.stringify(call.arguments, null, 2)}
						</pre>
					</>
				)}
			</div>
		</Panel>
	);
}
