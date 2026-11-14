import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as z from "zod/v4";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../src/cluster/task-groups.ts";
import { createLibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload, findLibraryFile } from "../src/library/files.ts";
import { ImageCache } from "../src/library/image-cache.ts";
import { findLibraryByRef } from "../src/library/library.ts";
import { newStagingLocation } from "../src/library/transfer-location.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import type { ToolResult } from "../src/tools/render.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function png(width: number, height: number, fill = 4): Buffer {
	const header = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const size = Buffer.alloc(8);
	size.writeUInt32BE(width, 0);
	size.writeUInt32BE(height, 4);
	return Buffer.concat([header, size, Buffer.alloc(fill, 1)]);
}

type AnyTool = {
	name: string;
	input: z.ZodType;
	output: "text" | "json";
	handler: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};
const tool = (name: string): AnyTool => {
	const found = TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found as unknown as AnyTool;
};
const jsonOf = (result: ToolResult): Record<string, unknown> =>
	JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
const textOf = (result: ToolResult): string => result.content.map((block) => block.text).join("\n");

function task(overrides: Partial<TaskView>): TaskView {
	return {
		id: newId(),
		nodeId: "n1",
		kind: "file.push",
		summary: "copy",
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		timeoutMs: null,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		maxLines: null,
		maxBytes: null,
		outputFile: null,
		outputMode: "status",
		privileged: false,
		authorization: null,
		result: null,
		createdAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		taskGroupId: null,
		ruleChain: null,
		approval: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		...overrides,
	} as TaskView;
}

/** A cluster that records node-side calls and finishes them at once. */
function fakeCluster(transferRoot: string) {
	const tasks = new Map<string, TaskView>();
	const pushes: { path: string; location: unknown; createParentDirs?: boolean }[] = [];
	const pulls: { path: string }[] = [];
	const stats: { nodeId: string; path: string }[] = [];
	let staged: Uint8Array = new Uint8Array(0);
	let statSize = 0;
	let statMissing = false;
	const cluster = {
		libraryBackend: undefined,
		transferContext: () => ({ root: transferRoot }),
		stagingLocation: () => newStagingLocation(),
		async createTask(input: { nodeId: string; spec: { kind: string; path: string } }) {
			stats.push({ nodeId: input.nodeId, path: input.spec.path });
			const view = statMissing
				? task({
						nodeId: input.nodeId,
						kind: "file.stat",
						state: "rejected",
						errorCode: "not_found",
						errorMessage: `no such file ${input.spec.path}`,
					})
				: task({
						nodeId: input.nodeId,
						kind: "file.stat",
						result: {
							kind: "file.stat",
							path: input.spec.path,
							type: "file",
							size: statSize,
							mode: "0644",
							uid: 0,
							gid: 0,
							owner: "root",
							group: "root",
							mtime: "2026-01-01T00:00:00Z",
							linkTarget: null,
						},
					});
			tasks.set(view.id, view);
			return view;
		},
		async pullFile(input: { path: string; location: { path: string } }) {
			pulls.push({ path: input.path });
			const target = join(transferRoot, input.location.path);
			await import("node:fs/promises").then((fs) => fs.mkdir(transferRoot, { recursive: true }));
			const { writeFile } = await import("node:fs/promises");
			await writeFile(target, staged);
			const view = task({
				kind: "file.pull",
				result: { kind: "file.pull", size: staged.length, sha256: sha256Hex(staged) },
			});
			tasks.set(view.id, view);
			return view;
		},
		async pushFile(input: { path: string; location: unknown }) {
			pushes.push({ path: input.path, location: input.location });
			const view = task({ kind: "file.push" });
			tasks.set(view.id, view);
			return view;
		},
		async pushLibraryFile(input: { path: string; createParentDirs?: boolean }) {
			pushes.push({ path: input.path, location: {}, createParentDirs: input.createParentDirs });
			const view = task({ kind: "file.push" });
			tasks.set(view.id, view);
			return view;
		},
		async pullLibraryFile(input: { path: string }) {
			pulls.push({ path: input.path });
			const view = task({
				kind: "file.pull",
				result: { kind: "file.pull", size: staged.length, sha256: sha256Hex(staged) },
			});
			tasks.set(view.id, view);
			return view;
		},
		async getTask(id: string) {
			return tasks.get(id);
		},
	} as unknown as Cluster & { libraryBackend: undefined };
	const groups = new Map<string, TaskGroupView>();
	const taskGroups = {
		async create(input: {
			id?: string;
			nodeIds: string[];
			targets: string[];
			spec: { kind: string; path: string };
			transferLocation: { kind: string; libraryId?: string; path: string };
		}) {
			const id = input.id ?? newId();
			const members: TaskView[] = [];
			for (const nodeId of input.nodeIds) {
				const view =
					input.transferLocation.kind === "library"
						? await cluster.pushLibraryFile({
								nodeId,
								path: input.spec.path,
								libraryId: input.transferLocation.libraryId as string,
								libraryPath: input.transferLocation.path,
							} as never)
						: await cluster.pushFile({
								nodeId,
								path: input.spec.path,
								location: input.transferLocation,
							} as never);
				members.push(view);
			}
			groups.set(id, {
				id,
				state: "finished",
				targets: input.targets,
				nodeIds: input.nodeIds,
				tasks: members,
				skipped: [],
				privileged: false,
			} as never);
			return id;
		},
		async get(id: string) {
			return groups.get(id);
		},
		waitsEnded: false,
	};
	return {
		cluster,
		taskGroups,
		tasks,
		pushes,
		pulls,
		stats,
		setStaged(data: Uint8Array) {
			staged = data;
		},
		setStat(size: number, missing = false) {
			statSize = size;
			statMissing = missing;
		},
	};
}

