import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("applies defaults", () => {
		expect(parseConfig("")).toEqual({
			listen: { host: "127.0.0.1", port: 8080 },
			database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
			masterKeyFile: "/etc/crhs/master.key",
			webRoot: expect.stringMatching(/web\/dist$/),
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

	it("rejects unknown and misplaced keys", () => {
		expect(() => parseConfig('[database]\npath = "x"\nmaster_key_file = "y"\n')).toThrow(
			/unknown configuration key database.master_key_file/,
		);
		expect(() => parseConfig("listne = 1\n")).toThrow(/listne/);
	});
});
