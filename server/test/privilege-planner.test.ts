import type { GuardRule, Signature, TaskSpec, TrustEntry, TrustSummary } from "@crh/protocol";
import { decodeAuthorizationPayload } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import type { AuthorizationSigningKey } from "../src/privilege/key.ts";
import { authorizationId, buildAuthorization, specSha256 } from "../src/privilege/payload.ts";
import {
	buildTaskGroupAuthorization,
	CRHS_AUTHORIZATION_TTL_MS,
	type PlannerInput,
	type PlannerTask,
	planAuthorization,
	USER_AUTHORIZATION_TTL_MS,
} from "../src/privilege/planner.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import { createSshKey } from "./helpers/authenticator.ts";

const NODE = "0192f000-0000-7000-8000-000000000001";
const OTHER_NODE = "0192f000-0000-7000-8000-000000000002";
const ALIAS = "0192f000-0000-7000-8000-0000000000a1";
const TASK = "0192f000-0000-7000-8000-000000000001";
const OTHER_TASK = "0192f000-0000-7000-8000-000000000002";
const NOW = 1_793_016_000_000;

const RESTART: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};
const _READ_SHADOW: TaskSpec = { kind: "file.read", path: "/etc/shadow", startLine: 1, lineCount: 100 };

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

/** A crhs signing key without a database. */
function crhsKey(name: string): AuthorizationSigningKey {
	const key = createSshKey("ssh-ed25519");
	return {
		id: name,
		createdAt: "",
		publicKeyBlob: key.blob,
		authorizedKey: key.line,
		fingerprint: key.fingerprint,
		sign: (payload) => signSshsig(key.privateKey, key.blob, payload),
	} as AuthorizationSigningKey;
}

const CRHS_KEY = crhsKey("crhs");
const OWNER_KEY = createSshKey("ssh-ed25519");

function sshEntry(
	name: string,
	role: TrustEntry["role"],
	key: { fingerprint: string; line?: string; authorizedKey?: string },
	overrides: Partial<TrustEntry> = {},
): TrustEntry {
	return {
		name,
		source: "local",
		role,
		key: {
			kind: "sshsig",
			publicKey: "line" in key && key.line !== undefined ? key.line : (key.authorizedKey ?? ""),
			fingerprint: key.fingerprint,
		},
		kinds: ["execute"],
		requireSpec: false,
		requireTask: false,
		requireUv: false,
		maxTtlMs: null,
		allow: [],
		deny: [],
		envAllow: [],
		...overrides,
	};
}

const CRHS = sshEntry("crhs", "crhs", CRHS_KEY, {
	kinds: ["execute", "cosign"],
	requireSpec: true,
	maxTtlMs: 300_000,
	allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
});
const ALICE = sshEntry("alice", "user", OWNER_KEY, { maxTtlMs: 86_400_000, envAllow: ["DEBIAN_FRONTEND"] });
const LOCAL = sshEntry(
	"local-admins",
	"local",
	{ line: "", fingerprint: "" },
	{
		key: { kind: "local", uids: [0, 1000] },
		kinds: [],
	},
);

function summary(nodeId: string, trust: TrustEntry[], aliases: string[] = [ALIAS]): TrustSummary {
	return {
		nodeId,
		aliases,
		clockSkewMs: 60_000,
		identities: IDENTITIES,
		trust,
		localWindow: { kind: "closed" },
	};
}

const OWNER = { sshKeyFingerprints: [OWNER_KEY.fingerprint], webauthnCredentialIds: [] };

function plannerTask(overrides: Partial<PlannerTask> = {}): PlannerTask {
	return {
		id: TASK,
		attempt: 1,
		spec: RESTART,
		node: { id: NODE, name: "app-1", summary: summary(NODE, [CRHS, ALICE, LOCAL]) },
		taskGroup: false,
		online: true,
		...overrides,
	};
}

function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
	return {
		target: { kind: "task", task: plannerTask() },
		owner: OWNER,
		keys: [CRHS_KEY],
		since: NOW - 60_000,
		now: NOW,
		...overrides,
	};
}

function plan(overrides: Partial<PlannerInput> = {}) {
	return planAuthorization(input(overrides));
}