async function addNode(db: Db, userId: string, name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport: "client",
			status: "active",
			public_key: null,
			hostname: name,
			facts: null,
			client_version: null,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	await db
		.insertInto("node_access_grants")
		.values({
			id: newId(),
			org_id: await defaultOrgId(db),
			grantee_type: "user",
			grantee_id: userId,
			target_type: "node",
			target_id: id,
			created_by_user_id: userId,
			created_at: now,
		})
		.execute();
	return id;
}

describe("library tools", () => {
	let db: Db;
	let root: string;
	let backend: ReturnType<typeof createLibraryBackend>;
	let alice: SessionUser;
	let bob: SessionUser;
	let admin: SessionUser;
	let context: ToolContext;

	async function put(ref: string, path: string, data: Uint8Array): Promise<void> {
		const record = await findLibraryByRef(db, ref);
		if (!record) throw new Error(`no library ${ref}`);
		const upload = beginLibraryUpload(db, backend, {
			library: record.row,
			path,
			overwrite: true,
			createdBy: null,
		});
		await upload.write(data);
		await upload.commit();
	}

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-phase3-"));
		backend = createLibraryBackend({ backend: "local" }, root);
		const aliceRow = await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
		const bobRow = await createUser(db, { username: "bob", kind: "member", password: "bob-password" });
		const adminRow = await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		alice = { sessionId: "s", userId: aliceRow.id, username: "alice", kind: "member" };
		bob = { sessionId: "s", userId: bobRow.id, username: "bob", kind: "member" };
		admin = { sessionId: "s", userId: adminRow.id, username: "root", kind: "admin" };
		const groupId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("user_groups")
			.values({
				id: groupId,
				org_id: await defaultOrgId(db),
				name: "team",
				source: "local",
				created_at: now,
			})
			.execute();
		await db
			.insertInto("user_group_members")
			.values({ user_group_id: groupId, user_id: alice.userId, created_at: now })
			.execute();
		await db
			.insertInto("libraries")
			.values({
				id: newId(),
				owner_kind: "user_group",
				owner_id: groupId,
				max_files: 10,
				max_file_bytes: 1024 * 1024,
				max_total_bytes: 4 * 1024 * 1024,
				used_files: 0,
				used_bytes: 0,
				created_at: now,
			})
			.execute();
		await put("user:alice", "docs/a.txt", Buffer.from("hello alice"));
		await put("user:alice", "docs/images/pic.png", png(800, 600));
		await put("user_group:team", "shared.txt", Buffer.from("hello team"));
		context = {
			db,
			cluster: { libraryBackend: backend } as unknown as Cluster,
			taskGroups: {} as TaskGroups,
			user: alice,
			actor: { type: "user", id: alice.userId, onBehalfOfUserId: alice.userId },
			chain: [],
			approvalUrl: () => "http://crh.test/approval",
			imageCache: new ImageCache(db, join(root, "image-cache"), () => ({
				diskBytes: 1024 * 1024,
				ttlMs: 1000,
			})),
		};
	});

	afterEach(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	it("lists and stats the owner's own and group libraries", async () => {
		const listing = jsonOf(await tool("list_dir").handler({ library: "user:alice", path: "docs" } as never, context));
		expect(listing).toMatchObject({ library: "user:alice", path: "docs" });
		expect(listing.files).toEqual([
			expect.objectContaining({ path: "docs/a.txt", name: "a.txt", size: 11, media_type: "text/plain" }),
		]);
		expect(listing.directories).toEqual(["docs/images"]);
		const group = jsonOf(await tool("list_dir").handler({ library: "user_group:team", path: "" } as never, context));
		expect(group.files).toEqual([expect.objectContaining({ path: "shared.txt" })]);
		const stat = jsonOf(await tool("stat").handler({ library: "user:alice", path: "docs/a.txt" } as never, context));
		expect(stat).toMatchObject({ path: "docs/a.txt", size: 11, media_type: "text/plain" });
		expect(stat.sha256).toBe(sha256Hex(Buffer.from("hello alice")));
	});

	it("normalizes a leading / in library paths", async () => {
		const rootListing = jsonOf(await tool("list_dir").handler({ library: "user:alice", path: "/" } as never, context));
		expect(rootListing).toMatchObject({ library: "user:alice", path: "" });
		expect(rootListing.files).toEqual([]);
		expect(rootListing.directories).toEqual(["docs"]);

		const copy = await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "/docs/a.txt" },
				destination: { library: "user_group:team", path: "/docs/a.txt" },
			} as never,
			context,
		);
		expect(copy.isError).toBe(false);
		expect(jsonOf(copy)).toMatchObject({ library: "user_group:team", path: "docs/a.txt", size: 11 });
		const row = await findLibraryFile(
			db,
			(await findLibraryByRef(db, "user_group:team"))?.row.id as string,
			"docs/a.txt",
		);
		expect(row?.sha256).toBe(sha256Hex(Buffer.from("hello alice")));
	});

	it("does not apply the administrator bypass or reach another user's library", async () => {
		await expect(
			tool("stat").handler({ library: "user:bob", path: "x" } as never, { ...context, user: alice }),
		).rejects.toThrow();
		await expect(
			tool("stat").handler({ library: "user:bob", path: "x" } as never, { ...context, user: admin }),
		).rejects.toThrow();
		// A group library needs membership as well, for an administrator too.
		await expect(
			tool("stat").handler({ library: "user_group:team", path: "shared.txt" } as never, { ...context, user: bob }),
		).rejects.toThrow();
	});

	it("copies between libraries with overwrite and limits", async () => {
		const copy = await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "docs/a.txt" },
				destination: { library: "user_group:team", path: "docs/a.txt" },
			} as never,
			context,
		);
		const body = jsonOf(copy);
		expect(body).toMatchObject({ library: "user_group:team", path: "docs/a.txt", size: 11 });
		const row = await findLibraryFile(
			db,
			(await findLibraryByRef(db, "user_group:team"))?.row.id as string,
			"docs/a.txt",
		);
		expect(row?.sha256).toBe(sha256Hex(Buffer.from("hello alice")));

		const overwrite = await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "docs/a.txt" },
				destination: { library: "user_group:team", path: "docs/a.txt" },
				overwrite: true,
			} as never,
			context,
		);
		expect(overwrite.isError).toBe(false);
		await expect(
			tool("copy_file").handler(
				{
					source: { library: "user:alice", path: "docs/a.txt" },
					destination: { library: "user_group:team", path: "docs/a.txt" },
				} as never,
				context,
			),
		).rejects.toThrow("already exists");

		const group = await findLibraryByRef(db, "user_group:team");
		await db
			.updateTable("libraries")
			.set({ max_file_bytes: 4 })
			.where("id", "=", group?.row.id as string)
			.execute();
		await expect(
			tool("copy_file").handler(
				{
					source: { library: "user:alice", path: "docs/a.txt" },
					destination: { library: "user_group:team", path: "small.txt" },
				} as never,
				context,
			),
		).rejects.toThrow();
	});

	it("refuses a copy onto a directory or under a file", async () => {
		await put("user_group:team", "dir/child.txt", Buffer.from("child"));
		await put("user_group:team", "plain.txt", Buffer.from("plain"));
		const source = { library: "user:alice", path: "docs/a.txt" };

		await expect(
			tool("copy_file").handler({ source, destination: { library: "user_group:team", path: "dir" } } as never, context),
		).rejects.toThrow("a directory already exists at dir");
		await expect(
			tool("copy_file").handler(
				{ source, destination: { library: "user_group:team", path: "plain.txt/child.txt" } } as never,
				context,
			),
		).rejects.toThrow("a file already exists at plain.txt");
	});

	it("offers a library file to the user without copying it", async () => {
		const source = { library: "user:alice", path: "docs/a.txt" };
		const result = await tool("copy_file").handler({ source, destination: { user_interface: true } } as never, context);
		expect(result.isError).toBe(false);
		const library = await findLibraryByRef(db, "user:alice");
		expect(result.details?.delivery).toEqual({
			source: { library: "user:alice", libraryId: library?.row.id, path: "docs/a.txt" },
			name: "a.txt",
			bytes: 11,
		});
		expect(textOf(result)).toContain("copy_file offered a.txt, 11 bytes, to the user for download");
		expect(textOf(result)).toContain("from user:alice at docs/a.txt");
		// overwrite has no effect with user_interface, and is not an error.
		const withOverwrite = await tool("copy_file").handler(
			{ source, destination: { user_interface: true }, overwrite: true } as never,
			context,
		);
		expect(withOverwrite.isError).toBe(false);
		expect(withOverwrite.details?.delivery).toEqual(result.details?.delivery);
		// Nothing was copied: the group library is untouched.
		expect(
			await findLibraryFile(db, (await findLibraryByRef(db, "user_group:team"))?.row.id as string, "a.txt"),
		).toBeUndefined();

		// A missing source is the ordinary stat refusal; no delivery is recorded for a file that is not there.
		await expect(
			tool("copy_file").handler(
				{ source: { library: "user:alice", path: "docs/missing.txt" }, destination: { user_interface: true } } as never,
				context,
			),
		).rejects.toThrow("no such library file");
	});

	it("validates the destination: node options belong to the node destination", () => {
		const input = tool("copy_file").input as z.ZodType;
		const source = { library: "user:alice", path: "docs/a.txt" };
		// Exactly one destination shape; node-only options are not part of a library destination.
		expect(input.safeParse({ source, destination: { user_interface: true } }).success).toBe(true);
		expect(input.safeParse({ source, destination: { user_interface: true, mode: "0644" } }).success).toBe(false);
		expect(
			input.safeParse({ source, destination: { library: "user_group:team", path: "a.txt", mode: "0644" } }).success,
		).toBe(false);
		expect(input.safeParse({ source, destination: { targets: ["web-1"], path: "/x" } }).success).toBe(true);
		// overwrite is meaningless with user_interface and has no effect rather than erroring.
		expect(input.safeParse({ source, destination: { user_interface: true }, overwrite: true }).success).toBe(true);
		// A copy still needs a destination.
		expect(input.safeParse({ source }).success).toBe(false);
	});

	it("offers a node file after a stat, and reports a missing one", async () => {
		const nodeId = await addNode(db, alice.userId, "web-1");
		const fake = fakeCluster(root);
		fake.setStat(42);
		const result = await tool("copy_file").handler(
			{ source: { node: "web-1", path: "/srv/a.txt" }, destination: { user_interface: true } } as never,
			{
				...context,
				cluster: fake.cluster,
			},
		);
		expect(result.isError).toBe(false);
		expect(fake.stats).toEqual([{ nodeId, path: "/srv/a.txt" }]);
		expect(result.details?.delivery).toEqual({
			source: { node: "web-1", nodeId, path: "/srv/a.txt" },
			name: "a.txt",
			bytes: 42,
		});
		expect(textOf(result)).toContain("to the user for download");
		expect(textOf(result)).toContain("from web-1 at /srv/a.txt");

		fake.setStat(0, true);
		const missing = await tool("copy_file").handler(
			{ source: { node: "web-1", path: "/srv/missing.txt" }, destination: { user_interface: true } } as never,
			{ ...context, cluster: fake.cluster },
		);
		expect(missing.isError).toBe(true);
		expect(jsonOf(missing)).toMatchObject({ error: { code: "not_found" } });
		expect(missing.details?.delivery).toBeUndefined();
	});

	it("asks the node to create parent directories only with create_parent_dirs", async () => {
		await addNode(db, alice.userId, "web-1");
		const fake = fakeCluster(root);
		await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "docs/a.txt" },
				destination: { targets: ["web-1"], path: "/srv/new/a.txt", create_parent_dirs: true },
			} as never,
			{ ...context, cluster: fake.cluster },
		);
		expect(fake.pushes[0]?.createParentDirs).toBe(true);
		await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "docs/a.txt" },
				destination: { targets: ["web-1"], path: "/srv/a.txt" },
			} as never,
			{ ...context, cluster: fake.cluster },
		);
		expect(fake.pushes[1]?.createParentDirs).toBe(false);
	});

	it("copies a library file to nodes", async () => {
		const nodeId = await addNode(db, alice.userId, "web-1");
		const fake = fakeCluster(root);
		const result = await tool("copy_file").handler(
			{
				source: { library: "user:alice", path: "docs/a.txt" },
				destination: { targets: ["web-1"], path: "/srv/a.txt" },
			} as never,
			{ ...context, cluster: fake.cluster },
		);
		expect(result.isError).toBe(false);
		expect(jsonOf(result)).toMatchObject({ node: "web-1", state: "exited" });
		expect(fake.pushes.map((push) => push.path)).toEqual(["/srv/a.txt"]);
		expect(nodeId).toBeTruthy();
	});

	it("copies a node file into a library and to other nodes", async () => {
		await addNode(db, alice.userId, "web-1");
		await addNode(db, alice.userId, "web-2");
		const fake = fakeCluster(root);
		fake.setStaged(Buffer.from("from node"));

		const toLibrary = await tool("copy_file").handler(
			{
				source: { node: "web-1", path: "/srv/a.txt" },
				destination: { library: "user:alice", path: "inbox/a.txt" },
			} as never,
			{ ...context, cluster: { ...fake.cluster, libraryBackend: backend } as unknown as Cluster },
		);
		expect(toLibrary.isError).toBe(false);
		expect(jsonOf(toLibrary)).toMatchObject({ node: "web-1", state: "exited" });

		const toNodes = await tool("copy_file").handler(
			{
				source: { node: "web-1", path: "/srv/a.txt" },
				destination: { targets: ["web-1", "web-2"], path: "/tmp/copy.txt" },
			} as never,
			{ ...context, cluster: fake.cluster, taskGroups: fake.taskGroups as unknown as TaskGroups },
		);
		expect(toNodes.isError).toBe(false);
		const body = jsonOf(toNodes);
		expect((body.nodes as unknown[]).length).toBe(2);
		const details = toNodes.details as { task_group_id?: string; nodes?: { task_id?: string }[] } | undefined;
		expect(details?.task_group_id).toBeTruthy();
		expect(details?.nodes).toHaveLength(2);
		expect(details?.nodes?.[0]?.task_id).toBeTruthy();
		expect(fake.pulls.length).toBeGreaterThanOrEqual(2);
		expect(fake.pushes.map((push) => push.path)).toEqual(["/tmp/copy.txt", "/tmp/copy.txt"]);
	});
});

