import type { DeliveryDetails } from "./tool-details";
import { deliveryDetails } from "./tool-details";
import type { TranscriptItem } from "./transcript-items";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
type TextItem = Extract<TranscriptItem, { kind: "text" }>;

/**
 * One user turn of the transcript (doc/design/webui.md "Message view"): the user input,
 * everything the agent did afterwards, the final answer, and the files a `copy_file`
 * offered to the people in the session, shown once the turn has ended.
 */
export interface TranscriptTurn {
	key: string;
	user: UserItem | undefined;
	body: TranscriptItem[];
	/** The `body` items before the final answer. */
	process: TranscriptItem[];
	/** The compaction notes committed after the final answer, shown after it. */
	after: TranscriptItem[];
	/** The final answer: a text whose assistant message ended without tool calls. */
	final: TextItem | undefined;
	/** The files this turn delivered, deduplicated by source and path. */
	deliveries: DeliveryDetails[];
	/** When the user turn started. */
	startedAt: number | undefined;
	durationMs: number | undefined;
	/** The turn is over: another user turn follows it, or the session is idle. */
	ended: boolean;
	foldable: boolean;
}

/**
 * The files a turn delivered through `copy_file`: its successful tool results carry
 * `details.delivery`, and a failed delivery is not shown. The same source and path twice is
 * one delivery (doc/design/library.md "Deliveries").
 */
function turnDeliveries(body: readonly TranscriptItem[]): DeliveryDetails[] {
	const seen = new Set<string>();
	const deliveries: DeliveryDetails[] = [];
	for (const item of body) {
		if (item.kind !== "tool" || item.name !== "copy_file" || item.result === undefined || item.result.isError) continue;
		const delivery = deliveryDetails(item.result.details);
		if (delivery === undefined) continue;
		const key =
			"library" in delivery.source
				? `library:${delivery.source.libraryId}:${delivery.source.path}`
				: `node:${delivery.source.nodeId}:${delivery.source.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deliveries.push(delivery);
	}
	return deliveries;
}

/**
 * Split the flat transcript into user turns and decide which turns can be
 * folded. A text is the final answer only once its assistant message has ended
 * without tool calls; while it streams the turn stays unfolded and shows no
 * completion line. The elapsed time is known when the turn ends. An error in
 * the process keeps the turn open so its failure is never hidden.
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
		// text whose message ended without tool calls. The notes committed after
		// it stay in `after` so the view can show them after the final answer, in
		// commit order (doc/design/webui.md "Message rendering").
		const finalIndex = group.body.findLastIndex((item) => item.kind !== "compaction");
		const last = finalIndex === -1 ? undefined : group.body[finalIndex];
		const final = last?.kind === "text" && last.final ? last : undefined;
		const process = final === undefined ? group.body : group.body.slice(0, finalIndex);
		const after = final === undefined ? [] : group.body.slice(finalIndex + 1);
		const ended = index < groups.length - 1 || !sessionActive;
		const durationMs =
			group.user?.at !== undefined && final?.at !== undefined && final.durationMs !== undefined
				? Math.max(0, final.at + final.durationMs - group.user.at)
				: undefined;
		const hasError = process.some((item) => item.kind === "error");
		const foldable = ended && final !== undefined && process.length > 0 && durationMs !== undefined && !hasError;
		return {
			key: group.user?.key ?? group.body[0]?.key ?? `turn-${index}`,
			user: group.user,
			body: group.body,
			process,
			after,
			final,
			deliveries: turnDeliveries(group.body),
			startedAt: group.user?.at,
			durationMs,
			ended,
			foldable,
		};
	});
}
