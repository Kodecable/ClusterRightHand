import type { TrustEntry, TrustSummary } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import type { NodeGroupRef } from "../src/cluster/node-groups.ts";
import { type TrustWarningContext, trustWarningsForNode } from "../src/cluster/trust-warnings.ts";

const NODE = "0192f000-0000-7000-8000-000000000001";
const WEB = "0192f000-0000-7000-8000-0000000000a1";
const PROD = "0192f000-0000-7000-8000-0000000000a2";
const UNKNOWN = "0192f000-0000-7000-8000-0000000000ff";
const PASSKEY = Uint8Array.from(Buffer.from("passkey-id-1"));

const WEB_GROUP: NodeGroupRef = { id: WEB, name: "web" };
const PROD_GROUP: NodeGroupRef = { id: PROD, name: "prod" };

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

function entry(
	name: string,
	role: TrustEntry["role"],
	key: TrustEntry["key"],
	overrides: Partial<TrustEntry> = {},
): TrustEntry {
	return {
		name,
		source: "local",
		role,
		key,
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

const CRHS = entry("crhs", "crhs", { kind: "sshsig", publicKey: "ssh-ed25519 AAAA crhs", fingerprint: "SHA256:crhs" });
const CRHS_OLD = entry("crhs-old", "crhs", {
	kind: "sshsig",
	publicKey: "ssh-ed25519 AAAA old",
	fingerprint: "SHA256:old",
});
const ALICE = entry("alice", "user", {
	kind: "sshsig",
	publicKey: "ssh-ed25519 AAAA alice",
	fingerprint: "SHA256:alice",
});
const BOB_UNKNOWN = entry("bob", "user", {
	kind: "sshsig",
	publicKey: "ssh-ed25519 AAAA bob",
	fingerprint: "SHA256:bob",
});
const PASSKEY_KNOWN = entry("passkey", "user", {
	kind: "webauthn",
	credentialId: PASSKEY,
	coseKey: Uint8Array.from([4, 5, 6]),
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
});
const PASSKEY_UNKNOWN = entry("other-passkey", "user", {
	kind: "webauthn",
	credentialId: Uint8Array.from(Buffer.from("passkey-id-2")),
	coseKey: Uint8Array.from([7, 8, 9]),
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
});
const LOCAL = entry("local-admins", "local", { kind: "local", uids: [0] });

const CONTEXT: TrustWarningContext = {
	crhsFingerprint: "SHA256:crhs",
	nodeGroups: new Map([
		[WEB, "web"],
		[PROD, "prod"],
	]),
	sshFingerprints: new Set(["SHA256:alice"]),
	webauthnCredentialIds: new Set([Buffer.from(PASSKEY).toString("base64url")]),
};

function summary(trust: TrustEntry[], aliases: string[] = []): TrustSummary {
	return { nodeId: NODE, aliases, clockSkewMs: 60_000, identities: IDENTITIES, trust };
}

function warnings(
	input: {
		aliases?: string[];
		trust?: TrustEntry[];
		memberships?: NodeGroupRef[];
		privilegedMode?: string | null;
		summary?: TrustSummary | null;
		context?: TrustWarningContext;
	} = {},
) {
	return trustWarningsForNode({
		nodeId: NODE,
		privilegedMode: input.privilegedMode === undefined ? "forward" : input.privilegedMode,
		summary: input.summary === undefined ? summary(input.trust ?? [], input.aliases ?? []) : input.summary,
		memberships: input.memberships ?? [],
		context: input.context ?? CONTEXT,
	});
}

describe("node trust warnings", () => {
	it("reports nothing without a valid trust report", () => {
		expect(warnings({ summary: null })).toEqual([]);
	});

	it("flags an alias for a node group the node is not in as superfluous and dangerous", () => {
		const [warning] = warnings({ aliases: [WEB], memberships: [] });
		expect(warning).toMatchObject({
			kind: "alias_superfluous",
			severity: "danger",
			uuid: WEB,
			nodeGroupName: "web",
			trustName: null,
		});
		expect(warning?.message).toContain(`remove "${WEB}" from aliases`);
		// A member of the group it trusts is in sync.
		expect(warnings({ aliases: [WEB], memberships: [WEB_GROUP] })).toEqual([]);
	});

	it("flags an alias that is neither an existing node group nor the node's own id", () => {
		const [warning] = warnings({ aliases: [UNKNOWN] });
		expect(warning).toMatchObject({
			kind: "alias_unknown",
			severity: "warning",
			uuid: UNKNOWN,
			nodeGroupName: null,
			trustName: null,
		});
		expect(warning?.message).toContain(`remove "${UNKNOWN}" from aliases`);
		// The node's own id is a valid address and not an unknown alias.
		expect(warnings({ aliases: [NODE] })).toEqual([]);
	});

	it("suggests a missing alias only on forward nodes", () => {
		const [warning] = warnings({ memberships: [WEB_GROUP], privilegedMode: "forward" });
		expect(warning).toMatchObject({
			kind: "alias_missing",
			severity: "info",
			uuid: WEB,
			nodeGroupName: "web",
		});
		expect(warning?.message).toContain(`add "${WEB}" to aliases`);
		// A trusted membership is in sync.
		expect(warnings({ aliases: [WEB], memberships: [WEB_GROUP], privilegedMode: "forward" })).toEqual([]);
		// native / ignore / reject nodes never act on aliases, so a missing one is not a warning.
		for (const mode of ["native", "ignore", "reject", null]) {
			expect(warnings({ memberships: [WEB_GROUP], privilegedMode: mode })).toEqual([]);
		}
		// Only forward nodes report missing aliases; a superfluous one still applies elsewhere.
		expect(warnings({ aliases: [PROD], memberships: [WEB_GROUP], privilegedMode: "native" })).toMatchObject([
			{ kind: "alias_superfluous", uuid: PROD },
		]);
	});

	it("flags trust entries whose key crhs does not know, but never local entries", () => {
		const found = warnings({
			trust: [CRHS, CRHS_OLD, ALICE, BOB_UNKNOWN, PASSKEY_KNOWN, PASSKEY_UNKNOWN, LOCAL],
		});
		expect(found.map((warning) => warning.trustName)).toEqual(["crhs-old", "bob", "other-passkey"]);
		for (const warning of found) {
			expect(warning).toMatchObject({ kind: "trust_unknown", severity: "warning", uuid: null, nodeGroupName: null });
			expect(warning.message).toContain(`"${warning.trustName}"`);
		}
	});

	it("reports every kind at once in a stable order", () => {
		const found = warnings({
			aliases: [WEB, UNKNOWN],
			memberships: [PROD_GROUP],
			trust: [BOB_UNKNOWN],
		});
		expect(found.map((warning) => warning.kind)).toEqual([
			"alias_superfluous",
			"alias_unknown",
			"alias_missing",
			"trust_unknown",
		]);
	});
});
