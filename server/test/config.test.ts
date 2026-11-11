import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("applies defaults", () => {
		expect(parseConfig("")).toEqual({
			listen: { host: "127.0.0.1", port: 8080, realIpHeader: null },
			database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
			masterKeyFile: "/etc/crhs/master.key",
			webRoot: expect.stringMatching(/web\/dist$/),
			publicUrl: null,
			clockWarnMs: 60_000,
			webauthn: { rpId: null, rpName: "ClusterRightHand", origins: [] },
			retention: {
				tasksMs: 90 * 24 * 60 * 60 * 1000,
				auditMs: 180 * 24 * 60 * 60 * 1000,
				piTasksMs: 7 * 24 * 60 * 60 * 1000,
			},
			auth: { argon2Concurrency: 2, argon2Queue: 32, captcha: "cap" },
		});
	});

	it("reads the real-IP header and the auth table", () => {
		const config = parseConfig(
			'[listen]\nreal_ip_header = "X-Forwarded-For"\n[auth]\nargon2_concurrency = 1\nargon2_queue = 0\ncaptcha = "none"\n',
		);
		expect(config.listen.realIpHeader).toBe("X-Forwarded-For");
		expect(config.auth).toEqual({ argon2Concurrency: 1, argon2Queue: 0, captcha: "none" });
		expect(parseConfig('[listen]\nreal_ip_header = "X-Real-IP"\n').listen.realIpHeader).toBe("X-Real-IP");
	});

	it("rejects bad real-IP headers and auth values", () => {
		expect(() => parseConfig("[listen]\nreal_ip_header = 1\n")).toThrow(/listen\.real_ip_header/);
		expect(() => parseConfig('[listen]\nreal_ip_header = "X Forwarded For"\n')).toThrow(/listen\.real_ip_header/);
		expect(() => parseConfig('[listen]\nreal_ip_header = ""\n')).toThrow(/listen\.real_ip_header/);
		expect(() => parseConfig("[auth]\nargon2_concurrency = 0\n")).toThrow(/auth\.argon2_concurrency/);
		expect(() => parseConfig("[auth]\nargon2_concurrency = 1.5\n")).toThrow(/auth\.argon2_concurrency/);
		expect(() => parseConfig("[auth]\nargon2_queue = -1\n")).toThrow(/auth\.argon2_queue/);
		expect(() => parseConfig('[auth]\ncaptcha = "sometimes"\n')).toThrow(/auth\.captcha/);
		expect(() => parseConfig("[auth]\nunknown = 1\n")).toThrow(/unknown configuration key auth\.unknown/);
	});

	it("reads postgres settings", () => {
		const config = parseConfig('[database]\ndriver = "postgres"\nurl = "postgres://localhost/crh"\n');
		expect(config.database).toEqual({ driver: "postgres", url: "postgres://localhost/crh" });
	});

	it("rejects unknown drivers and bad ports", () => {
		expect(() => parseConfig('[database]\ndriver = "mysql"\n')).toThrow(/database.driver/);
		expect(() => parseConfig("[listen]\nport = 70000\n")).toThrow(/listen.port/);
		expect(() => parseConfig('[database]\ndriver = "postgres"\n')).toThrow(/database.url/);
	});

	it("reads the clock warning and the WebAuthn relying party", () => {
		expect(parseConfig('clock_warn = "90s"\n').clockWarnMs).toBe(90_000);
		expect(parseConfig('clock_warn = "0s"\n').clockWarnMs).toBe(0);
		expect(parseConfig('clock_warn = "1m30s"\n').clockWarnMs).toBe(90_000);
		expect(() => parseConfig("clock_warn = 90\n")).toThrow(/clock_warn/);
		expect(() => parseConfig('clock_warn = "90"\n')).toThrow(/clock_warn/);

		const webauthn = parseConfig(
			'[webauthn]\nrp_id = "crh.example.com"\nrp_name = "CRH"\norigins = ["https://crh.example.com"]\n',
		).webauthn;
		expect(webauthn).toEqual({
			rpId: "crh.example.com",
			rpName: "CRH",
			origins: ["https://crh.example.com"],
		});
		expect(() => parseConfig('[webauthn]\nrp_id = "crh.example.com"\n')).toThrow(/webauthn.origins/);
		expect(() => parseConfig('[webauthn]\nrp_id = "crh.example.com"\norigins = ["https://x/a"]\n')).toThrow(
			/webauthn.origins/,
		);
	});

	it("reads public_url and normalizes its trailing slash", () => {
		expect(parseConfig('public_url = "https://crh.example.com"\n').publicUrl).toBe("https://crh.example.com");
		expect(parseConfig('public_url = "https://crh.example.com/"\n').publicUrl).toBe("https://crh.example.com");
		expect(parseConfig('public_url = "https://crh.example.com/crh/"\n').publicUrl).toBe("https://crh.example.com/crh");
		expect(parseConfig('public_url = "http://127.0.0.1:8080"\n').publicUrl).toBe("http://127.0.0.1:8080");
	});

	it("rejects invalid public_url values", () => {
		for (const value of [
			'"crh.example.com"',
			'"/crh"',
			'"ftp://crh.example.com"',
			'"https://crh.example.com/?x=1"',
			'"https://crh.example.com/#x"',
			'""',
			"1",
		]) {
			expect(() => parseConfig(`public_url = ${value}\n`)).toThrow(/public_url/);
		}
	});

	it("reads the retention table with day units and off", () => {
		expect(parseConfig('[retention]\ntasks = "1d"\naudit = "1d12h"\npi_tasks = "3d"\n').retention).toEqual({
			tasksMs: 24 * 60 * 60 * 1000,
			auditMs: 36 * 60 * 60 * 1000,
			piTasksMs: 3 * 24 * 60 * 60 * 1000,
		});
		expect(parseConfig('[retention]\ntasks = "off"\naudit = "180d"\n').retention).toEqual({
			tasksMs: null,
			auditMs: 180 * 24 * 60 * 60 * 1000,
			piTasksMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(parseConfig('[retention]\naudit = "off"\npi_tasks = "off"\n').retention).toEqual({
			tasksMs: 90 * 24 * 60 * 60 * 1000,
			auditMs: null,
			piTasksMs: null,
		});
	});

	it("rejects retention below one day and unknown retention keys", () => {
		expect(() => parseConfig('[retention]\ntasks = "23h"\n')).toThrow(/retention\.tasks.*1d/);
		expect(() => parseConfig('[retention]\naudit = "0s"\n')).toThrow(/retention\.audit.*1d/);
		expect(() => parseConfig('[retention]\npi_tasks = "23h"\n')).toThrow(/retention\.pi_tasks.*1d/);
		expect(() => parseConfig('[retention]\ntasks = "90"\n')).toThrow(/retention\.tasks/);
		expect(() => parseConfig('[retention]\nkeep = "90d"\n')).toThrow(/unknown configuration key retention\.keep/);
	});

	it("rejects unknown and misplaced keys", () => {
		expect(() => parseConfig('[database]\npath = "x"\nmaster_key_file = "y"\n')).toThrow(
			/unknown configuration key database.master_key_file/,
		);
		expect(() => parseConfig("listne = 1\n")).toThrow(/listne/);
	});
});
