/**
 * The two result renderers every cluster tool goes through (doc/agent-runtime.md#交给模型的输出d112):
 * text tools return an optional raw block followed by a fixed-format note block per node (a task group
 * leads with its own note); JSON tools return one compact JSON block. Both carry `details` for the UI,
 * which the MCP adapter drops.
 */

/** One text content block as the agent and MCP surfaces carry it. */
export interface ToolTextContent {
	type: "text";
	text: string;
}

/** What a cluster tool handler returns; the adapters turn it into their own result shape. */
export interface ToolResult {
	content: ToolTextContent[];
	isError: boolean;
	/** Agent only: data for the WebUI's tool cards, never shown to the model (doc/agent-runtime.md#给-ui-的-details). */
	details?: Record<string, unknown>;
}

/** How a tool's result is rendered, which also decides the error shape. */
export type ToolOutput = "text" | "json";

/** A tool result part: the raw output (omitted when empty) and the note block that explains it. */
export interface TextBlock {
	output?: string;
	note?: string;
}

interface ResultOptions {
	isError?: boolean;
	details?: Record<string, unknown>;
}

function result(content: ToolTextContent[], options: ResultOptions): ToolResult {
	return {
		content,
		isError: options.isError === true,
		...(options.details === undefined ? {} : { details: options.details }),
	};
}

/**
 * A text result. Each block renders its raw output first, then its note, so a task group can carry one
 * pair per node after its leading group note without ever joining two nodes into one block.
 */
export function textResult(blocks: readonly TextBlock[], options: ResultOptions = {}): ToolResult {
	const content: ToolTextContent[] = [];
	for (const block of blocks) {
		if (block.output !== undefined && block.output !== "") content.push({ type: "text", text: block.output });
		if (block.note !== undefined && block.note !== "") content.push({ type: "text", text: block.note });
	}
	return result(content, options);
}

/** A JSON result: one compact block, no indentation (doc/agent-runtime.md#交给模型的输出d112). */
export function jsonResult(value: unknown, options: ResultOptions = {}): ToolResult {
	return result([{ type: "text", text: JSON.stringify(value) }], options);
}

/**
 * An expected tool error in the shape of the tool's renderer: a text tool writes `[error <code>: <message>]`
 * in its note block (D114), a JSON tool returns `{"error": {"code", "message"}}`.
 */
export function errorResult(
	output: ToolOutput,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): ToolResult {
	if (output === "text") return textResult([{ note: `[error ${code}: ${message}]` }], { isError: true, details });
	return jsonResult({ error: { code, message } }, { isError: true, details });
}
