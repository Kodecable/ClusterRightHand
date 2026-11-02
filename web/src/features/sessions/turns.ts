import type { TranscriptItem } from "./sessionState";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
type TextItem = Extract<TranscriptItem, { kind: "text" }>;

/**
 * One user turn of the transcript (doc/webui.md "消息视图"): the user input,
 * everything the agent did afterwards, and the final text. A turn is foldable
 * while its final answer is streaming, or once it has ended with the timing
 * needed for the "completed in" line.
 */
export interface TranscriptTurn {
	key: string;
	user: UserItem | undefined;
	body: TranscriptItem[];
	/** `body` without the final answer. */
	process: TranscriptItem[];
	final: TextItem | undefined;
	/** When the user turn started, for the live elapsed time. */
	startedAt: number | undefined;
	/** The final answer is still streaming, so the elapsed time ticks. */
	live: boolean;
	durationMs: number | undefined;
	foldable: boolean;
}

/**
 * Split the flat transcript into user turns and decide which turns can be
 * folded. The process folds as soon as the final answer starts streaming; the
 * elapsed time ticks until the final answer ends. An error in the process keeps
 * the turn open so its failure is never hidden.
 */
export function buildTranscriptTurns(items: readonly TranscriptItem[], sessionActive: boolean): TranscriptTurn[] {
	const groups: { user: UserItem | undefined; body: TranscriptItem[] }[] = [];
	for (const item of items) {
		if (item.kind === "user") {
			groups.push({ user: item, body: [] });
			continue;
		}
		let group = groups.at(-1);
		if (group === undefined) {
			group = { user: undefined, body: [] };
			groups.push(group);
		}
		group.body.push(item);
	}

	return groups.map((group, index) => {
		const last = group.body.at(-1);
		const final = last?.kind === "text" ? last : undefined;
		const process = final === undefined ? group.body : group.body.slice(0, -1);
		const ended = index < groups.length - 1 || !sessionActive;
		const durationMs =
			group.user?.at !== undefined && final?.at !== undefined && final.durationMs !== undefined
				? Math.max(0, final.at + final.durationMs - group.user.at)
				: undefined;
		const hasError = process.some((item) => item.kind === "error");
		const live =
			!ended &&
			final?.streaming === true &&
			final.text !== "" &&
			process.length > 0 &&
			group.user?.at !== undefined &&
			!hasError;
		const foldable =
			live || (ended && final !== undefined && process.length > 0 && durationMs !== undefined && !hasError);
		return {
			key: group.user?.key ?? group.body[0]?.key ?? `turn-${index}`,
			user: group.user,
			body: group.body,
			process,
			final,
			startedAt: group.user?.at,
			live,
			durationMs,
			foldable,
		};
	});
}
