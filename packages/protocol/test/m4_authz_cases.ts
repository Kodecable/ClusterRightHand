/**
 * Builds test/interop/m4_authz_cases.json: the shared authorization decision
 * cases of doc/privilege.md#校验流程. Signatures are abstract here (which
 * trust entry signed, whether the signature verifies, the UV flag), so the
 * cases exercise the decision logic, not the crypto (m4_vectors.json does).
 * crha's privileged mode must reproduce every expectation; crhs's planner
 * uses the same matching (targets, rules, payload coverage) and must not
 * pick a path that a case shows crha would reject.
 *
 * Deterministic: m4_authz_cases.test.ts checks that the committed file is
 * exactly this generator's output.
 */
import { encode as encodeCbor } from "../src/cbor.ts";
import { type JsonTaskSpec, taskSpecToJson } from "../src/json.ts";
import { type TaskSpec, taskSpecCodec } from "../src/messages.ts";
import { hex, sha256Of } from "./m4_vectors.ts";

type Method = "exec" | "file.read" | "file.write";

interface Rule {
	method: Method;
	match: "any" | "prefix" | "regex";
	pattern: string;
}

interface Entry {
	name: string;
	role: "crhs" | "user" | "local";
	kinds: ("execute" | "cosign" | "require-cosign")[];
	require_exact: boolean;
	require_task: boolean;
	require_uv: boolean;
	max_ttl_ms: number | null;
	allow: Rule[];
	deny: Rule[];
	env_allow: string[];
	uids: number[];
}

interface PayloadJson {
	nodes: string[];
	command: null | { method: Method; exact?: string; prefix?: string; spec_sha256?: string };
	issued_at_ms: number;
	deadline_ms: number | null;
	task_ids: string[] | null;
	attempt: number | null;
}

interface Case {
	id: string;
	description: string;
	now_ms: number;
	clock_skew_ms: number;
	node: { id: string; groups: string[] };
	trust: Entry[];
	task: { task_id: string; attempt: number; spec: JsonTaskSpec };
	authorization: null | {
		payload: PayloadJson;
		/** In signature order. `entry` names the signer; a name with no trust entry here is a key this node does not trust. `valid` is the crypto result. */
		signatures: { entry: string; valid: boolean; uv: boolean }[];
		revoked: boolean;
	};
	/** For task.start after `crha approve`: who approved and the spec hash recorded at approval. */
	local_approval: null | { uid: number; spec_sha256: string };
	/** Task ids already executed on this node, and (authorization, task id) pairs already used. */
	executed_task_ids: string[];
	used_pairs: string[];
	expect: { result: "accepted" | string; step: number | null };
}

export interface AuthzCases {
	comment: string;
	targets: { spec: JsonTaskSpec; method: Method; target: string }[];
	cases: Case[];
}

const NOW = 1_793_016_000_000;
const NODE = "01JB0000000000000000000001";
const OTHER_NODE = "01JB0000000000000000000002";
const TASK = "0192f000-0000-7000-8000-000000000001";
const OTHER_TASK = "0192f000-0000-7000-8000-000000000002";

const specHash = (spec: TaskSpec): string => hex(sha256Of(encodeCbor(taskSpecCodec.encode(spec))));

