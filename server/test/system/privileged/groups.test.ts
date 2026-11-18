/**
 * The task-group case of the privileged system suite (doc/design/testing/privileged.md): a task group on two
 * nodes.
 *
 * One user signature covers the tasks of both nodes (one shared payload); a node whose
 * authorization is refused independently retries alone (attempt + 1) and is re-signed alone while
 * the node that already ran is not touched; a group whose only remaining path is a local approval
 * window waits for the window instead of failing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessCrhs, waitFor } from "../../e2e/harness.ts";
import {
	buildStaticCrha,
	PrivilegedNode,
	podmanAvailable,
	publicKeyOf,
	registerSshCredential,
	signPayload,
	sshKeygen,
	submitAuthorization,
	type TrustSpec,
} from "./harness.ts";

const describePodman = describe.skipIf(!podmanAvailable);

const WRONG_NODE_ID = "00000000-0000-7000-8000-000000000000";

describePodman("privileged system: task groups", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let a: PrivilegedNode;
	let b: PrivilegedNode;
	let nameA = "";
	let nameB = "";
	let ownerPublicKey = "";

	const userEntry = (): TrustSpec => ({
		name: "owner",
		role: "user",
		format: "sshsig",
		key: ownerPublicKey,
		kinds: ["execute"],
	});
	const localEntry = (): TrustSpec => ({ name: "local-admins", role: "local", uids: [0], kinds: [] });

	async function group(body: { argv?: string[]; shell?: string }) {
		const command = body.shell !== undefined ? { shell: body.shell } : { argv: body.argv ?? ["id", "-u"] };
		const res = await crhs.api("/api/task-groups", {
			body: {
				targets: [nameA, nameB],
				kind: "exec",
				...command,
				privileged: true,
				// Batch output is status-only by default; text keeps a tail the test can read.
				outputMode: "text",
				waitMs: 1000,
			},
		});
		if (res.status !== 201) throw new Error(`create task group: ${res.status} ${JSON.stringify(res.json)}`);
		return res.json.taskGroup as {
			id: string;
			state: string;
			tasks: { id: string; nodeId: string; state: string; errorCode: string | null; errorMessage: string | null }[];
		};
	}

	const getGroup = async (id: string) => (await crhs.api(`/api/task-groups/${id}/wait?timeoutMs=500`)).json.taskGroup;

	async function groupPayload(
		groupId: string,
	): Promise<{ id: string; payload: string; attempt: number; taskIds: string[]; nodes: string[] }> {
		const res = await crhs.api(`/api/task-groups/${groupId}/authorization`);
		if (res.status !== 200 || !res.json.taskGroup?.authorization) {
			throw new Error(`no task group payload: ${res.status} ${JSON.stringify(res.json)}`);
		}
		const options = res.json.taskGroup.authorization.options as {
			kind: string;
			payload?: { id: string; payload: string; attempt: number; decoded: { taskIds: string[]; nodes: string[] } };
		}[];
		const pending = options.find((option) => option.kind === "sign")?.payload;
		if (!pending) throw new Error(`no sign option: ${JSON.stringify(options)}`);
		return {
			id: pending.id,
			payload: pending.payload,
			attempt: pending.attempt,
			taskIds: pending.decoded.taskIds,
			nodes: pending.decoded.nodes,
		};
	}

	async function signAndSubmit(payload: string): Promise<{ status: number }> {
		const authorization = await signPayload(bin, join(tmp, "owner-key"), payload);
		const res = await submitAuthorization(crhs, authorization);
		// The dispatch continues in the background; the caller waits for the task states.
		await crhs.cluster.drain();
		return { status: res.status };
	}

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-groups-"));
		bin = await buildStaticCrha(tmp);
		crhs = await InProcessCrhs.create();
		await crhs.loginAdmin();
		await sshKeygen(join(tmp, "owner-key"));
		ownerPublicKey = await publicKeyOf(join(tmp, "owner-key"));
		await registerSshCredential(crhs, ownerPublicKey);
		a = await PrivilegedNode.create({ bin, crhs, mode: "forward", trust: [userEntry()] });
		// B starts with a node_id that is not the crhs id: the shared payload addresses B's real id,
		// so crha refuses it while A accepts the same authorization (the deterministic way to make
		// only one node of a group reject a payload).
		b = await PrivilegedNode.create({
			bin,
			crhs,
			mode: "forward",
			trust: [userEntry()],
			privilegedNodeId: WRONG_NODE_ID,
		});
		nameA = (await crhs.api(`/api/nodes/${a.nodeId}`)).json.node.name;
		nameB = (await crhs.api(`/api/nodes/${b.nodeId}`)).json.node.name;
	}, 600_000);

	afterAll(async () => {
		await a?.destroy();
		await b?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("runs both nodes with one user signature and re-signs only the refused node", async () => {
		const g = await group({ shell: "echo run >> /root/crh-group-runs; wc -l < /root/crh-group-runs" });
		await waitFor(
			"the group to wait for one signature",
			async () => (await getGroup(g.id)).state === "awaiting_authorization",
			20_000,
		);
		const shared = await groupPayload(g.id);
		expect(shared.taskIds).toHaveLength(2);
		expect(shared.nodes.sort()).toEqual([a.nodeId, b.nodeId].sort());
		// One signature covers both tasks.
		const submitted = await signAndSubmit(shared.payload);
		expect(submitted.status).toBe(200);
		// A runs; B's crha refuses the payload (step 4: another node) and B retries with attempt + 1.
		const aTaskId = g.tasks.find((t) => t.nodeId === a.nodeId)?.id ?? "";
		const aRow = await waitFor(
			"A to finish",
			async () => {
				const row = await crhs.getTask(aTaskId);
				return row.state === "exited" ? row : undefined;
			},
			30_000,
		);
		expect(aRow.outputTail).toBe("1\n");
		const bTaskId = g.tasks.find((t) => t.nodeId === b.nodeId)?.id ?? "";
		const retried = await waitFor(
			"B to wait for its own signature at attempt 2",
			async () => {
				const row = await crhs.getTask(bTaskId);
				return row.state === "awaiting_authorization" && row.authorization?.attempt === 2 ? row : undefined;
			},
			30_000,
		);
		expect(retried.authorization?.lastRejection?.code).toBe("authorization_invalid");
		// The group payload now covers only B, at attempt 2.
		const onlyB = await groupPayload(g.id);
		expect(onlyB.taskIds).toEqual([bTaskId]);
		expect(onlyB.nodes).toEqual([b.nodeId]);
		expect(onlyB.attempt).toBe(2);
		// Fix B's node id; the digest change refreshes the pending payload and the owner signs only B.
		await b.setTrust([userEntry()], b.nodeId);
		const finalPayload = await waitFor(
			"B's refreshed payload",
			async () => {
				const pending = await groupPayload(g.id);
				return pending.attempt === 2 && pending.id !== retried.authorization?.payloadId ? pending : undefined;
			},
			30_000,
		);
		const second = await signAndSubmit(finalPayload.payload);
		expect(second.status).toBe(200);
		const bRow = await waitFor(
			"B to finish",
			async () => {
				const row = await crhs.getTask(bTaskId);
				return row.state === "exited" ? row : undefined;
			},
			30_000,
		);
		expect(bRow.outputTail).toBe("1\n");
		// A did not run again: its run counter still has one line.
		const aRuns = await a.exec(["/bin/sh", "-c", "wc -l < /root/crh-group-runs"]);
		expect(aRuns.stdout.trim()).toBe("1");
		const finished = await waitFor(
			"the group to finish",
			async () => {
				const value = await getGroup(g.id);
				return value.state === "finished" ? value : undefined;
			},
			30_000,
		);
		expect(finished.tasks.map((t: { state: string }) => t.state)).toEqual(["exited", "exited"]);
	}, 120_000);

	it("runs both nodes from one payload when both accept it", async () => {
		const g = await group({ argv: ["id", "-un"] });
		await waitFor(
			"the group to wait for one signature",
			async () => (await getGroup(g.id)).state === "awaiting_authorization",
			20_000,
		);
		const shared = await groupPayload(g.id);
		expect(shared.taskIds).toHaveLength(2);
		const submitted = await signAndSubmit(shared.payload);
		expect(submitted.status).toBe(200);
		const finished = await waitFor(
			"both tasks to finish",
			async () => {
				const value = await getGroup(g.id);
				return value.state === "finished" ? value : undefined;
			},
			30_000,
		);
		const rows = await Promise.all(finished.tasks.map((t: { id: string }) => crhs.getTask(t.id)));
		for (const row of rows) {
			expect(row.state).toBe("exited");
			expect(row.outputTail).toBe("root\n");
		}
		// Both tasks carry the same one signature/payload.
		expect(rows[0].authorization?.payloadId).toBe(rows[1].authorization?.payloadId);
	}, 90_000);

	it("fails a group that only a local approval window could authorize", async () => {
		await a.setTrust([localEntry()]);
		await b.setTrust([localEntry()], b.nodeId);
		const g = await group({ argv: ["true"] });
		// A task group is never offered a local window, so with no other option its members fail.
		const ended = await waitFor(
			"the group's members to fail",
			async () => {
				const value = (await getGroup(g.id)) as {
					tasks: { state: string; errorCode: string | null }[];
				};
				return value.tasks.length === 2 && value.tasks.every((task) => task.state === "rejected") ? value : undefined;
			},
			20_000,
		);
		for (const task of ended.tasks) expect(task.errorCode).toBe("authorization_required");
	}, 90_000);
});
