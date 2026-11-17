import type { ApprovalRecord, Evaluation, ExternalCallView, TaskGroupView, TaskView } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CodeFrame } from "@/components/code-frame";
import { Panel, SectionTitle } from "@/components/section";
import { cn } from "@/lib/utils";
import { EvaluationTable, ReviewView } from "./evaluation";

/** One rule chain evaluation in the shared details section; a task group has one per node. */
export interface RequestEvaluation {
	label?: string;
	evaluation: Evaluation;
}

/** One JSON block of the request itself (an operation, an API query or body, tool arguments). */
export interface RequestContentBlock {
	label: string;
	value: unknown;
}

/** The request the page details: a task, a task group or an external call. */
export type RequestDetailsSource =
	| { kind: "task"; task: TaskView }
	| { kind: "task_group"; taskGroup: TaskGroupView }
	| { kind: "external_call"; call: ExternalCallView };

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

function reviewOf(source: RequestDetailsSource): ApprovalRecord["review"] | undefined {
	return source.kind === "task"
		? source.task.approval?.review
		: source.kind === "task_group"
			? source.taskGroup.approval?.review
			: source.call.approval?.review;
}

function evaluationsOf(source: RequestDetailsSource, nodeNames: Map<string, string>): RequestEvaluation[] {
	switch (source.kind) {
		case "task":
			return source.task.approval ? [{ evaluation: source.task.approval.evaluation }] : [];
		case "task_group":
			return (source.taskGroup.approval?.nodes ?? []).map((node) => ({
				label: nodeNames.get(node.nodeId) ?? node.nodeId,
				evaluation: node.evaluation,
			}));
		case "external_call":
			return source.call.approval ? [{ evaluation: source.call.approval.evaluation }] : [];
	}
}

/**
 * The request content behind the one-line card action, as JSON code blocks: the operation for a task or a
 * task group, the API request's query and body, or an extension call's annotations and arguments. It is the
 * same section on every page, so the detail is never in the decision panel itself.
 */
function contentOf(source: RequestDetailsSource, t: (descriptor: MessageDescriptor) => string): RequestContentBlock[] {
	switch (source.kind) {
		case "task":
			return source.task.operation ? [{ label: t(msg`Operation`), value: source.task.operation }] : [];
		case "task_group":
			return source.taskGroup.operation ? [{ label: t(msg`Operation`), value: source.taskGroup.operation }] : [];
		case "external_call": {
			const call = source.call;
			if (!isApiRequestCall(call)) {
				const blocks: RequestContentBlock[] = [];
				if (call.annotations !== null) blocks.push({ label: t(msg`Annotations`), value: call.annotations });
				blocks.push({ label: t(msg`Arguments`), value: call.arguments });
				return blocks;
			}
			const query = argument(call, "query");
			const body = requestBody(argument(call, "body"));
			const blocks: RequestContentBlock[] = [];
			if (query !== undefined) blocks.push({ label: t(msg`Query`), value: query });
			if (body !== undefined) blocks.push({ label: t(msg`Body`), value: body });
			// An API request may carry neither: the arguments still show what was asked.
			if (blocks.length === 0) blocks.push({ label: t(msg`Arguments`), value: call.arguments });
			return blocks;
		}
	}
}

function evaluationKey(entry: RequestEvaluation): string {
	return entry.label ?? "request";
}

/**
 * The shared request details below a page's decision card (doc/design/webui.md "Shared components"): Auto
 * Review's full verdict, the folded rule chain evaluation (one table per task-group node), and the request
 * content as JSON. Every kind renders the same structure; only the content differs.
 */
export function RequestDetails({
	source,
	nodeNames = new Map(),
	refNames,
	tokenNames = new Map(),
	className,
}: {
	source: RequestDetailsSource;
	nodeNames?: Map<string, string>;
	/** Current node and node-group names for the UUIDs a matched rule stores; defaults to `nodeNames`. */
	refNames?: Map<string, string>;
	tokenNames?: Map<string, string>;
	className?: string;
}) {
	const { t } = useLingui();
	const review = reviewOf(source);
	const settledReview = review !== undefined && !("status" in review);
	const evaluations = evaluationsOf(source, nodeNames);
	const content = contentOf(source, t);
	if (!settledReview && evaluations.length === 0 && content.length === 0) return null;
	return (
		<Panel
			as="section"
			aria-label={t`Request details`}
			data-testid="request-details"
			className={cn("grid min-w-0 gap-3", className)}
		>
			<SectionTitle>
				<Trans>Request details</Trans>
			</SectionTitle>
			{settledReview && review !== undefined && (
				<div data-testid="request-review">
					<ReviewView review={review} />
				</div>
			)}
			{evaluations.length > 0 && (
				<details data-testid="request-evaluations" className="w-full min-w-0 rounded-md border p-2">
					<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
						<Trans>Rule chain evaluation</Trans>
					</summary>
					<div className="mt-2 grid gap-3">
						{evaluations.map((entry) => (
							<div key={evaluationKey(entry)} className="grid min-w-0 gap-1">
								{entry.label !== undefined && (
									<h4 className="text-xs font-medium text-muted-foreground">{entry.label}</h4>
								)}
								<EvaluationTable
									evaluation={entry.evaluation}
									tokenNames={tokenNames}
									refNames={refNames ?? nodeNames}
								/>
							</div>
						))}
					</div>
				</details>
			)}
			{content.map((block) => (
				<section key={block.label} data-testid="request-content" className="min-w-0">
					<CodeFrame aria-label={block.label} title={block.label} bodyClassName="max-h-40 overflow-auto">
						<pre className="p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
							{JSON.stringify(block.value, null, 2)}
						</pre>
					</CodeFrame>
				</section>
			))}
		</Panel>
	);
}