const RESTART: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};
const RESTART_ENV: TaskSpec = { ...RESTART, env: { DEBIAN_FRONTEND: "noninteractive" } } as TaskSpec;
const RESTART_SHELL: TaskSpec = {
	kind: "exec",
	command: { shell: "systemctl restart nginx; id" },
	env: {},
	cwd: "",
	stdin: null,
};
// A target the broken guard pattern below matches when the implicit full match is escaped.
const A_ONLY: TaskSpec = { ...RESTART, command: { argv: ["a"] } } as TaskSpec;
const WRITE_NGINX: TaskSpec = {
	kind: "file.write",
	path: "/etc/nginx/nginx.conf",
	content: { size: 0, sha256: sha256Of(new Uint8Array(0)) },
	overwrite: true,
	mode: 0o644,
	owner: "",
	group: "",
};
const READ_NGINX: TaskSpec = { kind: "file.read", path: "/etc/nginx/nginx.conf", startLine: 1, lineCount: 100 };
const READ_SHADOW: TaskSpec = { kind: "file.read", path: "/etc/shadow", startLine: 1, lineCount: 100 };
const WRITE_CRHA: TaskSpec = { ...WRITE_NGINX, path: "/etc/crha/privileged.toml" } as TaskSpec;
const STAT_RELATIVE: TaskSpec = { kind: "file.stat", path: "etc/hosts" };
const STAT_DOTDOT: TaskSpec = { kind: "file.stat", path: "/etc/nginx/../shadow" };
const LIST_NGINX: TaskSpec = { kind: "file.list", path: "/etc/nginx", limit: 0 };

const entry = (name: string, role: Entry["role"], overrides: Partial<Entry> = {}): Entry => ({
	name,
	role,
	kinds: ["execute"],
	require_exact: false,
	require_task: false,
	require_uv: false,
	max_ttl_ms: null,
	allow: [],
	deny: [],
	env_allow: [],
	uids: [],
	...overrides,
});

const CRHS = entry("crhs", "crhs", {
	kinds: ["execute", "cosign"],
	require_exact: true,
	require_task: true,
	max_ttl_ms: 300_000,
	allow: [
		{ method: "exec", match: "prefix", pattern: "systemctl restart " },
		{ method: "exec", match: "regex", pattern: "apt-get (update|upgrade -y)" },
		{ method: "file.write", match: "prefix", pattern: "/etc/nginx/" },
		{ method: "file.read", match: "any", pattern: "" },
	],
	deny: [
		{ method: "file.read", match: "regex", pattern: "/etc/(shadow|gshadow|sudoers.*)" },
		{ method: "file.write", match: "prefix", pattern: "/etc/crha/" },
	],
});
const USER = entry("alice", "user", { max_ttl_ms: 86_400_000, env_allow: ["DEBIAN_FRONTEND"] });
const LOCAL = entry("local-admins", "local", { uids: [0, 1000] });

const exactRestart = { method: "exec" as const, exact: "systemctl restart nginx", spec_sha256: specHash(RESTART) };

function crhsPayload(overrides: Partial<PayloadJson> = {}): PayloadJson {
	return {
		nodes: [NODE],
		command: exactRestart,
		issued_at_ms: NOW,
		deadline_ms: NOW + 300_000,
		task_ids: [TASK],
		attempt: 1,
		...overrides,
	};
}

function base(id: string, description: string, overrides: Partial<Case> = {}): Case {
	return {
		id,
		description,
		now_ms: NOW,
		clock_skew_ms: 60_000,
		node: { id: NODE, groups: ["web", "prod"] },
		trust: [CRHS, USER, LOCAL],
		task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(RESTART) },
		authorization: { payload: crhsPayload(), signatures: [{ entry: "crhs", valid: true, uv: false }], revoked: false },
		local_approval: null,
		executed_task_ids: [],
		used_pairs: [],
		expect: { result: "accepted", step: null },
		...overrides,
	};
}

const signedBy = (payload: PayloadJson, ...entries: string[]): NonNullable<Case["authorization"]> => ({
	payload,
	signatures: entries.map((name) => ({ entry: name, valid: true, uv: false })),
	revoked: false,
});

const reject = (result: string, step: number) => ({ expect: { result, step } });

