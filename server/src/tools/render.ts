/**
 * The two result renderers every cluster tool goes through (doc/design/agent-runtime.md "Tool output"): text
 * tools return an optional raw block followed by a fixed-format note block per node (a task group leads with its
 * own note); JSON tools return one compact JSON block. Both carry `details` for the UI, which the MCP adapter
 * drops. The implementation lives in util/tool-result.ts so the job layer can build results without importing
 * this module.
 */
export type { TextBlock, ToolOutput, ToolResult, ToolTextContent } from "../util/tool-result.ts";
export { errorResult, jsonResult, textResult } from "../util/tool-result.ts";
