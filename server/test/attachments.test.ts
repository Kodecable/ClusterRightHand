import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatAttachment, EntryRecord, SessionView, SystemSettings } from "@crh/api";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createLibraryBackend, type LibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload } from "../src/library/files.ts";
import { findLibraryByRef } from "../src/library/library.ts";
import { defaultSystemSettings, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id, thinkingLevel: "off" as const });
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function png(): Buffer {
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		Buffer.from([0, 0, 1, 44, 0, 0, 0, 200]),
		Buffer.alloc(16, 1),
	]);
}

describe("chat attachments", () => {
	let db: Db;
	let root: string;
	let backend: LibraryBackend;
	let runtime: AgentRuntime;
	let app: App;
	let alice: string;
	let bob: string;
	let aliceId: string;
	let bobId: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-attachments-"));
		backend = createLibraryBackend({ backend: "local" }, root);
		const audit = new Audit(db);
		const cluster = new Cluster(db, { audit, libraryBackend: backend });
		const masterKey = MasterKey.generate();
		const models = new ModelConfig(db, masterKey);
		models.addProvider(faux.provider);
		await models.reload();
		runtime = await AgentRuntime.open({
			db,
			storage: new MemoryStorage(),
			models,
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit }),
			audit,
		});
		const settings = SettingsStore.fromSystemSettings({
			...defaultSystemSettings(),
			attachments: { inlineTextBytes: 64, inlineTotalBytes: 20 },
			auth: { ...defaultSystemSettings().auth, captcha: "none" },
		} satisfies SystemSettings);
		app = makeApp(db, undefined, {
			cluster,
			audit,
			masterKey,
			libraryBackend: backend,
			agent: { runtime, models },
			settings,
		});
		aliceId = (await createUser(db, { username: "alice", kind: "member", password: "alice-password" })).id;
		bobId = (await createUser(db, { username: "bob", kind: "member", password: "bob-password" })).id;
		alice = await login(app, "alice", "alice-password");
		bob = await login(app, "bob", "bob-password");
	});

	afterEach(async () => {
		await runtime.close();
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	async function put(user: string, path: string, data: Uint8Array): Promise<void> {
		const record = await findLibraryByRef(db, `user:${user}`);
		if (!record) throw new Error("no library");
		const upload = beginLibraryUpload(db, backend, {
			library: record.row,
			path,
			overwrite: true,
			createdBy: null,
		});
		await upload.write(data);
		await upload.commit();
	}

	async function entries(sessionId: string): Promise<EntryRecord[]> {
		return (await runtime.entriesPage(sessionId, undefined, 100)).entries;
	}

	/** A crh input entry's model content blocks; the test fails clearly when it has none. */
	function contentBlocks(entry: EntryRecord | undefined): { type: string; text: string }[] {
		if (!entry) throw new Error("no crh.user_input entry");
		const message = entry.model?.[0];
		if (!message) throw new Error("the entry has no model message");
		if (!Array.isArray(message.content)) throw new Error("the entry content is not a block list");
		return message.content as { type: string; text: string }[];
	}

	async function create(body: Record<string, unknown>): Promise<{ res: Response; session?: SessionView }> {
		const res = await call(app, "/api/sessions", {
			cookie: alice,
			body: {
				requestId: newId(),
				message: "look at these",
				model: model(),
				rulePreset: "ask",
				...body,
			},
		});
		const parsed = (await res.json()) as { session?: SessionView };
		return { res, ...(parsed.session ? { session: parsed.session } : {}) };
	}

	it("submits a crh.user_input entry with blocks and attachment data", async () => {
		await put("alice", "notes/a.txt", Buffer.from("hello attachment"));
		const { res, session } = await create({ attachments: [{ library: "user:alice", path: "notes/a.txt" }] });
		expect(res.status).toBe(201);
		if (!session) throw new Error("no session");
		const list = await entries(session.id);
		const input = list.find((entry) => entry.kind === "crh.user_input");
		expect(input).toBeDefined();
		if (!input) throw new Error("no input entry");
		const attachment = (input.data as unknown as { attachments: ChatAttachment[] }).attachments[0];
		expect(attachment).toMatchObject({
			library: "user:alice",
			path: "notes/a.txt",
			name: "a.txt",
			bytes: 16,
			mime: "text/plain",
			sha256: sha256Hex(Buffer.from("hello attachment")),
			inlined: true,
		});
		const blocks = contentBlocks(input);
		expect(blocks[0]).toEqual({ type: "text", text: "look at these" });
		const note = blocks[1];
		if (!note) throw new Error("no attachment block");
		expect(note).toMatchObject({ type: "text" });
		expect(note.text).toContain("The user uploaded the file a.txt (16 bytes), saved to user:alice at notes/a.txt.");
		expect(note.text).toContain("hello attachment");
		expect(note.text.endsWith("hello attachment")).toBe(true);
	});

	it("inlines only valid UTF-8 text within both limits; images get the note only", async () => {
		await put("alice", "a.txt", Buffer.from("aaaa"));
		await put("alice", "b.txt", Buffer.from("bbbbbbbbbbbbbbbbbbbb"));
		await put("alice", "bin.dat", Buffer.from([0xff, 0x00, 0x01]));
		await put("alice", "pic.png", png());
		const { res, session } = await create({
			attachments: [
				{ library: "user:alice", path: "a.txt" },
				{ library: "user:alice", path: "b.txt" },
				{ library: "user:alice", path: "bin.dat" },
				{ library: "user:alice", path: "pic.png" },
			],
			message: "four files",
		});
		expect(res.status).toBe(201);
		if (!session) throw new Error("no session");
		const input = (await entries(session.id)).find((entry) => entry.kind === "crh.user_input");
		if (!input) throw new Error("no input entry");
		const attachments = (input.data as unknown as { attachments: ChatAttachment[] }).attachments;
		expect(attachments.map((attachment) => attachment.inlined)).toEqual([true, false, false, false]);
		const content = contentBlocks(input);
		expect(content[1]?.text).toContain("aaaa");
		expect(content[2]?.text).toContain("The content was not included; copy it to a node and read it there.");
		expect(content[3]?.text).toContain("The content was not included; copy it to a node and read it there.");
		// An image gets the note only; the agent calls view_image.
		expect(content[4]?.text).toContain("The user uploaded the file pic.png");
		expect(content[4]?.text).not.toContain("copy it to a node");
	});

	it("keeps a plain pi.user entry without attachments", async () => {
		const { res, session } = await create({});
		expect(res.status).toBe(201);
		if (!session) throw new Error("no session");
		const list = await entries(session.id);
		expect(list.some((entry) => entry.kind === "pi.user")).toBe(true);
		expect(list.some((entry) => entry.kind === "crh.user_input")).toBe(false);
	});

	it("refuses attachments from a session shared for chat", async () => {
		await put("alice", "a.txt", Buffer.from("hello"));
		const { session } = await create({});
		if (!session) throw new Error("no session");
		await db
			.insertInto("shares")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				resource_type: "session",
				resource_id: session.id,
				grantee_type: "user",
				grantee_id: bobId,
				access: "chat",
				created_by_user_id: aliceId,
				created_at: new Date().toISOString(),
			})
			.execute();
		const res = await call(app, `/api/sessions/${session.id}/messages`, {
			cookie: bob,
			body: { text: "hi", requestId: newId(), attachments: [{ library: "user:alice", path: "a.txt" }] },
		});
		expect(res.status).toBe(403);
	});

	it("adds attachments to a later message and keeps request-id idempotency", async () => {
		await put("alice", "a.txt", Buffer.from("hello again"));
		const { session } = await create({});
		if (!session) throw new Error("no session");
		const requestId = newId();
		const body = { text: "second", requestId, attachments: [{ library: "user:alice", path: "a.txt" }] };
		const first = await call(app, `/api/sessions/${session.id}/messages`, { cookie: alice, body });
		expect(first.status).toBe(202);
		const second = await call(app, `/api/sessions/${session.id}/messages`, { cookie: alice, body });
		expect(second.status).toBe(202);
		const list = await entries(session.id);
		expect(list.filter((entry) => entry.kind === "crh.user_input")).toHaveLength(1);
	});
});
