import { expect, test } from "vitest";
import type { PendingAuthorization } from "./api.ts";
import { authorizationLines, commandText, grantCommand, sshKeygenRecipe } from "./authorization.ts";

const PENDING: PendingAuthorization = {
	id: "a".repeat(64),
	payload: "o2dub2RlcwFhZ3JvdXA6d2Vi",
	challenge: "challenge-b64url",
	deadline: "2026-10-31T12:00:00.000Z",
	taskIds: ["task-1", "task-2"],
	attempt: 2,
	passkeys: [],
	localRequested: false,
	lastRejection: null,
	tried: ["crhs"],
	decoded: {
		nodes: ["node-1", "group:web"],
		command: {
			method: "exec",
			match: "exact",
			target: "systemctl restart nginx",
			specSha256: "b".repeat(64),
		},
		issuedAt: "2026-10-30T12:00:00.000Z",
		deadline: "2026-10-31T12:00:00.000Z",
		taskIds: ["task-1", "task-2"],
		attempt: 2,
		note: "restart nginx",
	},
};

test("commandText renders exact, prefix and unrestricted commands", () => {
	expect(commandText(PENDING.decoded.command)).toBe("exec exact systemctl restart nginx");
	expect(commandText({ method: "file.write", match: "prefix", target: "/etc/nginx/" })).toBe(
		"file.write prefix /etc/nginx/",
	);
	expect(commandText(null)).toBe("any method and target");
});

test("authorizationLines renders the decoded payload for the waiting page", () => {
	const lines = authorizationLines(PENDING);
	const byLabel = new Map(lines.map((line) => [line.label, line]));
	expect(byLabel.get("Nodes")).toMatchObject({ value: "node-1, group:web", mono: true });
	expect(byLabel.get("Command")).toMatchObject({ value: "exec exact systemctl restart nginx", mono: true });
	expect(byLabel.get("Attempt")).toEqual({ label: "Attempt", value: "2" });
	expect(byLabel.get("Tasks")).toMatchObject({ value: "task-1, task-2", mono: true });
	expect(byLabel.get("Spec hash")).toMatchObject({ value: "b".repeat(64), mono: true });
	expect(byLabel.get("Note")).toEqual({ label: "Note", value: "restart nginx" });
	expect(byLabel.get("Authorization id")).toMatchObject({ value: "a".repeat(64), mono: true });
	expect(byLabel.has("Issued")).toBe(true);
	expect(byLabel.has("Deadline")).toBe(true);
});

test("authorizationLines omits an empty note and the spec hash of a prefix command", () => {
	const lines = authorizationLines({
		...PENDING,
		decoded: {
			...PENDING.decoded,
			command: { method: "exec", match: "prefix", target: "systemctl " },
			note: "",
		},
	});
	const labels = lines.map((line) => line.label);
	expect(labels).not.toContain("Note");
	expect(labels).not.toContain("Spec hash");
	expect(labels).toContain("Command");
});

test("grantCommand and sshKeygenRecipe sign the exact payload bytes", () => {
	expect(grantCommand("AQID")).toBe("crha grant --payload AQID --key ~/.ssh/id_ed25519");
	const recipe = sshKeygenRecipe("AQID");
	expect(recipe).toContain("printf %s 'AQID' | base64 -d > crh-payload.bin");
	expect(recipe).toContain("ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin");
	expect(recipe).toContain("crh-payload.bin.sig");
});
