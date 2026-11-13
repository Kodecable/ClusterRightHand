import { describe, expect, it } from "vitest";
import { parseConfig, parseConfigFile } from "../src/config.ts";

describe("parseConfigFile", () => {
	it("applies defaults", () => {
		expect(parseConfig("")).toEqual({
			listen: { host: "127.0.0.1", port: 8080 },
			database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
			library: { backend: "local" },
			masterKeyFile: "/etc/crhs/master.key",
			webRoot: expect.stringMatching(/web\/dist$/),
		});
		expect(parseConfigFile("").moved).toEqual({});
	});

	it("reads the library backend", () => {
		expect(parseConfig("").library).toEqual({ backend: "local" });
		expect(parseConfig('[library]\nbackend = "local"\n').library).toEqual({ backend: "local" });
		expect(
			parseConfig(
				'[library]\nbackend = "webdav"\nurl = "https://dav.example.com/crhs/"\nusername = "crhs"\npassword = "secret"\n',
			).library,
		).toEqual({ backend: "webdav", url: "https://dav.example.com/crhs/", username: "crhs", password: "secret" });
		expect(() => parseConfig('[library]\nbackend = "s3"\n')).toThrow(/library\.backend/);
		expect(() => parseConfig('[library]\nbackend = "webdav"\nusername = "crhs"\npassword = "x"\n')).toThrow(
			/library\.url/,
		);
		expect(() => parseConfig('[library]\nbackend = "local"\nurl = "https://x"\n')).toThrow(/webdav backend/);
	});

	it("reads the listen address and the database settings", () => {
		const config = parseConfig(
			'[listen]\nhost = "0.0.0.0"\nport = 9000\n[database]\ndriver = "postgres"\nurl = "postgres://localhost/crh"\n',
		);
		expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
		expect(config.database).toEqual({ driver: "postgres", url: "postgres://localhost/crh" });
	});

	it("rejects unknown drivers and bad ports", () => {
		expect(() => parseConfig('[database]\ndriver = "mysql"\n')).toThrow(/database.driver/);
		expect(() => parseConfig("[listen]\nport = 70000\n")).toThrow(/listen.port/);
		expect(() => parseConfig('[database]\ndriver = "postgres"\n')).toThrow(/database.url/);
	});

	it("returns moved keys separately and keeps them out of Config", () => {
		const { config, moved } = parseConfigFile(
			[
				'public_url = "https://crh.example.com/"',
				'clock_warn = "1m30s"',
				"[listen]",
				'real_ip_header = "X-Forwarded-For"',
				"[retention]",
				'tasks = "30d"',
				'audit = "off"',
				"[webauthn]",
				'rp_id = "crh.example.com"',
				'rp_name = "CRH"',
				'origins = ["https://crh.example.com"]',
				"[auth]",
				'captcha = "none"',
				"argon2_concurrency = 1",
				"argon2_queue = 0",
				"",
			].join("\n"),
		);
		expect(config).not.toHaveProperty("publicUrl");
		expect(config).not.toHaveProperty("clockWarnMs");
		expect(config.listen).not.toHaveProperty("realIpHeader");
		expect(moved).toEqual({
			publicUrl: "https://crh.example.com",
			clockWarn: "1m30s",
			realIpHeader: "X-Forwarded-For",
			retention: { tasks: "30d", audit: "off" },
			webauthn: { rpId: "crh.example.com", rpName: "CRH", origins: ["https://crh.example.com"] },
			auth: { captcha: "none", argon2Concurrency: 1, argon2Queue: 0 },
		});
	});

	it("rejects bad real-IP headers", () => {
		expect(() => parseConfig("[listen]\nreal_ip_header = 1\n")).toThrow(/listen\.real_ip_header/);
		expect(() => parseConfig('[listen]\nreal_ip_header = "X Forwarded For"\n')).toThrow(/listen\.real_ip_header/);
		expect(() => parseConfig('[listen]\nreal_ip_header = ""\n')).toThrow(/listen\.real_ip_header/);
		expect(parseConfigFile('[listen]\nreal_ip_header = "X-Real-IP"\n').moved.realIpHeader).toBe("X-Real-IP");
	});

	it("rejects bad auth values", () => {
		expect(() => parseConfig("[auth]\nargon2_concurrency = 0\n")).toThrow(/auth\.argon2_concurrency/);
		expect(() => parseConfig("[auth]\nargon2_concurrency = 1.5\n")).toThrow(/auth\.argon2_concurrency/);
		expect(() => parseConfig("[auth]\nargon2_queue = -1\n")).toThrow(/auth\.argon2_queue/);
		expect(() => parseConfig('[auth]\ncaptcha = "sometimes"\n')).toThrow(/auth\.captcha/);
		expect(() => parseConfig("[auth]\nunknown = 1\n")).toThrow(/unknown configuration key auth\.unknown/);
	});

	it("reads the clock warning", () => {
		expect(parseConfigFile('clock_warn = "90s"\n').moved.clockWarn).toBe("90s");
		expect(parseConfigFile('clock_warn = "0s"\n').moved.clockWarn).toBe("0s");
		const { moved } = parseConfigFile('clock_warn = "1m30s"\n');
		expect(moved.clockWarn).toBe("1m30s");
		expect(() => parseConfig("clock_warn = 90\n")).toThrow(/clock_warn/);
		expect(() => parseConfig('clock_warn = "90"\n')).toThrow(/clock_warn/);
	});

	it("reads the WebAuthn relying party", () => {
		const moved = parseConfigFile(
			'[webauthn]\nrp_id = "crh.example.com"\nrp_name = "CRH"\norigins = ["https://crh.example.com"]\n',
		).moved.webauthn;
		expect(moved).toEqual({
			rpId: "crh.example.com",
			rpName: "CRH",
			origins: ["https://crh.example.com"],
		});
		expect(() => parseConfig('[webauthn]\nrp_id = "crh.example.com"\n')).toThrow(/webauthn.origins/);
		expect(() => parseConfig('[webauthn]\nrp_id = "crh.example.com"\norigins = ["https://x/a"]\n')).toThrow(
			/webauthn.origins/,
		);
		expect(() => parseConfig('[webauthn]\norigins = ["https://x"]\n')).toThrow(/webauthn.rp_id/);
	});

	it("reads public_url and normalizes its trailing slash", () => {
		expect(parseConfigFile('public_url = "https://crh.example.com"\n').moved.publicUrl).toBe("https://crh.example.com");
		expect(parseConfigFile('public_url = "https://crh.example.com/"\n').moved.publicUrl).toBe(
			"https://crh.example.com",
		);
		expect(parseConfigFile('public_url = "https://crh.example.com/crh/"\n').moved.publicUrl).toBe(
			"https://crh.example.com/crh",
		);
		expect(parseConfigFile('public_url = "http://127.0.0.1:8080"\n').moved.publicUrl).toBe("http://127.0.0.1:8080");
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
		expect(parseConfigFile('[retention]\ntasks = "1d"\naudit = "1d12h"\npi_tasks = "3d"\n').moved.retention).toEqual({
			tasks: "1d",
			audit: "1d12h",
			piTasks: "3d",
		});
		expect(parseConfigFile('[retention]\ntasks = "off"\naudit = "180d"\n').moved.retention).toEqual({
			tasks: "off",
			audit: "180d",
		});
		expect(parseConfigFile('[retention]\naudit = "off"\npi_tasks = "off"\n').moved.retention).toEqual({
			audit: "off",
			piTasks: "off",
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
			/unknown configuration key database\.master_key_file/,
		);
		expect(() => parseConfig("listne = 1\n")).toThrow(/listne/);
	});
});