function cases(): Case[] {
	const userOneShot = (overrides: Partial<PayloadJson> = {}): PayloadJson =>
		crhsPayload({ deadline_ms: NOW + 3_600_000, ...overrides });
	return [
		// --- crhs execute -------------------------------------------------------------------
		base("crhs.exact.accept", "crhs single-command authorization within its rules"),
		base("crhs.no-authorization", "no authorization and no local approval", {
			authorization: null,
			...reject("authorization_required", 3),
		}),
		base("crhs.bad-signature", "the crhs signature does not verify", {
			authorization: { ...signedBy(crhsPayload(), "crhs"), signatures: [{ entry: "crhs", valid: false, uv: false }] },
			...reject("authorization_invalid", 3),
		}),
		base("crhs.unknown-signer", "only a signature from a key this node does not trust", {
			authorization: signedBy(crhsPayload(), "unknown"),
			...reject("authorization_invalid", 3),
		}),
		base("crhs.unknown-signer-ignored", "an untrusted extra signature is ignored", {
			authorization: signedBy(crhsPayload(), "unknown", "crhs"),
		}),
		base("crhs.other-node", "payload addressed to another node", {
			authorization: signedBy(crhsPayload({ nodes: [OTHER_NODE] }), "crhs"),
			...reject("authorization_invalid", 4),
		}),
		base("crhs.group", "a one-shot payload must list node ids, not a group (doc/protocol.md 授权对象)", {
			authorization: signedBy(crhsPayload({ nodes: ["group:web"] }), "crhs"),
			...reject("authorization_invalid", 5),
		}),
		base("crhs.other-group", "payload addressed to a group not configured on this node", {
			authorization: signedBy(crhsPayload({ nodes: ["group:db"] }), "crhs"),
			...reject("authorization_invalid", 4),
		}),
		base("crhs.star", 'a one-shot payload must list node ids, not "*" (doc/protocol.md 授权对象)', {
			authorization: signedBy(crhsPayload({ nodes: ["*"] }), "crhs"),
			...reject("authorization_invalid", 5),
		}),
		base("crhs.expired", "deadline more than clock_skew in the past", {
			now_ms: NOW + 300_000 + 60_001,
			...reject("authorization_expired", 4),
		}),
		base("crhs.expired-within-skew", "deadline in the past but within clock_skew", {
			now_ms: NOW + 300_000 + 60_000,
		}),
		base("crhs.future", "issued more than clock_skew in the future", {
			now_ms: NOW - 60_001,
			...reject("authorization_expired", 4),
		}),
		base("crhs.ttl-exceeded", "deadline - issued_at exceeds max_ttl", {
			authorization: signedBy(crhsPayload({ deadline_ms: NOW + 300_001 }), "crhs"),
			...reject("authorization_expired", 4),
		}),
		base("crhs.ttl-no-deadline", "max_ttl set but the payload has no deadline", {
			authorization: signedBy(crhsPayload({ deadline_ms: null }), "crhs"),
			...reject("authorization_expired", 4),
		}),
		base("crhs.require-exact", "crhs entry requires exact; payload is a prefix", {
			authorization: signedBy(crhsPayload({ command: { method: "exec", prefix: "systemctl " } }), "crhs"),
			...reject("authorization_rejected", 4),
		}),
		base("crhs.no-task-ids", "crhs authorizations must carry task_ids", {
			authorization: signedBy(crhsPayload({ task_ids: null, attempt: null }), "crhs"),
			...reject("authorization_rejected", 5),
		}),
		base("crhs.wrong-task", "task id not in task_ids", {
			task: { task_id: OTHER_TASK, attempt: 1, spec: taskSpecToJson(RESTART) },
			...reject("authorization_invalid", 5),
		}),
		base("crhs.wrong-attempt", "attempt differs from task.start", {
			task: { task_id: TASK, attempt: 2, spec: taskSpecToJson(RESTART) },
			...reject("authorization_invalid", 5),
		}),
		base("crhs.used", "(authorization, task) pair already used", {
			used_pairs: [TASK],
			...reject("authorization_rejected", 5),
		}),
		base("crhs.executed", "task id already executed on this node", {
			executed_task_ids: [TASK],
			...reject("already_accepted", 5),
		}),
		base("crhs.exact-target-mismatch", "exact target differs from the task", {
			task: {
				task_id: TASK,
				attempt: 1,
				spec: taskSpecToJson({ ...RESTART, command: { argv: ["systemctl", "restart", "apache2"] } } as TaskSpec),
			},
			...reject("authorization_rejected", 6),
		}),
		base("crhs.exact-spec-mismatch", "same target, but env changed so spec_sha256 differs", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(RESTART_ENV) },
			...reject("authorization_rejected", 6),
		}),
		base("crhs.shell-not-prefix", "shell mode renders as /bin/sh -c …, so the prefix rule does not match", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(RESTART_SHELL) },
			authorization: signedBy(
				crhsPayload({
					command: {
						method: "exec",
						exact: "/bin/sh -c 'systemctl restart nginx; id'",
						spec_sha256: specHash(RESTART_SHELL),
					},
				}),
				"crhs",
			),
			...reject("authorization_rejected", 7),
		}),
		base("crhs.regex-full-match", "regex rules match the whole target", {
			task: {
				task_id: TASK,
				attempt: 1,
				spec: taskSpecToJson({ ...RESTART, command: { argv: ["apt-get", "upgrade", "-y"] } } as TaskSpec),
			},
			authorization: signedBy(
				crhsPayload({
					command: {
						method: "exec",
						exact: "apt-get upgrade -y",
						spec_sha256: specHash({ ...RESTART, command: { argv: ["apt-get", "upgrade", "-y"] } } as TaskSpec),
					},
				}),
				"crhs",
			),
		}),
		base("crhs.regex-not-partial", "regex rules do not match a target that only contains the pattern", {
			task: {
				task_id: TASK,
				attempt: 1,
				spec: taskSpecToJson({ ...RESTART, command: { argv: ["apt-get", "update", "--fix-missing"] } } as TaskSpec),
			},
			authorization: signedBy(
				crhsPayload({
					command: {
						method: "exec",
						exact: "apt-get update --fix-missing",
						spec_sha256: specHash({
							...RESTART,
							command: { argv: ["apt-get", "update", "--fix-missing"] },
						} as TaskSpec),
					},
				}),
				"crhs",
			),
			...reject("authorization_rejected", 7),
		}),
		base("crhs.file.write", "file.write allowed by prefix", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(WRITE_NGINX) },
			authorization: signedBy(
				crhsPayload({
					command: { method: "file.write", exact: "/etc/nginx/nginx.conf", spec_sha256: specHash(WRITE_NGINX) },
				}),
				"crhs",
			),
		}),
		base("crhs.deny-write-crha", "deny file.write /etc/crha/", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(WRITE_CRHA) },
			authorization: signedBy(
				crhsPayload({
					command: { method: "file.write", exact: "/etc/crha/privileged.toml", spec_sha256: specHash(WRITE_CRHA) },
				}),
				"crhs",
			),
			...reject("authorization_rejected", 7),
		}),
		base("crhs.deny-read-shadow", "deny file.read regex", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(READ_SHADOW) },
			authorization: signedBy(
				crhsPayload({ command: { method: "file.read", exact: "/etc/shadow", spec_sha256: specHash(READ_SHADOW) } }),
				"crhs",
			),
			...reject("authorization_rejected", 7),
		}),
		base("crhs.env-not-allowed", "the crhs entry allows no environment variables", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(RESTART_ENV) },
			authorization: signedBy(
				crhsPayload({ command: { ...exactRestart, spec_sha256: specHash(RESTART_ENV) } }),
				"crhs",
			),
			...reject("authorization_rejected", 7),
		}),
		base("crhs.cosign-only", "a crhs entry with only cosign cannot authorize alone", {
			trust: [{ ...CRHS, kinds: ["cosign"] }, USER, LOCAL],
			...reject("authorization_rejected", 7),
		}),
		base("crhs.revoked", "the authorization id is revoked", {
			authorization: { ...signedBy(crhsPayload(), "crhs"), revoked: true },
			...reject("authorization_rejected", 9),
		}),
		base("crhs.not-trusted", "node trusts only the user; a crhs signature has no trust entry", {
			trust: [USER, LOCAL],
			...reject("authorization_invalid", 3),
		}),

		// --- paths ---------------------------------------------------------------------------
		base("path.relative", "privileged file paths must be absolute", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(STAT_RELATIVE) },
			...reject("authorization_rejected", 2),
		}),
		base("path.dotdot", "privileged file paths must be normalized", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(STAT_DOTDOT) },
			...reject("authorization_rejected", 2),
		}),

		// --- user ----------------------------------------------------------------------------
		base("user.one-shot", "owner signed this task", {
			authorization: signedBy(userOneShot(), "alice"),
		}),
		base("user.prefix-reusable", "reusable prefix authorization; file.write covers file.list (a file.read method)", {
			task: { task_id: TASK, attempt: 3, spec: taskSpecToJson(LIST_NGINX) },
			authorization: signedBy(
				{
					nodes: ["group:web"],
					command: { method: "file.write", prefix: "/etc/nginx" },
					issued_at_ms: NOW,
					deadline_ms: NOW + 86_400_000,
					task_ids: null,
					attempt: null,
				},
				"alice",
			),
		}),
		base("user.prefix-method-mismatch", "a file.read authorization does not cover file.write", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(WRITE_NGINX) },
			authorization: signedBy(
				{
					nodes: [NODE],
					command: { method: "file.read", prefix: "/etc/nginx/" },
					issued_at_ms: NOW,
					deadline_ms: NOW + 3_600_000,
					task_ids: null,
					attempt: null,
				},
				"alice",
			),
			...reject("authorization_rejected", 6),
		}),
		base("user.any-command", "command null covers any task (no require_exact on the user entry)", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(READ_NGINX) },
			authorization: signedBy(
				{ nodes: ["*"], command: null, issued_at_ms: NOW, deadline_ms: NOW + 3_600_000, task_ids: null, attempt: null },
				"alice",
			),
		}),
		base("user.env-allowed", "the user entry allows DEBIAN_FRONTEND", {
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(RESTART_ENV) },
			authorization: signedBy(
				userOneShot({ command: { ...exactRestart, spec_sha256: specHash(RESTART_ENV) } }),
				"alice",
			),
		}),
		base("user.require-task", "require_task: reusable authorizations are refused", {
			trust: [CRHS, { ...USER, require_task: true }, LOCAL],
			authorization: signedBy(userOneShot({ task_ids: null, attempt: null }), "alice"),
			...reject("authorization_rejected", 5),
		}),
		base("user.require-uv-missing", "require_uv and the signature lacks UV", {
			trust: [CRHS, { ...USER, require_uv: true }, LOCAL],
			authorization: signedBy(userOneShot(), "alice"),
			...reject("authorization_rejected", 7),
		}),
		base("user.require-uv", "require_uv and the signature has UV", {
			trust: [CRHS, { ...USER, require_uv: true }, LOCAL],
			authorization: {
				payload: userOneShot(),
				signatures: [{ entry: "alice", valid: true, uv: true }],
				revoked: false,
			},
		}),
		base("user.one-shot-no-deadline", "a one-shot authorization (task_ids) must have a deadline", {
			trust: [CRHS, { ...USER, max_ttl_ms: null }, LOCAL],
			authorization: signedBy(userOneShot({ deadline_ms: null }), "alice"),
			...reject("authorization_invalid", 5),
		}),
		base("user.no-ttl-limit", "user entry without max_ttl accepts an authorization without deadline", {
			trust: [CRHS, { ...USER, max_ttl_ms: null }, LOCAL],
			authorization: signedBy(userOneShot({ deadline_ms: null, task_ids: null, attempt: null }), "alice"),
		}),
		base("user.group-one-shot", "one signature covers the tasks of three nodes; this node's task is in the list", {
			task: { task_id: OTHER_TASK, attempt: 2, spec: taskSpecToJson(RESTART) },
			authorization: signedBy(
				userOneShot({
					nodes: [OTHER_NODE, NODE, "01JB0000000000000000000003"],
					task_ids: [TASK, OTHER_TASK, "0192f000-0000-7000-8000-000000000003"],
					attempt: 2,
				}),
				"alice",
			),
		}),
		base("user.group-one-shot-used", "the same group authorization was already used for this task", {
			task: { task_id: OTHER_TASK, attempt: 2, spec: taskSpecToJson(RESTART) },
			authorization: signedBy(
				userOneShot({ nodes: [OTHER_NODE, NODE], task_ids: [TASK, OTHER_TASK], attempt: 2 }),
				"alice",
			),
			used_pairs: [OTHER_TASK],
			...reject("authorization_rejected", 5),
		}),

		// --- one-shot node binding (doc/protocol.md 授权对象) ---------------------------------
		base("oneshot.aligned-multi-node", "the task at its node's position of an aligned multi-node payload", {
			task: { task_id: OTHER_TASK, attempt: 2, spec: taskSpecToJson(RESTART) },
			authorization: signedBy(
				userOneShot({ nodes: [OTHER_NODE, NODE], task_ids: [TASK, OTHER_TASK], attempt: 2 }),
				"alice",
			),
		}),
		base("oneshot.misaligned-node", "the task id sits at another node's position", {
			authorization: signedBy(
				userOneShot({ nodes: [OTHER_NODE, NODE], task_ids: [TASK, OTHER_TASK], attempt: 2 }),
				"alice",
			),
			...reject("authorization_invalid", 5),
		}),
		base("oneshot.length-mismatch", "nodes and task_ids differ in length", {
			authorization: signedBy(userOneShot({ nodes: [NODE], task_ids: [TASK, OTHER_TASK] }), "alice"),
			...reject("authorization_invalid", 5),
		}),
		base("oneshot.group-node", "one-shot payloads cannot fold a group into nodes", {
			authorization: signedBy(userOneShot({ nodes: ["group:web"] }), "alice"),
			...reject("authorization_invalid", 5),
		}),
		base("oneshot.star-node", 'one-shot payloads cannot use "*"', {
			authorization: signedBy(userOneShot({ nodes: ["*"] }), "alice"),
			...reject("authorization_invalid", 5),
		}),

		// --- guard rules ---------------------------------------------------------------------
		base("guard.broken-regex-allow", "a regex that cannot compile alone never matches (allow fails closed)", {
			trust: [{ ...USER, allow: [{ method: "exec", match: "regex", pattern: "a)|(b" }] }, LOCAL],
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(A_ONLY) },
			authorization: signedBy(
				userOneShot({ command: { method: "exec", exact: "a", spec_sha256: specHash(A_ONLY) } }),
				"alice",
			),
			...reject("authorization_rejected", 7),
		}),
		base("guard.broken-regex-deny", "a regex that cannot compile alone denies everything (deny fails closed)", {
			trust: [{ ...USER, deny: [{ method: "exec", match: "regex", pattern: "a)|(b" }] }, LOCAL],
			authorization: signedBy(userOneShot(), "alice"),
			...reject("authorization_rejected", 7),
		}),

		// --- cosign --------------------------------------------------------------------------
		base("cosign.missing", "user entry requires cosign; only the user signed", {
			trust: [CRHS, { ...USER, kinds: ["execute", "require-cosign"] }, LOCAL],
			authorization: signedBy(userOneShot(), "alice"),
			...reject("authorization_rejected", 8),
		}),
		base("cosign.present", "user signature plus crhs cosign on the same payload", {
			trust: [{ ...CRHS, kinds: ["cosign"] }, { ...USER, kinds: ["execute", "require-cosign"] }, LOCAL],
			authorization: signedBy(userOneShot(), "alice", "crhs"),
		}),
		base("cosign.crhs-rules-not-applied", "cosign ignores the crhs entry's own rules (deny /etc/crha/)", {
			trust: [{ ...CRHS, kinds: ["cosign"] }, { ...USER, kinds: ["execute", "require-cosign"] }, LOCAL],
			task: { task_id: TASK, attempt: 1, spec: taskSpecToJson(WRITE_CRHA) },
			authorization: signedBy(
				userOneShot({
					command: { method: "file.write", exact: "/etc/crha/privileged.toml", spec_sha256: specHash(WRITE_CRHA) },
				}),
				"alice",
				"crhs",
			),
		}),
		base("cosign.not-cosign-kind", "the crhs entry has execute but not cosign", {
			trust: [{ ...CRHS, kinds: ["execute"] }, { ...USER, kinds: ["execute", "require-cosign"] }, LOCAL],
			authorization: signedBy(userOneShot(), "alice", "crhs"),
			...reject("authorization_rejected", 8),
		}),
		base("cosign.first-candidate-error", "two candidates both fail; the first candidate's failure is reported", {
			trust: [{ ...CRHS, kinds: ["cosign"] }, { ...USER, kinds: ["execute", "require-cosign"] }, LOCAL],
			authorization: signedBy(userOneShot({ deadline_ms: NOW + 86_400_001 }), "alice", "crhs"),
			...reject("authorization_expired", 4),
		}),

		// --- local approval ------------------------------------------------------------------
		base("local.approved", "task.start after crha approve with the same spec", {
			authorization: null,
			local_approval: { uid: 1000, spec_sha256: specHash(RESTART) },
		}),
		base("local.spec-changed", "the spec hash differs from the one approved", {
			authorization: null,
			local_approval: { uid: 1000, spec_sha256: specHash(RESTART_ENV) },
			...reject("authorization_rejected", 6),
		}),
		base("local.executed", "an approved task id that already ran", {
			authorization: null,
			local_approval: { uid: 1000, spec_sha256: specHash(RESTART) },
			executed_task_ids: [TASK],
			...reject("already_accepted", 5),
		}),
	];
}

