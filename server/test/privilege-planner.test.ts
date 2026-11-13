import type { GuardRule, TaskSpec, TrustEntry, TrustSummary } from "@crh/protocol";
import { decodeAuthorizationPayload, encodeAuthorizationPayload } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import { authorizationId, specSha256 } from "../src/privilege/payload.ts";
import {
	buildTaskGroupAuthorization,
	CRHS_AUTHORIZATION_TTL_MS,
	planAuthorization,
	USER_AUTHORIZATION_TTL_MS,
} from "../src/privilege/planner.ts";

const NODE = "0192f000-0000-7000-8000-000000000001";
const OTHER_NODE = "0192f000-0000-7000-8000-000000000002";
const ALIAS = "0192f000-0000-7000-8000-0000000000a1";
const TASK = "0192f000-0000-7000-8000-000000000001";
const NOW = 1_793_016_000_000;

const RESTART: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};
const READ_SHADOW: TaskSpec = { kind: "file.read", path: "/etc/shadow", startLine: 1, lineCount: 100 };

const push = (transferId: string, size = 5): TaskSpec => ({
	kind: "file.push",
	path: "/srv/copy.bin",
	size,
	sha256: new Uint8Array(32).fill(7),
	overwrite: false,
	mode: 0o644,
	owner: "",
	group: "",
	createParentDirs: false,
	endpoint: { kind: "crhs", transferId },
});

describe("spec hash", () => {
	it("leaves a transfer endpoint out, so copy-group members hash like their group", () => {
		expect(Buffer.from(specSha256(push("member-a")))).toEqual(Buffer.from(specSha256(push("member-b"))));
		expect(Buffer.from(specSha256(push("member-a", 6)))).not.toEqual(Buffer.from(specSha256(push("member-a"))));
	});

	it("binds createParentDirs into a file.push spec", () => {
		const spec = push("member-a") as Extract<TaskSpec, { kind: "file.push" }>;
		const withDirs: TaskSpec = { ...spec, createParentDirs: true };
		expect(Buffer.from(specSha256(withDirs))).not.toEqual(Buffer.from(specSha256(spec)));
	});
});

const KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZzY2tleQ== generated";
const SK_KEY_LINE = "sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAIHNrY3Jocw== generated";

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

function sshEntry(name: string, role: TrustEntry["role"], overrides: Partial<TrustEntry> = {}): TrustEntry {
	return {
		name,
		source: "local",
		role,
		key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: `SHA256:${name}` },
		kinds: ["execute"],
		requireExact: false,
		requireTask: false,
		requireUv: false,
		maxTtlMs: null,
		allow: [],
		deny: [],
		envAllow: [],
		...overrides,
	};
}

const CRHS = sshEntry("crhs", "crhs", {
	kinds: ["execute", "cosign"],
	requireExact: true,
	maxTtlMs: 300_000,
	allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
});
const ALICE = sshEntry("alice", "user", { maxTtlMs: 86_400_000, envAllow: ["DEBIAN_FRONTEND"] });
const LOCAL = sshEntry("local-admins", "local", {
	key: { kind: "local", uids: [0, 1000] },
});

function summary(trust: TrustEntry[]): TrustSummary {
	return { nodeId: NODE, aliases: [ALIAS], clockSkewMs: 60_000, identities: IDENTITIES, trust };
}

const OWNER = { sshKeyFingerprints: ["SHA256:alice"], webauthnCredentialIds: [] };

function plan(overrides: Partial<Parameters<typeof planAuthorization>[0]> = {}) {
	return planAuthorization({
		summary: summary([CRHS, ALICE, LOCAL]),
		nodeId: NODE,
		aliases: [ALIAS],
		task: { id: TASK, attempt: 1, spec: RESTART, privileged: true },
		taskGroup: false,
		owner: OWNER,
		now: NOW,
		...overrides,
	});
}

const anyRule = (method: GuardRule["method"] = "exec"): GuardRule => ({ method, match: "any", pattern: "" });

