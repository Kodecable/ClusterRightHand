import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@crh/api";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceViewImages } from "../src/agent/extension.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { AgentRuntimeOptions } from "../src/agent/runtime-core.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createLibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload } from "../src/library/files.ts";
import { ImageCache, REJECTED_IMAGE_TEXT } from "../src/library/image-cache.ts";
import { findLibraryByRef } from "../src/library/library.ts";
import type { Db } from "../src/storage/db.ts";
import { openAgentStorage } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A PNG header and a few payload bytes; the image is never decoded. */
function png(width = 40, height = 30, fill = 3): Buffer {
	const header = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const size = Buffer.alloc(8);
	size.writeUInt32BE(width, 0);
	size.writeUInt32BE(height, 4);
	return Buffer.concat([header, size, Buffer.alloc(fill, 5)]);
}

const faux = fauxProvider({
	models: [
		{ id: "image-model", input: ["text", "image"] },
		{ id: "text-model", input: ["text"] },
		{
			id: "small-image-model",
			input: ["text", "image"],
			inputLimits: { images: { resize: { maxWidth: 10, maxHeight: 10 } } },
		},
	],
});

const cacheLimits = () => ({ memoryBytes: 1 << 20, diskBytes: 1 << 20, ttlMs: 60_000 });

describe("view_image beforeRequest hook", () => {
	let db: Db;
	let root: string;
	let storagePath: string;
	let runtime: AgentRuntime;
	let options: AgentRuntimeOptions;
	let imageCache: ImageCache;
	let backend: ReturnType<typeof createLibraryBackend>;
	let alice: SessionUser;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-image-hook-"));
		storagePath = join(root, "agent.sqlite");
		backend = createLibraryBackend({ backend: "local" }, root);
		const audit = new Audit(db);
		const cluster = new Cluster(db, { audit, libraryBackend: backend });
		const models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		imageCache = new ImageCache(db, backend, cacheLimits);
		options = {
			db,
			storage: async () => (await openAgentStorage({ driver: "sqlite", path: storagePath })).storage,
			models,
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit }),
			audit,
			imageCache,
		};
		runtime = await AgentRuntime.open(options);
		const row = await createUser(db, { username: "alice", kind: "member" });
		alice = { sessionId: "s", userId: row.id, username: "alice", kind: "member" };
	});

	afterEach(async () => {
		await runtime.close();
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	async function put(data: Uint8Array): Promise<void> {
		const record = await findLibraryByRef(db, "user:alice");
		if (!record) throw new Error("no library");
		const upload = beginLibraryUpload(db, backend, {
			library: record.row,
			path: "pic.png",
			overwrite: true,
			createdBy: null,
		});
		await upload.write(data);
		await upload.commit();
	}

	/** The first content block of the first message, for the tests that only look at one. */
	function firstBlock(messages: PiMessage[] | undefined): {
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	} {
		const block = messages?.[0]?.content[0];
		if (!block || typeof block === "string") throw new Error("no content block");
		return block;
	}

	/** The view_image tool result of one captured request. */
	function viewImageResult(messages: readonly PiMessage[] | undefined): PiMessage | undefined {
		return messages?.find((message) => message.role === "toolResult" && message.toolName === "view_image");
	}

	function toolResultMessage(details: unknown, timestamp = 0): PiMessage {
		return {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "view_image",
			content: [{ type: "text", text: "[view_image pic.png]" }],
			details: details as never,
			isError: false,
			timestamp,
		};
	}

	it("sees details on the messages and replaces the result with the image block", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
		});
		const captured: { messages: readonly PiMessage[] }[] = [];
		faux.setResponses([
			(context) => {
				captured.push({ messages: context.messages });
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{
						stopReason: "toolUse",
					},
				);
			},
			(context) => {
				captured.push({ messages: context.messages });
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);
		const submissionId = await runtime.submit(session.id, alice, "look", "hook-1");
		expect(await runtime.waitForSubmission(submissionId)).toEqual({ status: "done" });

		// The stored result carries the details, and the request the hook produced has an image block.
		const entries = (await runtime.entriesPage(session.id, undefined, 100)).entries;
		const result = entries.find((entry: EntryRecord) => entry.kind === "pi.tool-result");
		const stored = result?.model?.[0];
		expect(stored?.role).toBe("toolResult");
		if (stored?.role !== "toolResult") throw new Error("no tool result");
		expect(stored.details).toMatchObject({ image: { mime: "image/png", width: 40, height: 30 } });

		const second = captured[1]?.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "view_image",
		);
		expect(second?.content).toHaveLength(1);
		const block = firstBlock(second === undefined ? undefined : [second]);
		expect(block).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(block.data).toBe(image.toString("base64"));
	});

	it("checks a cached image against the current model's limits", async () => {
		const image = png(40, 30);
		const digest = sha256Hex(image);
		await imageCache.put(digest, "image/png", image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "small-image-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const at = Date.now();
		const message = toolResultMessage(
			{
				image: {
					sha256: digest,
					mime: "image/png",
					width: 40,
					height: 30,
					bytes: image.length,
					source: { node: "web-1", path: "/x.png" },
				},
			},
			at,
		);
		const replaced = await replaceViewImages(options, conversationId, [message]);
		const block = firstBlock(replaced);
		expect(block.type).toBe("text");
		// The image is cached and was valid for the model view_image ran under; this session's model is smaller.
		expect(block.text).toContain("40x30");
		expect(block.text).toContain("10x10");
	});

	it("re-reads a library source on a miss, and writes a placeholder when it changed or is a node source", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const digest = sha256Hex(image);
		const details = {
			image: {
				sha256: digest,
				mime: "image/png",
				width: 40,
				height: 30,
				bytes: image.length,
				source: { library: "user:alice", path: "pic.png" },
			},
		};
		const message = toolResultMessage(details);
		// No prior cache: the library file itself must be read and cached.
		const first = await replaceViewImages(options, conversationId, [message]);
		expect(firstBlock(first)).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(await imageCache.get(digest)).toBeDefined();

		// The cache is gone and the file changed: no image, a placeholder that says why.
		await db.deleteFrom("image_cache").execute();
		imageCache.forget(digest);
		await backend.deleteCache(digest);
		await put(Buffer.from("changed"));
		const changed = await replaceViewImages(options, conversationId, [message]);
		const changedText = firstBlock(changed);
		expect(changedText).toMatchObject({ type: "text" });
		expect(changedText.text).toContain("changed since it was viewed");
		expect(changedText.text).toContain("Call view_image again");

		// A node source is never read again during a request.
		const nodeMessage = toolResultMessage({
			image: {
				sha256: "0".repeat(64),
				mime: "image/png",
				width: 1,
				height: 1,
				bytes: 1,
				source: { node: "web-1", path: "/x.png" },
			},
		});
		const node = await replaceViewImages(options, conversationId, [nodeMessage]);
		expect(firstBlock(node).text).toContain("no longer cached");
	});

	it("keeps an old result a placeholder when a newer read restores an evicted entry", async () => {
		const image = png();
		const digest = sha256Hex(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const details = {
			image: {
				sha256: digest,
				mime: "image/png",
				width: 40,
				height: 30,
				bytes: image.length,
				source: { node: "web-1", path: "/x.png" },
			},
		};
		const oldAt = Date.now() - 60_000;
		await imageCache.put(digest, "image/png", image, oldAt);
		const old = toolResultMessage(details, oldAt + 1);
		expect(firstBlock(await replaceViewImages(options, conversationId, [old])).type).toBe("image");

		// The entry expires; the old result can no longer be restored, and is a placeholder.
		await db.deleteFrom("image_cache").where("sha256", "=", digest).execute();
		imageCache.forget(digest);
		await backend.deleteCache(digest);
		const evicted = await replaceViewImages(options, conversationId, [old]);
		expect(firstBlock(evicted).text).toContain("no longer cached");

		// Reading the same image again restores the entry now; the old placeholder must not flip back.
		const readAt = Date.now();
		await imageCache.put(digest, "image/png", image, readAt);
		const fresh = toolResultMessage(details, readAt);
		const first = await replaceViewImages(options, conversationId, [old, fresh]);
		const firstOld = firstBlock(first);
		expect(firstOld).toMatchObject({ type: "text" });
		expect(firstOld.text).toContain("cached after this result");
		expect(first?.[1]?.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });

		// Consecutive requests keep the same placeholder text, and a restart over the same DB makes the same call.
		const second = await replaceViewImages(options, conversationId, [old, fresh]);
		expect(firstBlock(second).text).toBe(firstOld.text);
		options.imageCache = new ImageCache(db, backend, cacheLimits);
		const restarted = await replaceViewImages(options, conversationId, [old, fresh]);
		expect(firstBlock(restarted).text).toBe(firstOld.text);
		expect(restarted?.[1]?.content[0]).toMatchObject({ type: "image" });
	});

	it("restores a library result once, backdating the entry to that result", async () => {
		const image = png();
		await put(image);
		const digest = sha256Hex(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const details = {
			image: {
				sha256: digest,
				mime: "image/png",
				width: 40,
				height: 30,
				bytes: image.length,
				source: { library: "user:alice", path: "pic.png" },
			},
		};
		const resultAt = Date.now() - 60_000;
		const restored = toolResultMessage(details, resultAt);
		expect(firstBlock(await replaceViewImages(options, conversationId, [restored]))).toMatchObject({
			type: "image",
			mimeType: "image/png",
		});
		expect(await imageCache.storedAt(digest)).toBe(resultAt);

		// A result produced after the restore uses the entry normally.
		const newer = toolResultMessage(details, resultAt + 1000);
		const both = await replaceViewImages(options, conversationId, [restored, newer]);
		expect(firstBlock(both).type).toBe("image");
		expect(both?.[1]?.content[0]).toMatchObject({ type: "image" });
	});

	it("rejects an image after two provider 4xx responses and then sends a placeholder", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Reject",
		});
		const requests: PiMessage[][] = [];
		const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400: unsupported image" });
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);

		// The first request carrying the image is refused; the second one is refused too.
		const first = await runtime.submit(session.id, alice, "look", "reject-1");
		expect(await runtime.waitForSubmission(first)).toEqual({ status: "unanswered", reason: "model_error" });
		const second = await runtime.submit(session.id, alice, "again", "reject-2");
		expect(await runtime.waitForSubmission(second)).toEqual({ status: "unanswered", reason: "model_error" });

		// The transcript now has two 4xx responses after the result: the next request carries the placeholder,
		// and its success does not make the image sendable again.
		const third = await runtime.submit(session.id, alice, "again", "reject-3");
		expect(await runtime.waitForSubmission(third)).toEqual({ status: "done" });
		const thirdRequest = viewImageResult(requests.at(-1));
		expect(thirdRequest?.content[0]).toEqual({ type: "text", text: REJECTED_IMAGE_TEXT });

		// view_image itself refuses the already-rejected image, returning the same text instead of details.
		faux.appendResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call-2" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("looked")]);
			},
		]);
		const fourth = await runtime.submit(session.id, alice, "look again", "reject-4");
		expect(await runtime.waitForSubmission(fourth)).toEqual({ status: "done" });
		const entries = (await runtime.entriesPage(session.id, undefined, 100)).entries;
		const results = entries.filter((entry: EntryRecord) => entry.kind === "pi.tool-result");
		const stored = results.at(-1)?.model?.[0];
		expect(stored?.role).toBe("toolResult");
		if (stored?.role !== "toolResult") throw new Error("no tool result");
		expect(stored.content).toEqual([{ type: "text", text: REJECTED_IMAGE_TEXT }]);
		expect(stored.details).toBeUndefined();
	});

	it("treats a success between errors as a sent image, so later 4xx responses do not reject it", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Reset",
		});
		const requests: PiMessage[][] = [];
		const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400: unsupported image" });
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("ok")]);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("still ok")]);
			},
		]);

		const first = await runtime.submit(session.id, alice, "look", "reset-1");
		expect(await runtime.waitForSubmission(first)).toEqual({ status: "unanswered", reason: "model_error" });
		const second = await runtime.submit(session.id, alice, "again", "reset-2");
		expect(await runtime.waitForSubmission(second)).toEqual({ status: "done" });
		const third = await runtime.submit(session.id, alice, "again", "reset-3");
		expect(await runtime.waitForSubmission(third)).toEqual({ status: "unanswered", reason: "model_error" });
		const fourth = await runtime.submit(session.id, alice, "again", "reset-4");
		expect(await runtime.waitForSubmission(fourth)).toEqual({ status: "unanswered", reason: "model_error" });

		// One success before the two later failures means the image was sent: it is never rejected.
		const fifth = await runtime.submit(session.id, alice, "again", "reset-5");
		expect(await runtime.waitForSubmission(fifth)).toEqual({ status: "done" });
		expect(viewImageResult(requests.at(-1))?.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("does not count a non-4xx provider error against the image", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Server error",
		});
		const requests: PiMessage[][] = [];
		const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "501: not implemented" });
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);

		const first = await runtime.submit(session.id, alice, "look", "server-1");
		expect(await runtime.waitForSubmission(first)).toEqual({ status: "unanswered", reason: "model_error" });
		const second = await runtime.submit(session.id, alice, "again", "server-2");
		expect(await runtime.waitForSubmission(second)).toEqual({ status: "unanswered", reason: "model_error" });

		// Two 501 responses are not a provider rejection: the third request still carries the image.
		const third = await runtime.submit(session.id, alice, "again", "server-3");
		expect(await runtime.waitForSubmission(third)).toEqual({ status: "done" });
		expect(viewImageResult(requests.at(-1))?.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("keeps a rejection in the conversation that saw it", async () => {
		const image = png();
		await put(image);
		const rejectedSession = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Rejected",
		});
		const otherSession = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Other",
		});
		const requests: PiMessage[][] = [];
		const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400: unsupported image" });
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call-2" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("seen")]);
			},
		]);

		const first = await runtime.submit(rejectedSession.id, alice, "look", "other-1");
		expect(await runtime.waitForSubmission(first)).toEqual({ status: "unanswered", reason: "model_error" });
		const second = await runtime.submit(rejectedSession.id, alice, "again", "other-2");
		expect(await runtime.waitForSubmission(second)).toEqual({ status: "unanswered", reason: "model_error" });

		// The same SHA-256 in another conversation was never rejected there.
		const third = await runtime.submit(otherSession.id, alice, "look", "other-3");
		expect(await runtime.waitForSubmission(third)).toEqual({ status: "done" });
		expect(viewImageResult(requests.at(-1))?.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("derives the same rejection after a restart", async () => {
		const image = png();
		await put(image);
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
			title: "Restart",
		});
		const requests: PiMessage[][] = [];
		const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400: unsupported image" });
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(
					[fauxToolCall("view_image", { library: "user:alice", path: "pic.png" }, { id: "img-call" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
			(context) => {
				requests.push([...context.messages]);
				return error();
			},
		]);

		const first = await runtime.submit(session.id, alice, "look", "restart-1");
		expect(await runtime.waitForSubmission(first)).toEqual({ status: "unanswered", reason: "model_error" });
		const second = await runtime.submit(session.id, alice, "again", "restart-2");
		expect(await runtime.waitForSubmission(second)).toEqual({ status: "unanswered", reason: "model_error" });

		// A restarted runtime derives the rejection from the same transcript, with no in-memory state.
		await runtime.close();
		runtime = await AgentRuntime.open(options);
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		const third = await runtime.submit(session.id, alice, "again", "restart-3");
		expect(await runtime.waitForSubmission(third)).toEqual({ status: "done" });
		expect(viewImageResult(requests.at(-1))?.content[0]).toEqual({ type: "text", text: REJECTED_IMAGE_TEXT });
	});

	it("writes a placeholder for a model without image input", async () => {
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "text-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const message = toolResultMessage({
			image: {
				sha256: "a".repeat(64),
				mime: "image/png",
				width: 1,
				height: 1,
				bytes: 1,
				source: { node: "web-1", path: "/x.png" },
			},
		});
		const replaced = await replaceViewImages(options, conversationId, [message]);
		expect(firstBlock(replaced).text).toContain("cannot take images");
	});

	it("leaves a result without structured details alone", async () => {
		const session = await runtime.createSession(alice, {
			model: { provider: faux.provider.id, modelId: "image-model" },
			rulePreset: "ask",
		});
		const conversationId = await conversationIdOf(db, session.id);
		const message = { ...toolResultMessage(undefined), content: [{ type: "text" as const, text: "a text result" }] };
		const replaced = await replaceViewImages(options, conversationId, [message]);
		expect(replaced).toBeUndefined();
	});
});

async function conversationIdOf(db: Db, sessionId: string): Promise<string> {
	const row = await db
		.selectFrom("sessions")
		.select("conversation_id")
		.where("id", "=", sessionId)
		.executeTakeFirstOrThrow();
	return row.conversation_id;
}
