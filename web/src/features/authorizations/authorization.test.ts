import type { PendingAuthorization } from "@crh/api";
import { describe, expect, test } from "vitest";
import { authorizationLines, commandText, grantCommand, sshKeygenRecipe } from "./authorization";

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
		nodes: ["node-1", "web"],
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

describe("commandText", () => {
	test("renders exact, prefix and unrestricted commands", () => {
		expect(commandText(PENDING.decoded.command)).toBe("exec exact systemctl restart nginx");
		expect(commandText({ method: "file.write", match: "prefix", target: "/etc/nginx/" })).toBe(
			"file.write prefix /etc/nginx/",
		);
		// The card translates the unrestricted payload; the pure helper stays textual.
		expect(commandText(null)).toBe("");
	});
});

describe("authorizationLines", () => {
	test("renders the decoded payload as keyed lines", () => {
		const lines = authorizationLines(PENDING, "en");
		const byKey = new Map(lines.map((line) => [line.key, line]));
		expect(byKey.get("nodes")).toMatchObject({ value: "node-1, web", mono: true });
		expect(byKey.get("command")).toMatchObject({ value: "exec exact systemctl restart nginx", mono: true });
		expect(byKey.get("attempt")).toEqual({ key: "attempt", value: "2" });
		expect(byKey.get("tasks")).toMatchObject({ value: "task-1, task-2", mono: true });
		expect(byKey.get("specHash")).toMatchObject({ value: "b".repeat(64), mono: true });
		expect(byKey.get("note")).toEqual({ key: "note", value: "restart nginx" });
		expect(byKey.get("authorizationId")).toMatchObject({ value: "a".repeat(64), mono: true });
		expect(byKey.has("issued")).toBe(true);
		expect(byKey.has("deadline")).toBe(true);
	});

	test("omits an empty note and the spec hash of a prefix command", () => {
		const lines = authorizationLines(
			{
				...PENDING,
				decoded: {
					...PENDING.decoded,
					command: { method: "exec", match: "prefix", target: "systemctl " },
					note: "",
				},
			},
			"en",
		);
		const keys = lines.map((line) => line.key);
		expect(keys).not.toContain("note");
		expect(keys).not.toContain("specHash");
		expect(keys).toContain("command");
	});
});

describe("signing recipes", () => {
	test("grantCommand and sshKeygenRecipe sign the exact payload bytes", () => {
		expect(grantCommand("AQID")).toBe("crha grant --payload AQID --key ~/.ssh/id_ed25519");
		const recipe = sshKeygenRecipe("AQID");
		expect(recipe).toContain("printf %s 'AQID' | base64 -d > crh-payload.bin");
		expect(recipe).toContain("ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin");
		expect(recipe).toContain("crh-payload.bin.sig");
	});
});
