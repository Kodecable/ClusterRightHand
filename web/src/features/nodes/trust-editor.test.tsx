import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { buildTrustBlock, defaultDraft, formatGuardLines, parseGuardLines, type TrustKeySource } from "./trust-editor";
import { TrustEditor } from "./trust-editor-panel";

describe("buildTrustBlock", () => {
	test("builds the crhs entry with its fixed flags and example rules", () => {
		const source: TrustKeySource = { kind: "crhs", authorizedKey: "ssh-ed25519 AAAA crhs" };
		const block = buildTrustBlock(defaultDraft(source));
		expect(block).toContain("[[trust]]");
		expect(block).toContain('name          = "crhs"');
		expect(block).toContain('role          = "crhs"');
		expect(block).toContain('format        = "sshsig"');
		expect(block).toContain('key           = "ssh-ed25519 AAAA crhs"');
		expect(block).toContain('kinds         = ["execute", "cosign"]');
		expect(block).toContain("require_exact = true");
		expect(block).toContain('max_ttl       = "5m"');
		expect(block).toContain('{ method = "exec", prefix = "systemctl restart " },');
		expect(block).toContain('{ method = "file.write", prefix = "/etc/crha/" },');
	});

	test("a user key entry has role user and the execute kind", () => {
		const source: TrustKeySource = { kind: "ssh", name: "laptop", publicKey: "ssh-ed25519 AAAA" };
		const block = buildTrustBlock(defaultDraft(source));
		expect(block).toContain('name          = "laptop"');
		expect(block).toContain('role          = "user"');
		expect(block).toContain('kinds         = ["execute"]');
		expect(block).not.toContain("require_exact");
	});

	test("escapes TOML strings and never lets a value break the document", () => {
		const source: TrustKeySource = { kind: "ssh", name: 'a "b" \\c', publicKey: 'ssh-ed25519 AA"AA' };
		const block = buildTrustBlock(defaultDraft(source));
		expect(block).toContain('name          = "a \\"b\\" \\\\c"');
		expect(block).toContain('key           = "ssh-ed25519 AA\\"AA"');
		expect(block.split("\n").filter((line) => line.startsWith("[[trust]]"))).toHaveLength(1);
	});

	test("writes the webauthn fields and the unpadded base64url COSE key", () => {
		const source: TrustKeySource = {
			kind: "webauthn",
			name: "yubikey",
			rpId: "crh.example.com",
			origins: ["https://crh.example.com"],
			credentialId: "AAECAwQ",
			publicKey: "o2NmbXRkbm9uZQ+/",
		};
		const block = buildTrustBlock({ ...defaultDraft(source), requireUv: true, maxTtl: "" });
		expect(block).toContain('format        = "webauthn"');
		expect(block).toContain('rp_id         = "crh.example.com"');
		expect(block).toContain('origins       = ["https://crh.example.com"]');
		expect(block).toContain('credential_id = "AAECAwQ"');
		expect(block).toContain('key           = "cose:o2NmbXRkbm9uZQ-_"');
		expect(block).toContain("require_uv    = true");
		expect(block).not.toContain("max_ttl");
	});
});

describe("guard line parsing", () => {
	test("round trips the editor text", () => {
		const lines = [
			{ method: "exec" as const, prefix: "systemctl restart " },
			{ method: "file.read" as const, prefix: "/var/log/" },
		];
		expect(parseGuardLines(formatGuardLines(lines))).toEqual({ lines });
	});

	test("rejects an unknown method and a missing target", () => {
		expect(parseGuardLines("curl https://example.com")).toEqual({ error: "unknown-method" });
		expect(parseGuardLines("exec")).toEqual({ error: "missing-target" });
		expect(parseGuardLines("exec   ")).toEqual({ error: "missing-target" });
	});
});

describe("TrustEditor", () => {
	test("the preview follows the require-uv toggle", async () => {
		const source: TrustKeySource = { kind: "ssh", name: "laptop", publicKey: "ssh-ed25519 AAAA" };
		renderWithI18n(<TrustEditor sources={[source]} />);
		expect(screen.getByText(/role\s+= "user"/)).toBeInTheDocument();
		expect(screen.queryByText(/require_uv/)).not.toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole("checkbox", { name: "Require user verification" }));
		expect(screen.getByText(/require_uv\s+= true/)).toBeInTheDocument();
	});

	test("an invalid rule line is reported next to its field", async () => {
		const source: TrustKeySource = { kind: "ssh", name: "laptop", publicKey: "ssh-ed25519 AAAA" };
		renderWithI18n(<TrustEditor sources={[source]} />);
		const user = userEvent.setup();
		await user.clear(screen.getByLabelText("Allow"));
		await user.type(screen.getByLabelText("Allow"), "nope /bin/true");
		await screen.findByText("Each rule starts with exec, file.read or file.write.");
	});
});