const anyRule = (method: GuardRule["method"] = "exec"): GuardRule => ({ method, match: "any", pattern: "" });

describe("authorization planner", () => {
	it("returns crhs's own signature as usable, with a short-lived exact one-shot payload", async () => {
		const result = await plan();
		expect(result.kind).toBe("usable");
		if (result.kind !== "usable") return;
		const use = result.uses[0];
		if (use?.kind !== "crhs") throw new Error("missing crhs use");
		expect(use.taskId).toBe(TASK);
		expect(use.keyFingerprint).toBe(CRHS_KEY.fingerprint);
		const { payload, bytes, id } = use.authorization;
		expect(payload).toMatchObject({
			v: 1,
			nodes: [NODE],
			command: { kind: "spec", value: specSha256(RESTART) },
			issuedAtMs: NOW,
			deadlineMs: NOW + CRHS_AUTHORIZATION_TTL_MS,
			taskIds: [TASK],
			attempt: 1,
		});
		if (payload.command?.kind !== "spec") throw new Error("not a spec command");
		expect(Buffer.from(payload.command.value).toString("hex")).toBe(Buffer.from(specSha256(RESTART)).toString("hex"));
		expect(Buffer.from(id, "hex").toString("hex")).toBe(Buffer.from(authorizationId(bytes)).toString("hex"));
		expect(decodeAuthorizationPayload(bytes)).toEqual(payload);
	});

	it("bounds the crhs deadline by the entry's max_ttl and defaults to five minutes", async () => {
		const short = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: { id: NODE, name: "app-1", summary: summary(NODE, [{ ...CRHS, maxTtlMs: 60_000 }]) },
				}),
			},
		});
		if (short.kind !== "usable" || short.uses[0]?.kind !== "crhs") throw new Error("missing crhs use");
		expect(short.uses[0].authorization.payload.deadlineMs).toBe(NOW + 60_000);

		const unlimited = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [{ ...CRHS, maxTtlMs: null }]) } }),
			},
		});
		if (unlimited.kind !== "usable" || unlimited.uses[0]?.kind !== "crhs") throw new Error("missing crhs use");
		expect(unlimited.uses[0].authorization.payload.deadlineMs).toBe(NOW + CRHS_AUTHORIZATION_TTL_MS);
	});

	it("offers the owner's user entry as a sign option with a longer deadline", async () => {
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } }),
			},
		});
		expect(result.kind).toBe("options");
		if (result.kind !== "options") return;
		const sign = result.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign") throw new Error("missing sign option");
		expect(sign.entries).toMatchObject([
			{
				credential: { kind: "sshsig", fingerprint: OWNER_KEY.fingerprint },
				cosignRequired: false,
				cosignAvailable: false,
				requireUv: false,
			},
		]);
		expect(sign.authorization.payload).toMatchObject({
			nodes: [NODE],
			taskIds: [TASK],
			attempt: 1,
			deadlineMs: NOW + USER_AUTHORIZATION_TTL_MS,
		});
		expect(sign.ttlMs).toBe(USER_AUTHORIZATION_TTL_MS);
	});

	it("reuses a stored owner authorization that the node accepts, with no options", async () => {
		const built = buildTaskGroupAuthorization({
			nodeIds: [NODE],
			taskIds: [TASK],
			attempt: 1,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 60_000,
		});
		const signature: Signature = {
			kind: "sshsig",
			blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, built.bytes),
		};
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } }),
			},
			stored: [
				{
					id: built.id,
					payload: built.payload,
					payloadBytes: built.bytes,
					signatures: [signature],
					createdAtMs: NOW - 1_000,
				},
			],
		});
		expect(result.kind).toBe("usable");
		if (result.kind !== "usable") return;
		const use = result.uses[0];
		if (use?.kind !== "stored") throw new Error("missing stored use");
		expect(use.taskIds).toEqual([TASK]);
		expect(use.cosignatures).toEqual([]);
	});

	it("adds one crhs cosignature when the accepting entry requires it", async () => {
		const built = buildTaskGroupAuthorization({
			nodeIds: [NODE],
			taskIds: [TASK],
			attempt: 1,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 60_000,
		});
		const signature: Signature = {
			kind: "sshsig",
			blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, built.bytes),
		};
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: {
						id: NODE,
						name: "app-1",
						summary: summary(NODE, [
							sshEntry("alice", "user", OWNER_KEY, { kinds: ["execute", "require-cosign"] }),
							{ ...CRHS, kinds: ["cosign"] },
						]),
					},
				}),
			},
			stored: [
				{
					id: built.id,
					payload: built.payload,
					payloadBytes: built.bytes,
					signatures: [signature],
					createdAtMs: NOW - 1_000,
				},
			],
		});
		if (result.kind !== "usable" || result.uses[0]?.kind !== "stored") throw new Error("missing stored use");
		expect(result.uses[0].cosignatures).toHaveLength(1);
	});

	it("offers a local_window only for a single task whose node has a local entry and trusts an own key", async () => {
		const cosignOnly = { ...CRHS, kinds: ["cosign"] as TrustEntry["kinds"] };
		const closed = { ...summary(NODE, [ALICE, cosignOnly, LOCAL]) };
		const offered = await plan({
			target: { kind: "task", task: plannerTask({ node: { id: NODE, name: "app-1", summary: closed } }) },
		});
		if (offered.kind !== "options") throw new Error("expected options");
		expect(offered.options).toContainEqual({ kind: "local_window", nodeId: NODE, nodeName: "app-1" });
		expect(offered.options.some((option) => option.kind === "sign")).toBe(true);

		// Without one of crhs's keys, opening a window could not authorize anything.
		const noKey = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE, LOCAL]) } }),
			},
			keys: [],
		});
		if (noKey.kind !== "options") throw new Error("expected options");
		expect(noKey.options).not.toContainEqual({ kind: "local_window", nodeId: NODE, nodeName: "app-1" });

		// Groups never get a window.
		const group = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [
						plannerTask({ node: { id: NODE, name: "app-1", summary: closed } }),
						plannerTask({
							id: OTHER_TASK,
							node: { id: OTHER_NODE, name: "app-2", summary: summary(OTHER_NODE, [ALICE, LOCAL]) },
						}),
					],
				},
			},
		});
		if (group.kind !== "options") throw new Error("expected options");
		expect(group.options.some((option) => option.kind === "local_window")).toBe(false);
	});

	it("builds one shared sign payload for a task group", async () => {
		const result = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [
						plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } }),
						plannerTask({
							id: OTHER_TASK,
							attempt: 2,
							node: { id: OTHER_NODE, name: "app-2", summary: summary(OTHER_NODE, [ALICE]) },
						}),
					],
				},
			},
		});
		if (result.kind !== "options") throw new Error("expected options");
		const sign = result.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign") throw new Error("missing sign");
		expect(sign.authorization.payload).toMatchObject({
			nodes: [NODE, OTHER_NODE],
			taskIds: [TASK, OTHER_TASK],
			attempt: 2,
		});
	});

	it("uses crhs per task in a group and leaves the rest for a later round", async () => {
		const result = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [
						plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [CRHS]) } }),
						plannerTask({
							id: OTHER_TASK,
							node: { id: OTHER_NODE, name: "app-2", summary: summary(OTHER_NODE, [ALICE]) },
						}),
					],
				},
			},
		});
		if (result.kind !== "usable") throw new Error("expected usable");
		expect(result.uses).toHaveLength(1);
		expect(result.uses[0]?.kind).toBe("crhs");
	});

	it("plans a mixed group round by round: crhs and a stored authorization now, a sign option for the rest", async () => {
		const nodeB = "0192f000-0000-7000-8000-00000000000b";
		const nodeC = "0192f000-0000-7000-8000-00000000000c";
		const nodeD = "0192f000-0000-7000-8000-00000000000d";
		const taskB = "0192f000-0000-7000-8000-0000000000b1";
		const taskC = "0192f000-0000-7000-8000-0000000000c1";
		const taskD = "0192f000-0000-7000-8000-0000000000d1";
		const groupTask = (id: string, nodeId: string, trust: TrustEntry[]): PlannerTask => ({
			id,
			attempt: 1,
			spec: RESTART,
			node: { id: nodeId, name: nodeId, summary: summary(nodeId, trust) },
			taskGroup: true,
			online: true,
		});
		const storedForB = buildTaskGroupAuthorization({
			nodeIds: [nodeB],
			taskIds: [taskB],
			attempt: 1,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 60_000,
		});
		const stored = {
			id: storedForB.id,
			createdAtMs: NOW - 1_000,
			payload: storedForB.payload,
			payloadBytes: storedForB.bytes,
			signatures: [
				{ kind: "sshsig" as const, blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, storedForB.bytes) },
			],
		};
		const roundOne = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [
						groupTask(TASK, NODE, [CRHS]),
						groupTask(taskB, nodeB, [ALICE]),
						groupTask(taskC, nodeC, [ALICE]),
						groupTask(taskD, nodeD, []),
					],
				},
			},
			stored: [stored],
		});
		if (roundOne.kind !== "usable") throw new Error("expected usable");
		const crhsUse = roundOne.uses.find((use) => use.kind === "crhs");
		if (crhsUse?.kind !== "crhs") throw new Error("missing crhs use");
		expect(crhsUse.taskId).toBe(TASK);
		const storedUse = roundOne.uses.find((use) => use.kind === "stored");
		if (storedUse?.kind !== "stored") throw new Error("missing stored use");
		expect(storedUse.taskIds).toEqual([taskB]);

		// The next round plans only the members that still wait: C can be signed for, D cannot.
		const roundTwo = await plan({
			target: {
				kind: "group",
				group: { spec: RESTART, tasks: [groupTask(taskC, nodeC, [ALICE]), groupTask(taskD, nodeD, [])] },
			},
		});
		if (roundTwo.kind !== "options") throw new Error("expected options");
		const sign = roundTwo.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign") throw new Error("missing sign option");
		expect(sign.authorization.payload.taskIds).toEqual([taskC]);
		expect(roundTwo.options).toHaveLength(1);
		expect(roundTwo.failed).toEqual([{ taskId: taskD, code: "authorization_required" }]);
	});

	it("fails a group whose remaining members have no option at all", async () => {
		const nodeC = "0192f000-0000-7000-8000-00000000000c";
		const nodeD = "0192f000-0000-7000-8000-00000000000d";
		const taskC = "0192f000-0000-7000-8000-0000000000c1";
		const taskD = "0192f000-0000-7000-8000-0000000000d1";
		const result = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [
						{
							id: taskC,
							attempt: 1,
							spec: RESTART,
							node: { id: nodeC, name: "app-c", summary: summary(nodeC, []) },
							taskGroup: true,
							online: true,
						},
						{
							id: taskD,
							attempt: 1,
							spec: RESTART,
							node: { id: nodeD, name: "app-d", summary: summary(nodeD, []) },
							taskGroup: true,
							online: true,
						},
					],
				},
			},
		});
		if (result.kind !== "failure") throw new Error("expected failure");
		expect(result.failures).toEqual([
			{ taskId: taskC, code: "authorization_required" },
			{ taskId: taskD, code: "authorization_required" },
		]);
	});

	it("never offers a local_window to a group, even when every node has a local entry and trusts crhs", async () => {
		const groupTask = (id: string, nodeId: string, trust: TrustEntry[]): PlannerTask => ({
			id,
			attempt: 1,
			spec: RESTART,
			node: { id: nodeId, name: nodeId, summary: summary(nodeId, trust) },
			taskGroup: true,
			online: true,
			crhsRejected: { window: null },
		});
		const tasks = [groupTask(TASK, NODE, [CRHS, LOCAL]), groupTask(OTHER_TASK, OTHER_NODE, [CRHS, LOCAL])];
		// No user entry: a local window is the only thing a single task could use here, and a group never gets one.
		const none = await plan({ target: { kind: "group", group: { spec: RESTART, tasks } } });
		if (none.kind !== "failure") throw new Error("expected failure");
		expect(none.failures.map((failure) => failure.taskId)).toEqual([TASK, OTHER_TASK]);

		// With an owner entry the group gets the shared sign option and still no local_window.
		const signed = await plan({
			target: {
				kind: "group",
				group: {
					spec: RESTART,
					tasks: [groupTask(TASK, NODE, [CRHS, LOCAL, ALICE]), groupTask(OTHER_TASK, OTHER_NODE, [CRHS, LOCAL, ALICE])],
				},
			},
		});
		if (signed.kind !== "options") throw new Error("expected options");
		expect(signed.options.map((option) => option.kind)).toEqual(["sign"]);
		const sign = signed.options[0];
		if (sign?.kind !== "sign") throw new Error("missing sign option");
		expect(sign.authorization.payload.taskIds).toEqual([TASK, OTHER_TASK]);
	});

	it("only uses a crhs trust entry for crhs's own signing keys", async () => {
		const FOREIGN_KEY = createSshKey("ssh-ed25519");
		const foreign = sshEntry("other-crhs", "crhs", FOREIGN_KEY);
		const own = sshEntry("crhs", "crhs", CRHS_KEY, { requireSpec: true, maxTtlMs: 300_000, allow: [anyRule()] });
		const ownKey = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [foreign, own]) } }),
			},
		});
		if (ownKey.kind !== "usable" || ownKey.uses[0]?.kind !== "crhs") throw new Error("missing crhs use");
		expect(ownKey.uses[0].keyFingerprint).toBe(CRHS_KEY.fingerprint);

		const foreignOnly = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [foreign]) } }),
			},
		});
		expect(foreignOnly.kind).toBe("failure");
	});

	it("uses the newest key the node trusts and skips a node that trusts none", async () => {
		const newer = crhsKey("crhs-new");
		const older = sshEntry("crhs-old", "crhs", CRHS_KEY, { requireSpec: true, maxTtlMs: 300_000, allow: [anyRule()] });
		const newest = sshEntry("crhs-new", "crhs", newer, { requireSpec: true, maxTtlMs: 300_000, allow: [anyRule()] });
		const both = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [older, newest]) } }),
			},
			keys: [newer, CRHS_KEY],
		});
		if (both.kind !== "usable" || both.uses[0]?.kind !== "crhs") throw new Error("missing crhs use");
		expect(both.uses[0].keyFingerprint).toBe(newer.fingerprint);

		const none = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } }),
			},
			keys: [newer, CRHS_KEY],
		});
		expect(none.kind).toBe("options");
	});

	it("does not retry a crhs path a rejection ruled out under the same window, only under another one", async () => {
		const tried = await plan({
			target: { kind: "task", task: plannerTask({ crhsRejected: { window: null } }) },
		});
		expect(tried.kind).toBe("options");
		if (tried.kind !== "options") return;
		expect(tried.options.some((option) => option.kind === "sign")).toBe(true);

		// The window's times are the node's: they are only an identity, never compared with crhs's clock.
		const windowAt = (openedAtMs: number): TrustSummary => ({
			...summary(NODE, [CRHS]),
			localWindow: { kind: "open", openedAtMs, openedByUid: 1000, untilMs: openedAtMs + 1_800_000 },
		});
		const sameWindow = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					crhsRejected: { window: NOW + 3_600_000 },
					node: { id: NODE, name: "app-1", summary: windowAt(NOW + 3_600_000) },
				}),
			},
		});
		expect(sameWindow.kind).not.toBe("usable");

		const otherWindow = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					crhsRejected: { window: NOW + 3_600_000 },
					node: { id: NODE, name: "app-1", summary: windowAt(NOW + 7_200_000) },
				}),
			},
		});
		expect(otherWindow.kind).toBe("usable");

		// A window whose end the node reports in crhs's past still counts until the node says it closed.
		const reportedOver = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: windowAt(NOW - 7_200_000) } }),
			},
		});
		expect(reportedOver.kind).toBe("usable");
	});

	it("takes the crhs path through an open window regardless of the entry's limits", async () => {
		const closed: TrustSummary = {
			...summary(NODE, [{ ...CRHS, deny: [anyRule()] }]),
		};
		const closedPlan = await plan({
			target: { kind: "task", task: plannerTask({ node: { id: NODE, name: "app-1", summary: closed } }) },
		});
		expect(closedPlan.kind).not.toBe("usable");
		for (const entry of [
			{ ...CRHS, deny: [anyRule()] },
			{ ...CRHS, kinds: ["cosign" as const] },
			{ ...CRHS, maxTtlMs: 1 },
			{ ...CRHS, requireSpec: false },
		]) {
			const open: TrustSummary = {
				...summary(NODE, [entry]),
				localWindow: { kind: "open", openedAtMs: NOW - 60_000, openedByUid: 1000, untilMs: NOW + 1_800_000 },
			};
			const result = await plan({
				target: { kind: "task", task: plannerTask({ node: { id: NODE, name: "app-1", summary: open } }) },
			});
			expect(result.kind).toBe("usable");
		}
	});

	it("fails with no option when nobody can authorize the command", async () => {
		const result = await plan({
			target: { kind: "task", task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, []) } }) },
		});
		expect(result).toEqual({ kind: "failure", failures: [{ taskId: TASK, code: "authorization_required" }] });
	});

	it("refuses a sign option whose required cosignature no node key can provide", async () => {
		const requiring = sshEntry("alice", "user", OWNER_KEY, { kinds: ["execute", "require-cosign"] });
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [requiring]) } }),
			},
		});
		expect(result.kind).toBe("failure");
	});

	it("reports a missing alias instead of parking a task for a signature", async () => {
		const group = { id: "0192f000-0000-7000-8000-0000000000a2", name: "web" };
		// A reusable authorization: no task ids.
		const reusable = buildAuthorization({
			nodes: [group.id],
			command: { specSha256: specSha256(RESTART) },
			issuedAtMs: NOW,
			deadlineMs: NOW + 60_000,
			taskIds: null,
		});
		const signature: Signature = {
			kind: "sshsig",
			blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, reusable.bytes),
		};
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: {
						id: NODE,
						name: "app-1",
						summary: summary(NODE, [ALICE]),
						groups: [group],
					},
				}),
			},
			stored: [
				{
					id: reusable.id,
					payload: reusable.payload,
					payloadBytes: reusable.bytes,
					signatures: [signature],
					createdAtMs: NOW - 1_000,
				},
			],
		});
		expect(result).toEqual({
			kind: "failure",
			failures: [{ taskId: TASK, code: "alias_missing", groupId: group.id, groupName: group.name }],
		});
	});

	it("ignores a stored authorization no newer than the one the node rejected", async () => {
		const built = buildTaskGroupAuthorization({
			nodeIds: [NODE],
			taskIds: [TASK],
			attempt: 1,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 60_000,
		});
		const signature: Signature = {
			kind: "sshsig",
			blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, built.bytes),
		};
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) },
					// crha rejected an authorization stored at this time: nothing stored up to it is used again.
					rejectedBefore: NOW - 1_000,
				}),
			},
			stored: [
				{
					id: built.id,
					payload: built.payload,
					payloadBytes: built.bytes,
					signatures: [signature],
					createdAtMs: NOW - 1_000,
				},
			],
		});
		expect(result.kind).toBe("options");
	});

	it("offers a sign option for an entry whose max_ttl is shorter than the default lifetime", async () => {
		const shortLived = { ...ALICE, maxTtlMs: 600_000 };
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [shortLived]) } }),
			},
		});
		if (result.kind !== "options") throw new Error("expected options");
		const sign = result.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign") throw new Error("missing sign option");
		expect(sign.ttlMs).toBe(600_000);
		expect(sign.authorization.payload.deadlineMs).toBe(NOW + 600_000);
	});

	it("treats a user entry whose max_ttl is under a minute as absent", async () => {
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: { id: NODE, name: "app-1", summary: summary(NODE, [{ ...ALICE, maxTtlMs: 59_000 }]) },
				}),
			},
		});
		expect(result).toEqual({ kind: "failure", failures: [{ taskId: TASK, code: "authorization_required" }] });
	});

	it("never plans a task on an absent node as usable, and does not keep it waiting for crhs", async () => {
		// The owner can still sign: the task waits with its sign option.
		const signable = await plan({ target: { kind: "task", task: plannerTask({ online: false }) } });
		expect(signable.kind).toBe("options");

		// Only crhs could sign it once the node is back: it fails node_offline at once.
		const crhsOnly = await plan({
			target: {
				kind: "task",
				task: plannerTask({ online: false, node: { id: NODE, name: "app-1", summary: summary(NODE, [CRHS]) } }),
			},
		});
		expect(crhsOnly).toEqual({ kind: "failure", failures: [{ taskId: TASK, code: "node_offline" }] });
		const online = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [CRHS]) } }),
			},
		});
		expect(online.kind).toBe("usable");

		// The owner already signed: it waits for its node, asking nothing more.
		const built = buildAuthorization({
			nodes: [NODE],
			command: { specSha256: specSha256(RESTART) },
			issuedAtMs: NOW,
			deadlineMs: NOW + 60_000,
			taskIds: [TASK],
			attempt: 1,
		});
		const signature: Signature = {
			kind: "sshsig",
			blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, built.bytes),
		};
		const signed = await plan({
			target: {
				kind: "task",
				task: plannerTask({ online: false, node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } }),
			},
			stored: [
				{ id: built.id, createdAtMs: NOW, payload: built.payload, payloadBytes: built.bytes, signatures: [signature] },
			],
		});
		expect(signed).toEqual({ kind: "options", options: [], failed: [], awaitingNode: [TASK] });
	});

	it("asks for no third signature once two given since the unit was created address it", async () => {
		const signed = (issuedAtMs: number, createdAtMs: number) => {
			const built = buildAuthorization({
				nodes: [NODE],
				command: { specSha256: specSha256(RESTART) },
				issuedAtMs,
				deadlineMs: issuedAtMs + 60_000,
				taskIds: [TASK],
				attempt: 1,
			});
			const signature: Signature = {
				kind: "sshsig",
				blob: signSshsig(OWNER_KEY.privateKey, OWNER_KEY.blob, built.bytes),
			};
			return { id: built.id, createdAtMs, payload: built.payload, payloadBytes: built.bytes, signatures: [signature] };
		};
		const task = plannerTask({
			node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) },
			// Both were sent and refused: the threshold rules them out as uses, but they still count.
			rejectedBefore: NOW,
		});
		const one = await plan({ target: { kind: "task", task }, stored: [signed(NOW - 2_000, NOW - 2_000)] });
		expect(one.kind).toBe("options");
		const two = await plan({
			target: { kind: "task", task },
			stored: [signed(NOW - 2_000, NOW - 2_000), signed(NOW - 1_000, NOW - 1_000)],
		});
		expect(two).toEqual({ kind: "failure", failures: [{ taskId: TASK, code: "authorization_required" }] });
		// One stored before the unit existed does not count.
		const before = await plan({
			target: { kind: "task", task },
			stored: [signed(NOW - 120_000, NOW - 120_000), signed(NOW - 1_000, NOW - 1_000)],
		});
		expect(before.kind).toBe("options");
	});

	it("keeps the payload the unit offers while it still asks for the same thing", async () => {
		const task = plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [ALICE]) } });
		const first = await plan({ target: { kind: "task", task } });
		if (first.kind !== "options" || first.options[0]?.kind !== "sign") throw new Error("expected a sign option");
		const current = first.options[0].authorization;

		const later = await plan({ target: { kind: "task", task }, current, now: NOW + 60_000 });
		if (later.kind !== "options" || later.options[0]?.kind !== "sign") throw new Error("expected a sign option");
		expect(later.options[0].authorization.id).toBe(current.id);

		// Another attempt asks for something else.
		const next = await plan({ target: { kind: "task", task: { ...task, attempt: 2 } }, current, now: NOW + 60_000 });
		if (next.kind !== "options" || next.options[0]?.kind !== "sign") throw new Error("expected a sign option");
		expect(next.options[0].authorization.id).not.toBe(current.id);

		// A payload due for its refresh is replaced.
		const due = await plan({ target: { kind: "task", task }, current, now: NOW + USER_AUTHORIZATION_TTL_MS - 30_000 });
		if (due.kind !== "options" || due.options[0]?.kind !== "sign") throw new Error("expected a sign option");
		expect(due.options[0].authorization.id).not.toBe(current.id);
	});

	it("carries the note into the payload", async () => {
		const result = await plan({ note: "restart nginx to load the new certificate" });
		if (result.kind !== "usable" || result.uses[0]?.kind !== "crhs") throw new Error("missing crhs use");
		expect(result.uses[0].authorization.payload.note).toBe("restart nginx to load the new certificate");
	});

	it("turns an invalid privileged target into a failure", async () => {
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ spec: { kind: "file.stat", path: "etc/shadow" } }),
			},
		});
		expect(result.kind).toBe("failure");
	});

	it("judges a repeated key only by its first trust entry, as crha does", async () => {
		const readOnly = { ...ALICE, allow: [anyRule("file.read")] };
		const repeated = { ...ALICE, name: "alice-again" };
		const denied = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [readOnly, repeated]) } }),
			},
		});
		expect(denied.kind).toBe("failure");
		const allowed = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [repeated, readOnly]) } }),
			},
		});
		expect(allowed.kind).toBe("options");
	});

	it("accepts a WebAuthn credential for require_uv and refuses a plain SSH key", async () => {
		const credentialId = new Uint8Array(32).fill(7);
		const passkey = sshEntry("alice-passkey", "user", OWNER_KEY, {
			key: {
				kind: "webauthn",
				credentialId,
				coseKey: new Uint8Array([1]),
				rpId: "crh.example.com",
				origins: ["https://crh.example.com"],
			},
			requireUv: true,
		});
		const owner = { sshKeyFingerprints: [], webauthnCredentialIds: [Buffer.from(credentialId).toString("base64url")] };
		const result = await plan({
			target: {
				kind: "task",
				task: plannerTask({ node: { id: NODE, name: "app-1", summary: summary(NODE, [passkey]) } }),
			},
			owner,
		});
		if (result.kind !== "options") throw new Error("expected options");
		const sign = result.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign") throw new Error("missing sign");
		expect(sign.entries[0]).toMatchObject({ requireUv: true, canAssertUv: true });
		expect(sign.entries[0]?.credential).toEqual({
			kind: "webauthn",
			credentialId: Buffer.from(credentialId).toString("base64url"),
		});

		const plain = await plan({
			target: {
				kind: "task",
				task: plannerTask({
					node: { id: NODE, name: "app-1", summary: summary(NODE, [{ ...ALICE, requireUv: true }]) },
				}),
			},
		});
		expect(plain.kind).toBe("failure");
	});
});

