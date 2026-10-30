import { expect, test } from "vitest";
import type { CredentialView, TaskView } from "./api.ts";
import {
	alwaysRule,
	batchOutput,
	buildTargets,
	credentialTrustSnippet,
	enrollCommand,
	isTerminal,
	joinOutput,
	mcpCommand,
	outputText,
	parseList,
	shellQuote,
	splitArgv,
	statusOutputNote,
	taskActor,
	taskOutcome,
	tokenStatus,
	trustSnippet,
} from "./lib.ts";

test("isTerminal", () => {
	for (const s of ["exited", "failed", "rejected", "unknown", "denied"]) expect(isTerminal(s)).toBe(true);
	for (const s of ["dispatched", "running", "accepted", "awaiting_approval", "awaiting_authorization"])
		expect(isTerminal(s)).toBe(false);
});

test("joinOutput without gap", () => {
	expect(joinOutput("hello", "", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
	expect(joinOutput("hello", "hello", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
});

test("joinOutput with gap", () => {
	expect(outputText("abc", "xyz", 106)).toBe("abc\n… 100 bytes omitted …\nxyz");
});

test("joinOutput overlapping head and tail", () => {
	expect(outputText("abcd", "cdef", 6)).toBe("abcdef");
});

test("joinOutput counts bytes, not characters", () => {
	expect(joinOutput("é", "é!", 3).omitted).toBe(0);
});

test("batchOutput reads the fields by output mode", () => {
	const base = { stdoutBytes: 100, stderrBytes: 20, stdoutTail: "tail\n", outputFile: "/var/lib/crha/output/t.log" };
	expect(batchOutput({ ...base, outputMode: "full" })).toEqual({ kind: "full" });
	expect(batchOutput({ ...base, outputMode: "text" })).toEqual({ kind: "tail", text: "tail\n", bytes: 120 });
	expect(batchOutput({ ...base, outputMode: "status" })).toEqual({
		kind: "status",
		file: "/var/lib/crha/output/t.log",
	});
	expect(batchOutput({ ...base, outputMode: "status", outputFile: null })).toEqual({ kind: "status", file: null });
});

test("statusOutputNote only blames SSH for a task that ran", () => {
	expect(statusOutputNote({ state: "running", exitCode: null, signal: null })).toContain("until the task exits");
	expect(statusOutputNote({ state: "failed", exitCode: null, signal: null })).toBe("no output was kept.");
	expect(statusOutputNote({ state: "exited", exitCode: 0, signal: null })).toContain("SSH nodes keep no output");
	expect(statusOutputNote({ state: "exited", exitCode: null, signal: "SIGKILL" })).toContain(
		"SSH nodes keep no output",
	);
});

test("splitArgv", () => {
	expect(splitArgv(`ls -l "my dir" 'a b' c\\ d`)).toEqual(["ls", "-l", "my dir", "a b", "c d"]);
	expect(splitArgv(`echo ""`)).toEqual(["echo", ""]);
	expect(splitArgv("   ")).toEqual([]);
});

test("taskOutcome", () => {
	const base = {
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
	} as TaskView;
	expect(taskOutcome(base)).toBe("exit 0");
	expect(taskOutcome({ ...base, signal: "SIGKILL" })).toBe("signal SIGKILL");
	expect(taskOutcome({ ...base, state: "failed", errorCode: "node_offline", errorMessage: "gone" })).toBe(
		"node_offline: gone",
	);
});

test("enrollCommand", () => {
	expect(enrollCommand("https://h", "tok")).toBe("crha enroll https://h tok");
});

import { parseHash } from "./router.ts";

test("parseHash", () => {
	expect(parseHash("#/nodes/a%20b")).toEqual(["nodes", "a b"]);
	expect(parseHash("")).toEqual([]);
});

test("parseList and buildTargets", () => {
	expect(parseList("a, b  c,,a")).toEqual(["a", "b", "c"]);
	expect(buildTargets(["n1"], "group:web, n1")).toEqual(["n1", "group:web"]);
	expect(buildTargets([], "")).toEqual([]);
});

test("taskActor", () => {
	const t = { onBehalfOfUserId: "u1", actorType: "agent", actorId: "a1" } as TaskView;
	expect(taskActor(t, (id) => (id === "u1" ? "Alice" : undefined))).toBe("Alice");
	expect(taskActor(t, () => undefined)).toBe("u1");
	expect(taskActor({ ...t, onBehalfOfUserId: null }, () => undefined)).toBe("agent a1");
});

test("shellQuote", () => {
	expect(shellQuote("a/b-c_d.e:f,g=h+i@j%k")).toBe("a/b-c_d.e:f,g=h+i@j%k");
	expect(shellQuote("a b")).toBe("'a b'");
	expect(shellQuote("it's")).toBe("'it'\\''s'");
	expect(shellQuote("")).toBe("''");
});

test("alwaysRule", () => {
	expect(alwaysRule({ method: "exec", target: "/bin/sh -c 'echo hi; ls'" }, ["n1"], "exact", true)).toEqual({
		action: "allow",
		method: "exec",
		nodes: ["n1"],
		privileged: true,
		exact: "/bin/sh -c 'echo hi; ls'",
	});
	expect(alwaysRule({ method: "file.write", target: "/etc/x" }, ["n1", "n2"], "prefix", false)).toEqual({
		action: "allow",
		method: "file.write",
		nodes: ["n1", "n2"],
		privileged: false,
		prefix: "/etc/x",
	});
	expect(alwaysRule(null, ["n"], "exact", true)).toBeUndefined();
});

test("tokenStatus", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	expect(tokenStatus({ revokedAt: "x", expiresAt: null }, now)).toBe("revoked");
	expect(tokenStatus({ revokedAt: null, expiresAt: "2025-01-01T00:00:00Z" }, now)).toBe("expired");
	expect(tokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
});

test("mcpCommand", () => {
	expect(mcpCommand("http://h:1", "crh_x")).toBe(
		'claude mcp add --transport http crh http://h:1/mcp --header "Authorization: Bearer crh_x"',
	);
});

test("trustSnippet builds the crhs trust entry for privileged.toml", () => {
	const snippet = trustSnippet("ssh-ed25519 AAAAkey crhs-signing");
	expect(snippet).toContain("[[trust]]");
	expect(snippet).toContain('name          = "crhs"');
	expect(snippet).toContain('role          = "crhs"');
	expect(snippet).toContain('format        = "sshsig"');
	expect(snippet).toContain('key           = "ssh-ed25519 AAAAkey crhs-signing"');
	expect(snippet).toContain('kinds         = ["execute", "cosign"]');
	expect(snippet).toContain("require_exact = true");
	expect(snippet).toContain('max_ttl       = "5m"');
	expect(snippet).toContain("# Allow the commands crhs may authorize on this node.");
	expect(snippet).toContain('{ method = "exec", prefix = "systemctl restart " },');
	expect(snippet).toContain('{ method = "file.read", prefix = "/var/log/" },');
	expect(snippet).toContain('{ method = "file.write", prefix = "/etc/crha/" },');
	expect(snippet.endsWith("\n")).toBe(true);
});

test("trustSnippet escapes the TOML basic string", () => {
	const snippet = trustSnippet('ssh-ed25519 AA"AA\\key comment');
	expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA\\\\key comment"');
});

const sshCredential: CredentialView = {
	id: "c1",
	kind: "ssh",
	name: "laptop",
	createdAt: "2026-01-01T00:00:00.000Z",
	publicKey: "ssh-ed25519 AAAAC3Nza laptop",
	fingerprint: "SHA256:abc",
	credentialId: null,
	rpId: null,
	origins: [],
};

const passkeyCredential: CredentialView = {
	id: "c2",
	kind: "webauthn",
	name: "yubikey",
	createdAt: "2026-01-01T00:00:00.000Z",
	// "/" and "+" become "_" and "-" in the trust config, and the padding goes away.
	publicKey: "o2NmbXRkbm9uZQ+/",
	fingerprint: null,
	credentialId: "AAECAwQ",
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
};

test("credentialTrustSnippet builds a user entry for an SSH key", () => {
	const snippet = credentialTrustSnippet(sshCredential);
	expect(snippet).toContain("[[trust]]");
	expect(snippet).toContain('name          = "laptop"');
	expect(snippet).toContain('role          = "user"');
	expect(snippet).toContain('format        = "sshsig"');
	expect(snippet).toContain('key           = "ssh-ed25519 AAAAC3Nza laptop"');
	expect(snippet).toContain('kinds         = ["execute"]');
	expect(snippet).toContain("# Require user verification (a FIDO touch with PIN); only sk-* SSH keys can assert it.");
	expect(snippet).toContain("# require_uv = true");
	expect(snippet).toContain('# max_ttl   = "24h"');
	expect(snippet).toContain('{ method = "exec", prefix = "systemctl restart " },');
	expect(snippet).toContain('{ method = "file.write", prefix = "/etc/crha/" },');
	expect(snippet.endsWith("\n")).toBe(true);
});

test("credentialTrustSnippet builds a webauthn entry with the COSE key and RP", () => {
	const snippet = credentialTrustSnippet(passkeyCredential);
	expect(snippet).toContain('format        = "webauthn"');
	expect(snippet).toContain('rp_id         = "crh.example.com"');
	expect(snippet).toContain('origins       = ["https://crh.example.com"]');
	expect(snippet).toContain('credential_id = "AAECAwQ"');
	expect(snippet).toContain('key           = "cose:o2NmbXRkbm9uZQ-_"');
	expect(snippet).not.toContain("o2NmbXRkbm9uZQ+/");
});

test("credentialTrustSnippet escapes names, keys and origins as TOML strings", () => {
	const snippet = credentialTrustSnippet({
		...sshCredential,
		name: 'a "b" \\c',
		publicKey: 'ssh-ed25519 AA"AA',
	});
	expect(snippet).toContain('name          = "a \\"b\\" \\\\c"');
	expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA"');
});
