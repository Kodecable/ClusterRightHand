import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@crh/api";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
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
import { ImageCache } from "../src/library/image-cache.ts";
import { findLibraryByRef } from "../src/library/library.ts";
import type { Db } from "../src/storage/db.ts";
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
	],
});

describe("view_image beforeRequest hook", () => {
	let db: Db;
	let root: string;
	let runtime: AgentRuntime;
	let options: AgentRuntimeOptions;
	let imageCache: ImageCache;
	let backend: ReturnType<typeof createLibraryBackend>;
	let alice: SessionUser;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-image-hook-"));
		backend = createLibraryBackend({ backend: "local" }, root);
		const audit = new Audit(db);
		const cluster = new Cluster(db, { audit, libraryBackend: backend });
		const models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		imageCache = new ImageCache(db, backend, () => ({ memoryBytes: 1 << 20, diskBytes: 1 << 20, ttlMs: 60_000 }));
		options = {
			db,
			storage: new MemoryStorage(),
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

	function toolResultMessage(details: unknown): PiMessage {
		return {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "view_image",
			content: [{ type: "text", text: "[view_image pic.png]" }],
			details: details as never,
			isError: false,
			timestamp: 0,
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
