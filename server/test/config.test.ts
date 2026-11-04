import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("applies defaults", () => {
		expect(parseConfig("")).toEqual({
			listen: { host: "127.0.0.1", port: 8080 },
			database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
			masterKeyFile: "/etc/crhs/master.key",
			webRoot: expect.stringMatching(/web\/dist$/),
			clockWarnMs: 60_000,
			webauthn: { rpId: null, rpName: "ClusterRightHand", origins: [] },
			retention: {
				tasksMs: 90 * 24 * 60 * 60 * 1000,
				auditMs: 180 * 24 * 60 * 60 * 1000,
				piTasksMs: 7 * 24 * 60 * 60 * 1000,
			},
		});
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
