/**
 * The file plane of an unprivileged node (doc/design/library.md "File plane"): crhs stages a file and
 * pushes it to the node, pulls a node file back into a staging location, and fails a pull that is too
 * large or a push whose bytes do not match the spec's SHA-256 without creating the destination.
 *
 * The node runs in `ignore` mode, so the privileged mode is not involved; the push and pull run as
 * uid 998 like every ordinary file task.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessCrhs } from "../../e2e/harness.ts";
import { buildStaticCrha, PrivilegedNode, podmanAvailable } from "./harness.ts";

const describePodman = describe.skipIf(!podmanAvailable);
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describePodman("privileged system: file plane on an unprivileged node", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let node: PrivilegedNode;
	let transferRoot = "";
	let actorId = "";

	const actor = () => ({ type: "user" as const, id: actorId, onBehalfOfUserId: actorId });

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-file-plane-"));
		bin = await buildStaticCrha(tmp);
		transferRoot = join(tmp, "staging");
		crhs = await InProcessCrhs.create({ transferRoot });
		await crhs.loginAdmin();
		actorId = (await crhs.db.selectFrom("users").select("id").where("username", "=", "root").executeTakeFirstOrThrow())
			.id;
		node = await PrivilegedNode.create({ bin, crhs, mode: "ignore", trust: [] });
	}, 600_000);

	afterAll(async () => {
		await node?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("pushes a staged file to the node with its content and mode", async () => {
		const content = Buffer.from("staged push content\n");
		const path = "/tmp/crh-plane-push.txt";
		const location = await crhs.cluster.stageBytesForPush(content);
		const task = await crhs.cluster.pushFile({
			nodeId: node.nodeId,
			path,
			location,
			overwrite: true,
			mode: 0o640,
			actor: actor(),
		});
		const done = await node.taskState(task.id);
		expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
		expect(done.result).toBeNull();
		const stat = await node.exec(["/usr/bin/stat", "-c", "%a %s", path]);
		expect(stat.stdout.trim()).toBe(`640 ${content.length}`);
		const read = await node.execAs(998, ["/bin/cat", path]);
		expect(read.stdout).toBe(content.toString());
	}, 60_000);

	it("creates missing parent directories only with createParentDirs", async () => {
		const content = Buffer.from("nested push content\n");
		const dir = `/tmp/crh-plane-parent-${randomBytes(4).toString("hex")}`;
		const path = `${dir}/a/b/c.txt`;

		// Without createParentDirs the missing parent fails the push, like file.write.
		const refused = await crhs.cluster.pushFile({
			nodeId: node.nodeId,
			path,
			location: await crhs.cluster.stageBytesForPush(content),
			overwrite: true,
			actor: actor(),
		});
		const refusedDone = await node.taskState(refused.id);
		expect(refusedDone).toMatchObject({ state: "failed", errorCode: "not_found" });

		const created = await crhs.cluster.pushFile({
			nodeId: node.nodeId,
			path,
			location: await crhs.cluster.stageBytesForPush(content),
			overwrite: true,
			createParentDirs: true,
			actor: actor(),
		});
		const done = await node.taskState(created.id);
		expect(done).toMatchObject({ state: "exited", exitCode: 0 });
		const read = await node.exec(["/bin/cat", path]);
		expect(read).toMatchObject({ code: 0, stdout: content.toString() });
	}, 60_000);

	it("pulls a node file into the staging location and verifies it", async () => {
		const content = Buffer.from("pulled content\n");
		const path = "/tmp/crh-plane-pull.txt";
		const created = await node.execAs(998, ["/usr/bin/tee", path], { stdin: content.toString() });
		expect(created.code).toBe(0);
		const location = crhs.cluster.stagingLocation();
		const task = await crhs.cluster.pullFile({
			nodeId: node.nodeId,
			path,
			maxBytes: 4096,
			location,
			actor: actor(),
		});
		const done = await node.taskState(task.id);
		expect(done).toMatchObject({ state: "exited", exitCode: 0 });
		expect(done.result).toMatchObject({ kind: "file.pull", size: content.length, sha256: sha256Hex(content) });
		const staged = await readFile(join(transferRoot, location.path));
		expect(staged.length).toBe(content.length);
		expect(sha256Hex(staged)).toBe(sha256Hex(content));
		expect(staged.equals(content)).toBe(true);
	}, 60_000);

	it("fails a pull over max_bytes with too_large and keeps no staging file", async () => {
		const path = "/tmp/crh-plane-too-large.txt";
		const created = await node.execAs(998, ["/bin/sh", "-c", `head -c 2048 /dev/zero > ${path}`]);
		expect(created.code).toBe(0);
		const location = crhs.cluster.stagingLocation();
		const task = await crhs.cluster.pullFile({
			nodeId: node.nodeId,
			path,
			maxBytes: 1024,
			location,
			actor: actor(),
		});
		const done = await node.taskState(task.id);
		expect(done).toMatchObject({ state: "failed", errorCode: "too_large" });
		await expect(readFile(join(transferRoot, location.path))).rejects.toThrow();
	}, 60_000);

	it("fails a push whose bytes do not match the spec and creates no destination", async () => {
		const content = Buffer.from("mismatching content\n");
		const path = "/tmp/crh-plane-mismatch.txt";
		await node.exec(["/bin/rm", "-f", path]);
		const location = await crhs.cluster.stageBytesForPush(content);
		const task = await crhs.cluster.pushFile({
			nodeId: node.nodeId,
			path,
			location: { ...location, sha256: "0".repeat(64) },
			overwrite: true,
			actor: actor(),
		});
		const done = await node.taskState(task.id);
		expect(done.state).toBe("failed");
		expect(done.errorCode).toBe("input_mismatch");
		expect((await node.exec(["/usr/bin/test", "-e", path])).code).not.toBe(0);
	}, 60_000);

	it("copies one staged file to two nodes as one task group and deletes the staging file", async () => {
		const other = await PrivilegedNode.create({ bin, crhs, mode: "ignore", trust: [] });
		try {
			const content = Buffer.from("group copy content\n");
			const path = "/tmp/crh-plane-group-copy.txt";
			const location = await crhs.cluster.stageBytesForPush(content);
			const groupId = await crhs.taskGroups.create({
				targets: [node.nodeId, other.nodeId],
				nodeIds: [node.nodeId, other.nodeId],
				spec: {
					kind: "file.push",
					path,
					size: content.length,
					sha256: Uint8Array.from(Buffer.from(sha256Hex(content), "hex")),
					overwrite: false,
					mode: 0,
					owner: "",
					group: "",
					createParentDirs: false,
					endpoint: { kind: "crhs", transferId: "" },
				},
				transferLocation: location,
				actor: actor(),
			});
			const group = await crhs.taskGroups.wait(groupId, 120_000);
			expect(group?.state).toBe("finished");
			expect(group?.tasks.map((task) => task.state)).toEqual(["exited", "exited"]);
			for (const target of [node, other]) {
				const read = await target.exec(["/bin/cat", path]);
				expect(read.stdout).toBe(content.toString());
				expect(read.code).toBe(0);
			}
			await expect(readFile(join(transferRoot, location.path))).rejects.toThrow();
		} finally {
			await other.destroy();
		}
	}, 180_000);
});