describe("task group authorization payload", () => {
	it("covers every node and task with one payload and a shared attempt", () => {
		const built = buildTaskGroupAuthorization({
			nodeIds: [NODE, OTHER_NODE],
			taskIds: [TASK, OTHER_TASK],
			attempt: 2,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 3_600_000,
			note: "batch restart",
		});
		expect(built.payload).toMatchObject({
			nodes: [NODE, OTHER_NODE],
			taskIds: [TASK, OTHER_TASK],
			attempt: 2,
			issuedAtMs: NOW,
			deadlineMs: NOW + 3_600_000,
			note: "batch restart",
			command: { kind: "spec", value: specSha256(RESTART) },
		});
		expect(decodeAuthorizationPayload(built.bytes)).toEqual(built.payload);
	});

	it("refuses a payload whose nodes and task ids do not line up", () => {
		expect(() =>
			buildTaskGroupAuthorization({
				nodeIds: [NODE, OTHER_NODE],
				taskIds: [TASK],
				attempt: 1,
				spec: RESTART,
				issuedAtMs: NOW,
				ttlMs: 60_000,
			}),
		).toThrow(/one node per task id/);
		expect(() =>
			buildTaskGroupAuthorization({
				nodeIds: ["group:web"],
				taskIds: [TASK],
				attempt: 1,
				spec: RESTART,
				issuedAtMs: NOW,
				ttlMs: 60_000,
			}),
		).toThrow(/node ids/);
	});
});