describe("authorization planner", () => {
	it("prefers the crhs path and builds a short-lived exact one-shot payload", () => {
		const result = plan();
		const paths = result.paths.map((path) => path.path);
		expect(paths).toEqual(["crhs", "user", "local"]);
		const crhs = result.paths[0];
		if (crhs?.path !== "crhs") throw new Error("missing crhs path");
		expect(crhs.entry.name).toBe("crhs");
		const { payload, bytes, id } = crhs.authorization;
		expect(payload).toMatchObject({
			v: 1,
			nodes: [NODE],
			command: { method: "exec", match: { kind: "exact", target: "systemctl restart nginx" } },
			issuedAtMs: NOW,
			deadlineMs: NOW + CRHS_AUTHORIZATION_TTL_MS,
			taskIds: [TASK],
			attempt: 1,
		});
		if (payload.command?.match.kind !== "exact") throw new Error("not an exact command");
		expect(Buffer.from(payload.command.match.specSha256).toString("hex")).toBe(
			Buffer.from(specSha256(RESTART)).toString("hex"),
		);
		expect(Buffer.from(id, "hex").toString("hex")).toBe(Buffer.from(authorizationId(bytes)).toString("hex"));
		expect(decodeAuthorizationPayload(bytes)).toEqual(payload);
		expect(encodeAuthorizationPayload(payload)).toEqual(bytes);
	});

	it("bounds the crhs deadline by the entry's max_ttl and defaults to five minutes", () => {
		const short = plan({ summary: summary([{ ...CRHS, maxTtlMs: 60_000 }]) });
		const shortPath = short.paths.find((path) => path.path === "crhs");
		if (shortPath?.path !== "crhs") throw new Error("missing crhs path");
		expect(shortPath.authorization.payload.deadlineMs).toBe(NOW + 60_000);

		const unlimited = plan({ summary: summary([{ ...CRHS, maxTtlMs: null }]) });
		const unlimitedPath = unlimited.paths.find((path) => path.path === "crhs");
		if (unlimitedPath?.path !== "crhs") throw new Error("missing crhs path");
		expect(unlimitedPath.authorization.payload.deadlineMs).toBe(NOW + CRHS_AUTHORIZATION_TTL_MS);
	});

	it("lists the owner's user entry and uses a longer user deadline", () => {
		const result = plan({ tried: ["crhs"] });
		expect(result.paths.map((path) => path.path)).toEqual(["user", "local"]);
		const user = result.paths[0];
		if (user?.path !== "user") throw new Error("missing user path");
		expect(user.entries).toMatchObject([
			{
				credential: { kind: "sshsig", fingerprint: "SHA256:alice" },
				cosignRequired: false,
				cosignAvailable: true,
				requireUv: false,
			},
		]);
		expect(user.authorization.payload).toMatchObject({
			nodes: [NODE],
			taskIds: [TASK],
			attempt: 1,
			deadlineMs: NOW + USER_AUTHORIZATION_TTL_MS,
		});
	});

	it("only uses a crhs trust entry for crhs's own signing keys", () => {
		const foreign = sshEntry("other-crhs", "crhs", {
			kinds: ["execute", "cosign"],
			requireExact: true,
			maxTtlMs: 300_000,
			allow: [anyRule()],
			key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: "SHA256:other" },
		});
		const own = sshEntry("crhs", "crhs", { requireExact: true, maxTtlMs: 300_000, allow: [anyRule()] });
		// Without resolved fingerprints the planner cannot rule anything out, so the summary's first entry wins.
		const unprefixed = plan({ summary: summary([foreign, own]) });
		const unprefixedCrhs = unprefixed.paths[0];
		if (unprefixedCrhs?.path !== "crhs") throw new Error("missing crhs path");
		expect(unprefixedCrhs.entry.name).toBe("other-crhs");
		expect(unprefixedCrhs.keyFingerprint).toBe("SHA256:other");

		const ownKey = plan({ summary: summary([foreign, own]), crhsFingerprints: ["SHA256:crhs"] });
		const ownCrhs = ownKey.paths[0];
		if (ownCrhs?.path !== "crhs") throw new Error("missing crhs path");
		expect(ownCrhs.entry.name).toBe("crhs");
		expect(ownCrhs.keyFingerprint).toBe("SHA256:crhs");

		const foreignOnly = plan({ summary: summary([foreign]), crhsFingerprints: ["SHA256:crhs"] });
		expect(foreignOnly.paths).toEqual([]);
	});

	it("uses the newest key the node trusts and skips a node that trusts none", () => {
		const older = sshEntry("crhs-old", "crhs", {
			requireExact: true,
			maxTtlMs: 300_000,
			allow: [anyRule()],
			key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: "SHA256:old" },
		});
		const newest = sshEntry("crhs-new", "crhs", {
			requireExact: true,
			maxTtlMs: 300_000,
			allow: [anyRule()],
			key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: "SHA256:new" },
		});
		const fingerprints = ["SHA256:new", "SHA256:old"];

		const both = plan({ summary: summary([older, newest]), crhsFingerprints: fingerprints });
		const bothCrhs = both.paths[0];
		if (bothCrhs?.path !== "crhs") throw new Error("missing crhs path");
		expect(bothCrhs.entry.name).toBe("crhs-new");
		expect(bothCrhs.keyFingerprint).toBe("SHA256:new");

		// A node that still trusts only the older key gets that key, not the newest one.
		const onlyOlder = plan({ summary: summary([older]), crhsFingerprints: fingerprints });
		const olderPath = onlyOlder.paths[0];
		if (olderPath?.path !== "crhs") throw new Error("missing crhs path");
		expect(olderPath.entry.name).toBe("crhs-old");
		expect(olderPath.keyFingerprint).toBe("SHA256:old");

		// A node that trusts none of crhs's keys falls back to the owner's user path.
		const none = plan({ summary: summary([ALICE, LOCAL]), crhsFingerprints: fingerprints });
		expect(none.paths.map((path) => path.path)).toEqual(["user", "local"]);
	});

	it("cosigns with the newest key the node trusts for cosign, not one that only executes", () => {
		const newestExecuteOnly = sshEntry("crhs-new", "crhs", {
			kinds: ["execute"],
			key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: "SHA256:new" },
		});
		const olderCosign = sshEntry("crhs-old", "crhs", {
			kinds: ["cosign"],
			key: { kind: "sshsig", publicKey: KEY_LINE, fingerprint: "SHA256:old" },
		});
		const requiring = { ...ALICE, kinds: ["execute", "require-cosign"] as TrustEntry["kinds"] };
		const withCosign = plan({
			summary: summary([newestExecuteOnly, requiring, olderCosign]),
			crhsFingerprints: ["SHA256:new", "SHA256:old"],
			tried: ["crhs"],
		});
		const user = withCosign.paths[0];
		if (user?.path !== "user") throw new Error("missing user path");
		expect(user.entries[0]).toMatchObject({ cosignRequired: true, cosignAvailable: true });

		const withoutCosign = plan({
			summary: summary([newestExecuteOnly, requiring]),
			crhsFingerprints: ["SHA256:new", "SHA256:old"],
			tried: ["crhs"],
		});
		expect(withoutCosign.paths).toEqual([]);
		expect(withoutCosign.reason).toMatch(/cosignature/);
	});

	it("notes a required crhs cosignature and whether the node can provide one", () => {
		const cosignOnly = sshEntry("crhs", "crhs", { kinds: ["cosign"] });
		const requiring = { ...ALICE, kinds: ["execute", "require-cosign"] as TrustEntry["kinds"] };
		const withCosign = plan({ summary: summary([cosignOnly, requiring, LOCAL]) });
		expect(withCosign.paths.map((path) => path.path)).toEqual(["user", "local"]);
		const user = withCosign.paths[0];
		if (user?.path !== "user") throw new Error("missing user path");
		expect(user.entries[0]).toMatchObject({ cosignRequired: true, cosignAvailable: true });

		const withoutCosign = plan({ summary: summary([requiring]) });
		expect(withoutCosign.paths).toEqual([]);
		expect(withoutCosign.reason).toMatch(/no one on this node can authorize this command/);
		expect(withoutCosign.reason).toMatch(/cosign/);
	});

	it("accepts a WebAuthn credential id but not a plain SSH key for require_uv", () => {
		const credentialId = new Uint8Array(32).fill(7);
		const passkey = sshEntry("alice-passkey", "user", {
			key: {
				kind: "webauthn",
				credentialId,
				coseKey: new Uint8Array([1]),
				rpId: "crh.example.com",
				origins: ["https://crh.example.com"],
			},
			requireUv: true,
		});
		const owner = {
			sshKeyFingerprints: [],
			webauthnCredentialIds: [Buffer.from(credentialId).toString("base64url")],
		};
		const result = plan({ summary: summary([passkey]), owner });
		const user = result.paths[0];
		if (user?.path !== "user") throw new Error("missing user path");
		expect(user.entries[0]).toMatchObject({ requireUv: true, canAssertUv: true });
		expect(user.entries[0]?.credential).toEqual({
			kind: "webauthn",
			credentialId: Buffer.from(credentialId).toString("base64url"),
		});

		const plainSshWithUv = plan({ summary: summary([{ ...ALICE, requireUv: true }]) });
		expect(plainSshWithUv.paths).toEqual([]);
		expect(plainSshWithUv.reason).toMatch(/no one on this node can authorize this command/);

		const sk = plan({
			summary: summary([
				{ ...ALICE, key: { kind: "sshsig", publicKey: SK_KEY_LINE, fingerprint: "SHA256:alice" }, requireUv: true },
			]),
		});
		const skUser = sk.paths[0];
		if (skUser?.path !== "user") throw new Error("missing sk user path");
		expect(skUser.entries[0]).toMatchObject({ requireUv: true, canAssertUv: true });
	});

	it("excludes tried paths, so a rejected crhs signature is not retried", () => {
		expect(plan({ tried: ["crhs"] }).paths.map((path) => path.path)).toEqual(["user", "local"]);
		expect(plan({ tried: ["crhs", "user"] }).paths.map((path) => path.path)).toEqual(["local"]);
		const exhausted = plan({ tried: ["crhs", "user", "local"] });
		expect(exhausted.paths).toEqual([]);
		expect(exhausted.reason).toMatch(/no one on this node can authorize this command/);
		expect(exhausted.reason).toMatch(/crhs authorization path was already rejected/);
	});

	it("offers user and local together, and neither for a task group", () => {
		const both = plan({ tried: ["crhs"] });
		expect(both.paths.map((path) => path.path)).toEqual(["user", "local"]);
		const group = plan({ tried: ["crhs"], taskGroup: true });
		expect(group.paths.map((path) => path.path)).toEqual(["user"]);
		expect(group.paths[0]).toMatchObject({ path: "user", taskGroup: true });
		const groupLocalOnly = plan({ summary: summary([LOCAL]), taskGroup: true });
		expect(groupLocalOnly.paths).toEqual([]);
		expect(groupLocalOnly.reason).toMatch(/no one on this node can authorize this command/);
		expect(groupLocalOnly.reason).toMatch(/task group/);
	});

	it("returns none with a reason when the TrustSummary is unavailable", () => {
		const result = plan({ summary: null, summaryUnavailable: "privileged mode is not running" });
		expect(result.paths).toEqual([]);
		expect(result.reason).toBe("no one on this node can authorize this command: privileged mode is not running");
	});

	it("returns none for a non-privileged task", () => {
		const result = plan({ task: { id: TASK, attempt: 1, spec: RESTART, privileged: false } });
		expect(result.paths).toEqual([]);
		expect(result.reason).toMatch(/not privileged/);
	});

	it("ignores a crhs entry whose guard rules reject the command", () => {
		const readOnly = { ...CRHS, allow: [{ method: "file.read", match: "any", pattern: "" } as GuardRule] };
		const result = plan({ summary: summary([readOnly]) });
		expect(result.paths).toEqual([]);
		expect(result.reason).toMatch(/no one on this node can authorize this command/);
	});

	it("judges a repeated key only by its first trust entry, as crha does", () => {
		const readOnly = { ...ALICE, allow: [{ method: "file.read", match: "any", pattern: "" } as GuardRule] };
		const repeated = { ...ALICE, name: "alice-again" };
		const result = plan({ summary: summary([readOnly, repeated]) });
		expect(result.paths).toEqual([]);
		expect(plan({ summary: summary([repeated, readOnly]) }).paths.map((path) => path.path)).toEqual(["user"]);
	});

	it("rejects an invalid privileged target before planning anything", () => {
		const result = plan({
			task: { id: TASK, attempt: 1, spec: { kind: "file.stat", path: "etc/shadow" }, privileged: true },
		});
		expect(result.paths).toEqual([]);
		expect(result.reason).toMatch(/not absolute/);
	});

	it("accepts only entries that satisfy the whole decision", () => {
		const denied = plan({
			task: { id: TASK, attempt: 1, spec: READ_SHADOW, privileged: true },
			summary: summary([
				{ ...ALICE, deny: [anyRule("file.read")] },
				{ ...CRHS, allow: [anyRule("file.read")] },
			]),
		});
		// The crhs entry allows the read but alice denies it.
		expect(denied.paths.map((path) => path.path)).toEqual(["crhs"]);

		// An environment the owner's entry does not allow makes the user path fail step 7.
		const envTask: TaskSpec = { ...RESTART, env: { DEBIAN_FRONTEND: "noninteractive" } } as TaskSpec;
		const envDenied = plan({
			summary: summary([{ ...ALICE, envAllow: [] }]),
			tried: ["crhs"],
			task: { id: TASK, attempt: 1, spec: envTask, privileged: true },
		});
		expect(envDenied.paths).toEqual([]);
	});

	it("carries the note into the payload", () => {
		const result = plan({ note: "restart nginx to load the new certificate" });
		const crhs = result.paths[0];
		if (crhs?.path !== "crhs") throw new Error("missing crhs path");
		expect(crhs.authorization.payload.note).toBe("restart nginx to load the new certificate");
	});
});