describe("view_image", () => {
	let db: Db;
	let root: string;
	let backend: ReturnType<typeof createLibraryBackend>;
	let alice: SessionUser;
	let context: ToolContext;

	async function put(path: string, data: Uint8Array): Promise<void> {
		const record = await findLibraryByRef(db, "user:alice");
		if (!record) throw new Error("no alice library");
		const upload = beginLibraryUpload(db, backend, { library: record.row, path, overwrite: true, createdBy: null });
		await upload.write(data);
		await upload.commit();
	}

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-view-"));
		backend = createLibraryBackend({ backend: "local" }, root);
		const row = await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
		alice = { sessionId: "s", userId: row.id, username: "alice", kind: "member" };
		const imageCache = new ImageCache(db, join(root, "image-cache"), () => ({
			diskBytes: 1024 * 1024,
			ttlMs: 1000,
		}));
		context = {
			db,
			cluster: { libraryBackend: backend } as unknown as Cluster,
			taskGroups: {} as TaskGroups,
			user: alice,
			actor: { type: "user", id: alice.userId, onBehalfOfUserId: alice.userId },
			chain: [],
			approvalUrl: () => "http://crh.test/approval",
			imageCache,
			imageLimits: { supported: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 4_500_000 },
		};
	});

	afterEach(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	it("returns one text line and structured details, and caches the bytes", async () => {
		const image = png(800, 600);
		await put("pic.png", image);
		const result = await tool("view_image").handler({ library: "user:alice", path: "pic.png" } as never, context);
		expect(result.isError).toBe(false);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.text).toContain("view_image pic.png");
		const image2 = result.details?.image as Record<string, unknown>;
		expect(image2).toMatchObject({
			mime: "image/png",
			width: 800,
			height: 600,
			bytes: image.length,
			source: { library: "user:alice", path: "pic.png" },
		});
		expect(image2.sha256).toBe(sha256Hex(image));
		const cached = await context.imageCache?.get(String(image2.sha256));
		expect(cached?.bytes).toEqual(image);
	});

	it("refuses another format, an oversized image and a model without image input", async () => {
		await put("text.txt", Buffer.from("not an image"));
		const format = await tool("view_image").handler({ library: "user:alice", path: "text.txt" } as never, context);
		expect(format.isError).toBe(true);
		expect(textOf(format)).toContain("unsupported_image");

		await put("big.png", png(3000, 600));
		const large = await tool("view_image").handler({ library: "user:alice", path: "big.png" } as never, context);
		expect(large.isError).toBe(true);
		expect(textOf(large)).toContain("image_too_large");
		expect(textOf(large)).toContain("2000x2000");

		const noImages = await tool("view_image").handler({ library: "user:alice", path: "pic.png" } as never, {
			...context,
			imageLimits: { supported: false, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 1 },
		});
		expect(noImages.isError).toBe(true);
		expect(textOf(noImages)).toContain("image_input_unavailable");
	});

	it("refuses an oversized library image without reading its object", async () => {
		const image = png(20, 20, 200_000);
		await put("huge.png", image);
		const record = await findLibraryByRef(db, "user:alice");
		if (!record) throw new Error("no alice library");
		const row = await findLibraryFile(db, record.row.id, "huge.png");
		if (!row) throw new Error("no huge.png row");
		// The object is gone: a check that reads the bytes first would fail as a read error instead.
		await backend.delete(row.object_key);
		const result = await tool("view_image").handler({ library: "user:alice", path: "huge.png" } as never, {
			...context,
			imageLimits: { supported: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 10 },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("image_too_large");
	});

	it("pulls a node image into staging and caches it", async () => {
		await addNode(db, alice.userId, "web-1");
		const fake = fakeCluster(root);
		const image = png(320, 200);
		fake.setStaged(image);
		const result = await tool("view_image").handler({ node: "web-1", path: "/srv/pic.png" } as never, {
			...context,
			cluster: { ...fake.cluster, libraryBackend: backend } as unknown as Cluster,
		});
		expect(result.isError).toBe(false);
		expect(result.details?.image).toMatchObject({ source: { node: "web-1", path: "/srv/pic.png" } });
		expect(fake.pulls.length).toBe(1);
		const leftover = await readFile(join(root, newStagingLocation().path)).catch(() => undefined);
		expect(leftover).toBeUndefined();
	});
});
