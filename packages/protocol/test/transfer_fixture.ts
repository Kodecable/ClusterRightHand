/**
 * Generates test/interop/transfer_fixture.json: the data connection payloads and frames, the new
 * file.push/file.pull specs and the pull result. Both implementations decode every positive and
 * re-encode it to the same bytes, and reject every negative (doc/design/protocol.md "Interop fixtures").
 */
import { encode as encodeCbor } from "../src/cbor.ts";
import { encodeFrame, type Frame } from "../src/frame.ts";
import {
	DATA_NOISE_PROLOGUE_PREFIX,
	dataConnectionInitCodec,
	dataConnectionResponseCodec,
	dataFrameCodec,
	PROTOCOL_MAJOR,
	type TaskResult,
	type TaskSpec,
	taskResultCodec,
	taskSpecCodec,
} from "../src/messages.ts";

/** How a fixture value is decoded: a frame, a body, or one data connection value. */
export type TransferFixtureCodec = "frame" | "task-spec" | "task-result" | "data-init" | "data-response" | "data-frame";

export interface TransferFixtureCase {
	id: string;
	description: string;
	codec: TransferFixtureCodec;
	hex: string;
}

export interface TransferFixture {
	prologue: string;
	positive: TransferFixtureCase[];
	negative: TransferFixtureCase[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const SHA_333 = new Uint8Array(32).fill(0x33);

const PUSH: TaskSpec = {
	kind: "file.push",
	path: "/srv/app/release.tar",
	size: 1048576,
	sha256: SHA_333,
	overwrite: true,
	mode: 0o644,
	owner: "deploy",
	group: "deploy",
	endpoint: { kind: "crhs", transferId: "tr-1" },
};

const PULL: TaskSpec = {
	kind: "file.pull",
	path: "/etc/nginx/nginx.conf",
	maxBytes: 4 * 1024 * 1024,
	endpoint: { kind: "crhs", transferId: "tr-2" },
};

const PULL_RESULT: TaskResult = { kind: "file.pull", size: 1024, sha256: SHA_333 };

function startFrame(taskId: string, spec: TaskSpec): Frame {
	return {
		kind: "request",
		id: 7,
		cmd: "task.start",
		body: {
			taskId,
			attempt: 1,
			spec,
			privileged: false,
			authorizations: [],
			timeoutMs: 0,
			killGraceMs: 0,
			output: { kind: "status" },
		},
	};
}

export function buildTransferFixture(): TransferFixture {
	const positive: TransferFixtureCase[] = [];
	const negative: TransferFixtureCase[] = [];
	const add = (
		list: TransferFixtureCase[],
		id: string,
		description: string,
		codec: TransferFixtureCodec,
		bytes: Uint8Array,
	): void => {
		list.push({ id, description, codec, hex: hex(bytes) });
	};

	add(
		positive,
		"data.init",
		'DataConnectionInit [protocol_major=0, task_id="t-1", transfer_id="tr-1"]',
		"data-init",
		encodeCbor(dataConnectionInitCodec.encode({ protocolMajor: PROTOCOL_MAJOR, taskId: "t-1", transferId: "tr-1" })),
	);
	add(
		positive,
		"data.response",
		"DataConnectionResponse [protocol_major=0]",
		"data-response",
		encodeCbor(dataConnectionResponseCodec.encode({ protocolMajor: PROTOCOL_MAJOR })),
	);
	add(
		positive,
		"data.frame.data",
		'data frame ["data", bytes 0x0102]',
		"data-frame",
		encodeCbor(dataFrameCodec.encode({ kind: "data", bytes: Uint8Array.of(1, 2) })),
	);
	add(
		positive,
		"data.frame.end",
		'data frame ["end", []]',
		"data-frame",
		encodeCbor(dataFrameCodec.encode({ kind: "end" })),
	);
	add(
		positive,
		"data.frame.abort",
		'data frame ["abort", "too_large"]',
		"data-frame",
		encodeCbor(dataFrameCodec.encode({ kind: "abort", code: "too_large" })),
	);

	add(positive, "task.spec.push", "file.push spec", "task-spec", encodeCbor(taskSpecCodec.encode(PUSH)));
	add(positive, "task.spec.pull", "file.pull spec", "task-spec", encodeCbor(taskSpecCodec.encode(PULL)));
	add(
		positive,
		"task.result.pull",
		"file.pull result {size, sha256}",
		"task-result",
		encodeCbor(taskResultCodec.encode(PULL_RESULT)),
	);
	add(
		positive,
		"frame.task.start.push",
		"task.start request with a file.push spec",
		"frame",
		encodeFrame(startFrame("t-push", PUSH)),
	);
	add(
		positive,
		"frame.task.start.pull",
		"task.start request with a file.pull spec",
		"frame",
		encodeFrame(startFrame("t-pull", PULL)),
	);
	add(
		positive,
		"frame.task.exit.pull",
		"task.exit event carrying a file.pull result",
		"frame",
		encodeFrame({
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-pull",
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				outputEnd: 0,
				outputFile: "",
				outputLines: 0,
				result: PULL_RESULT,
			},
		}),
	);

	add(
		negative,
		"data.frame.unknown",
		'data frame with an unknown tag ["chunk", []]',
		"data-frame",
		encodeCbor(["chunk", []]),
	);
	add(
		negative,
		"data.frame.end-body",
		'data frame ["end", ["x"]] has a body',
		"data-frame",
		encodeCbor(["end", ["x"]]),
	);
	add(
		negative,
		"data.frame.data-text",
		'data frame ["data", "abc"] is not bytes',
		"data-frame",
		encodeCbor(["data", "abc"]),
	);
	add(
		negative,
		"data.init.missing",
		"DataConnectionInit without the transfer id",
		"data-init",
		encodeCbor([PROTOCOL_MAJOR, "t-1"]),
	);
	add(
		negative,
		"task.spec.push.short",
		"file.push spec without the endpoint",
		"task-spec",
		encodeCbor(["file.push", ["/x", 1, SHA_333, false, 0, "", ""]]),
	);
	add(
		negative,
		"task.spec.endpoint.unknown",
		"file.pull spec with an unknown endpoint tag",
		"task-spec",
		encodeCbor(["file.pull", ["/x", 1, ["url", "https://example"]]]),
	);
	add(
		negative,
		"task.result.pull.short",
		"file.pull result with a short sha256",
		"task-result",
		encodeCbor(["file.pull", [1, new Uint8Array(31)]]),
	);

	return { prologue: DATA_NOISE_PROLOGUE_PREFIX, positive, negative };
}
