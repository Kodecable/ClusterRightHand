import { readFileSync } from "node:fs";
import { type AuthorizationPayload, encodeAuthorizationPayload, type TaskSpec, taskSpecFromJson } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import { type AuthzAuthorization, type AuthzEntry, type AuthzSignature, decide } from "../src/privilege/authz.ts";

type Method = "exec" | "file.read" | "file.write";

interface GuardRuleJson {
	method: Method;
	match: "any" | "prefix" | "regex";
	pattern: string;
}

interface EntryJson {
	name: string;
	role: "crhs" | "user" | "local";
	kinds: ("execute" | "cosign" | "require-cosign")[];
	require_exact: boolean;
	require_task: boolean;
	require_uv: boolean;
	max_ttl_ms: number | null;
	allow: GuardRuleJson[];
	deny: GuardRuleJson[];
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

interface CaseJson {
	id: string;
	description: string;
	now_ms: number;
	clock_skew_ms: number;
	node: { id: string; groups: string[] };
	trust: EntryJson[];
	task: { task_id: string; attempt: number; spec: unknown };
	authorization: null | {
		payload: PayloadJson;
		signatures: { entry: string; valid: boolean; uv: boolean }[];
		revoked: boolean;
	};
	local_approval: null | { uid: number; spec_sha256: string };
	executed_task_ids: string[];
	used_pairs: string[];
	expect: { result: string; step: number | null };
}

const fixture = JSON.parse(
	readFileSync(new URL("../../test/interop/m4_authz_cases.json", import.meta.url), "utf8"),
) as { cases: CaseJson[] };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

function entryOf(json: EntryJson): AuthzEntry {
	return {
		name: json.name,
		role: json.role,
		kinds: json.kinds,
		requireExact: json.require_exact,
		requireTask: json.require_task,
		requireUv: json.require_uv,
		maxTtlMs: json.max_ttl_ms,
		allow: json.allow,
		deny: json.deny,
		envAllow: json.env_allow,
		uids: json.uids,
	};
}

function payloadOf(json: PayloadJson): AuthorizationPayload {
	let command: AuthorizationPayload["command"] = null;
	if (json.command) {
		command =
			json.command.exact !== undefined
				? {
						method: json.command.method,
						match: {
							kind: "exact",
							target: json.command.exact,
							specSha256: bytesOf(json.command.spec_sha256 ?? ""),
						},
					}
				: {
						method: json.command.method,
						match: { kind: "prefix", target: json.command.prefix ?? "" },
					};
	}
	return {
		v: 1,
		nodes: json.nodes,
		command,
		issuedAtMs: json.issued_at_ms,
		deadlineMs: json.deadline_ms,
		taskIds: json.task_ids,
		attempt: json.attempt,
		note: "",
	};
}

function authorizationOf(json: NonNullable<CaseJson["authorization"]>, trust: AuthzEntry[]): AuthzAuthorization {
	const payload = payloadOf(json.payload);
	const byName = new Map(trust.map((entry) => [entry.name, entry]));
	const signatures: AuthzSignature[] = json.signatures.map((signature) => ({
		entry: byName.get(signature.entry) ?? null,
		valid: signature.valid,
		userVerified: signature.uv,
	}));
	return { payload: encodeAuthorizationPayload(payload), decoded: payload, signatures };
}

function specOf(json: CaseJson["task"]["spec"]): TaskSpec {
	return taskSpecFromJson(json);
}

describe("test/interop/m4_authz_cases.json", () => {
	it("has the cases the shared fixture lists", () => {
		expect(fixture.cases.length).toBeGreaterThan(40);
		expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(fixture.cases.length);
	});

	it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
		const trust = testCase.trust.map(entryOf);
		const decision = decide({
			now: testCase.now_ms,
			clockSkewMs: testCase.clock_skew_ms,
			nodeId: testCase.node.id,
			nodeGroups: testCase.node.groups,
			trust,
			task: { id: testCase.task.task_id, attempt: testCase.task.attempt, spec: specOf(testCase.task.spec) },
			authorization: testCase.authorization ? authorizationOf(testCase.authorization, trust) : null,
			localApproval: testCase.local_approval
				? { uid: testCase.local_approval.uid, specSha256: bytesOf(testCase.local_approval.spec_sha256) }
				: null,
			executed: (taskId) => testCase.executed_task_ids.includes(taskId),
			used: (_id, taskId) => testCase.used_pairs.includes(taskId),
			revoked: () => testCase.authorization?.revoked === true,
		});
		expect({ result: decision.result, step: decision.step }).toEqual(testCase.expect);
		if (decision.result === "accepted") expect(decision.entry).not.toBeNull();
		else expect(decision.message).not.toBe("");
	});

	it("rejects a payload whose bytes do not match the caller's decode", () => {
		const base = fixture.cases[0] as CaseJson;
		if (!base.authorization) throw new Error("fixture case without authorization");
		const trust = base.trust.map(entryOf);
		const authorization = authorizationOf(base.authorization, trust);
		const tampered: AuthzAuthorization = {
			...authorization,
			decoded: { ...authorization.decoded, note: "changed after decoding" },
		};
		const decision = decide({
			now: base.now_ms,
			clockSkewMs: base.clock_skew_ms,
			nodeId: base.node.id,
			nodeGroups: base.node.groups,
			trust,
			task: { id: base.task.task_id, attempt: base.task.attempt, spec: specOf(base.task.spec) },
			authorization: tampered,
			localApproval: null,
		});
		expect(decision).toMatchObject({
			result: "authorization_invalid",
			step: 3,
			message: "authorization payload does not match its decoded form",
		});
	});

	it("rejects malformed payload bytes and an empty signature list", () => {
		const base = fixture.cases[0] as CaseJson;
		if (!base.authorization) throw new Error("fixture case without authorization");
		const trust = base.trust.map(entryOf);
		const authorization = authorizationOf(base.authorization, trust);
		const input = {
			now: base.now_ms,
			clockSkewMs: base.clock_skew_ms,
			nodeId: base.node.id,
			nodeGroups: base.node.groups,
			trust,
			task: { id: base.task.task_id, attempt: base.task.attempt, spec: specOf(base.task.spec) },
			localApproval: null,
		};
		expect(decide({ ...input, authorization: { ...authorization, payload: new Uint8Array([1, 2, 3]) } })).toMatchObject(
			{ result: "authorization_invalid", step: 3 },
		);
		expect(decide({ ...input, authorization: { ...authorization, signatures: [] } })).toMatchObject({
			result: "authorization_invalid",
			step: 3,
			message: "authorization has no signatures",
		});
	});
});