function targets(): AuthzCases["targets"] {
	const list: [TaskSpec, Method, string][] = [
		[RESTART, "exec", "systemctl restart nginx"],
		[RESTART_SHELL, "exec", "/bin/sh -c 'systemctl restart nginx; id'"],
		[
			{ ...RESTART, command: { argv: ["echo", "it's", "", "a b", "--x=1,2"] } } as TaskSpec,
			"exec",
			"echo 'it'\\''s' '' 'a b' --x=1,2",
		],
		[{ ...RESTART, command: { argv: ["printf", "%s\\n", "é"] } } as TaskSpec, "exec", "printf '%s\\n' 'é'"],
		[READ_NGINX, "file.read", "/etc/nginx/nginx.conf"],
		[{ kind: "file.stat", path: "/etc" }, "file.read", "/etc"],
		[LIST_NGINX, "file.read", "/etc/nginx"],
		[WRITE_NGINX, "file.write", "/etc/nginx/nginx.conf"],
		[{ kind: "file.edit", path: "/etc/hosts", edits: [] }, "file.write", "/etc/hosts"],
	];
	return list.map(([spec, method, target]) => ({ spec: taskSpecToJson(spec), method, target }));
}

export function buildAuthzCases(): AuthzCases {
	return {
		comment:
			"Generated by packages/protocol/test/generate-m4-authz-cases.ts. Steps refer to doc/privilege.md#校验流程; codes to doc/protocol.md#taskstart. Signatures are abstract.",
		targets: targets(),
		cases: cases(),
	};
}
