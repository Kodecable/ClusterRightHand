import type { TranscriptItem } from "./transcript-items";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
type TextItem = Extract<TranscriptItem, { kind: "text" }>;

/**
 * One user turn of the transcript (doc/design/webui.md "Message view"): the user input,
 * everything the agent did afterwards, and the final text. A turn is foldable
 * while its final answer is streaming, or once it has ended with the timing
 * needed for the "completed in" line.
 */
export interface TranscriptTurn {
	key: string;
	user: UserItem | undefined;
	body: TranscriptItem[];
	/** The `body` items before the final answer. */
	process: TranscriptItem[];
	/** The compaction notes committed after the final answer, shown after it. */
	after: TranscriptItem[];
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
		// A compaction note can trail the body, but it never decides the turn:
		// the final answer is the last non-compaction item if that item is a
		// text. The notes committed after it stay in `after` so the view can show
		// them after the final answer, in commit order (doc/design/webui.md "Message rendering").
		const finalIndex = group.body.findLastIndex((item) => item.kind !== "compaction");
		const last = finalIndex === -1 ? undefined : group.body[finalIndex];
		const final = last?.kind === "text" ? last : undefined;
		const process = final === undefined ? group.body : group.body.slice(0, finalIndex);
		const after = final === undefined ? [] : group.body.slice(finalIndex + 1);
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
			after,
			final,
			startedAt: group.user?.at,
			live,
			durationMs,
			foldable,
		};
	});
}