describe("task group authorization", () => {
	it("covers every node and task with one payload and a shared attempt", () => {
		const nodes = [NODE, OTHER_NODE];
		const tasks = [TASK, "0192f000-0000-7000-8000-000000000002"];
		const built = buildTaskGroupAuthorization({
			nodeIds: nodes,
			taskIds: tasks,
			attempt: 2,
			spec: RESTART,
			issuedAtMs: NOW,
			ttlMs: 3_600_000,
			note: "batch restart",
		});
		expect(built.payload).toMatchObject({
			nodes,
			taskIds: tasks,
			attempt: 2,
			issuedAtMs: NOW,
			deadlineMs: NOW + 3_600_000,
			note: "batch restart",
			command: { method: "exec", match: { kind: "exact", target: "systemctl restart nginx" } },
		});
		expect(decodeAuthorizationPayload(built.bytes)).toEqual(built.payload);
	});

	it("refuses a payload whose nodes and task ids do not line up", () => {
		// One node per task id, by position (doc/design/protocol.md "Authorization object"): a payload that violates the
		// binding would only be refused by the node later, so the builder fails closed.
		expect(() =>
			buildTaskGroupAuthorization({
				nodeIds: [NODE, OTHER_NODE],
				taskIds: [TASK],
				attempt: 1,
				spec: RESTART,
			}),
		).toThrow(/one node per task id/);
		expect(() =>
			buildTaskGroupAuthorization({ nodeIds: ["group:web"], taskIds: [TASK], attempt: 1, spec: RESTART }),
		).toThrow(/node ids/);
		expect(() => buildTaskGroupAuthorization({ nodeIds: ["*"], taskIds: [TASK], attempt: 1, spec: RESTART })).toThrow(
			/node ids/,
		);
	});
});
