/**
 * The one identifying text of a task action (doc/design/webui.md "Shared components"): the command, the file
 * operation with its path and line range, the API method and path, or the extension tool. Task titles, list
 * cells, page headers and every decision surface use the same function, so a task cannot read
 * "/etc/x" on one page and "Write file /etc/x" on another.
 */
import type { TaskAction } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** A value stays on one line: a path or title must not split a card line. */
export function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

export function actionText(i18n: I18n, action: TaskAction): string {
	switch (action.type) {
		case "exec":
			return oneLine(action.command);
		case "file":
			return fileActionText(i18n, action);
		case "api_request":
			return `${action.method} ${action.path}`;
		case "extension_tool":
			return `${action.extension}/${action.tool}`;
	}
}

/**
 * A file operation as one message: the operation, the path and the line range are values of the same
 * message, so a translation owns the parentheses, the word order and the punctuation around the range.
 */
function fileActionText(i18n: I18n, action: Extract<TaskAction, { type: "file" }>): string {
	const path = oneLine(action.path);
	const lines = action.lines;
	switch (action.operation) {
		case "read":
			return lines === undefined
				? i18n._(msg`Read file ${path}`)
				: i18n._(msg`Read file ${path} (lines ${lines.start}-${lines.end})`);
		case "write":
			return lines === undefined
				? i18n._(msg`Write file ${path}`)
				: i18n._(msg`Write file ${path} (lines ${lines.start}-${lines.end})`);
		case "push":
			return lines === undefined
				? i18n._(msg`Push file ${path}`)
				: i18n._(msg`Push file ${path} (lines ${lines.start}-${lines.end})`);
		case "pull":
			return lines === undefined
				? i18n._(msg`Pull file ${path}`)
				: i18n._(msg`Pull file ${path} (lines ${lines.start}-${lines.end})`);
		case "edit":
			return lines === undefined
				? i18n._(msg`Edit file ${path}`)
				: i18n._(msg`Edit file ${path} (lines ${lines.start}-${lines.end})`);
		case "stat":
			return lines === undefined
				? i18n._(msg`Stat file ${path}`)
				: i18n._(msg`Stat file ${path} (lines ${lines.start}-${lines.end})`);
		case "list":
			return lines === undefined
				? i18n._(msg`List directory ${path}`)
				: i18n._(msg`List directory ${path} (lines ${lines.start}-${lines.end})`);
	}
}
