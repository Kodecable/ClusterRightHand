import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("applies defaults", () => {
		expect(parseConfig("")).toEqual({
			listen: { host: "127.0.0.1", port: 8080 },
			database: { driver: "sqlite", path: "/var/lib/crhs/crhs.db" },
			library: { backend: "local" },
			models: { catalogDownload: true },
			crhaRelease: {
				url: "https://github.com/Kodecable/ClusterRightHand",
				download: true,
				verify: true,
				github: { owner: "Kodecable", repo: "ClusterRightHand" },
			},
			masterKeyFile: "/etc/crhs/master.key",
			webRoot: expect.stringMatching(/web\/dist$/),
		});
	});

	it("reads the model catalogue switch", () => {
		expect(parseConfig("").models).toEqual({ catalogDownload: true });
		expect(parseConfig("[models]\ncatalog_download = false\n").models).toEqual({ catalogDownload: false });
		expect(parseConfig("[models]\ncatalog_download = true\n").models).toEqual({ catalogDownload: true });
		expect(() => parseConfig('[models]\ncatalog_download = "no"\n')).toThrow(/models\.catalog_download/);
		expect(() => parseConfig("[models]\nunknown = 1\n")).toThrow(/unknown configuration key models\.unknown/);
	});

	it("reads the crha release source", () => {
		expect(parseConfig('[crha_release]\nurl = "https://github.com/me/fork/"\n').crhaRelease).toEqual({
			url: "https://github.com/me/fork",
			download: true,
			verify: true,
			github: { owner: "me", repo: "fork" },
		});
		// Verification derives the Sigstore identity from a github.com repository, so it needs one.
		expect(() => parseConfig('[crha_release]\nurl = "https://mirror.example/crh"\n')).toThrow(
			/github\.com\/<owner>\/<repo>.*verify/,
		);
		expect(() => parseConfig('[crha_release]\nurl = "http://github.com/a/b"\n')).toThrow(/verify/);
		expect(() => parseConfig('[crha_release]\nurl = "https://github.com/a/b/c"\n')).toThrow(/verify/);
		expect(
			parseConfig('[crha_release]\nurl = "https://mirror.example/crh"\nverify = false\ndownload = false\n').crhaRelease,
		).toEqual({ url: "https://mirror.example/crh", download: false, verify: false, github: null });
		expect(() => parseConfig('[crha_release]\nurl = "ftp://x"\nverify = false\n')).toThrow(/http or https/);
		expect(() => parseConfig('[crha_release]\ndownload = "yes"\n')).toThrow(/crha_release\.download/);
		expect(() => parseConfig("[crha_release]\nmirror = 1\n")).toThrow(/crha_release\.mirror/);
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

	it("refuses the settings that live in System settings", () => {
		for (const text of [
			'public_url = "https://crh.example.com"\n',
			'clock_warn = "90s"\n',
			'[listen]\nreal_ip_header = "X-Real-IP"\n',
			'[retention]\ntasks = "30d"\n',
			'[webauthn]\nrp_name = "CRH"\n',
			'[auth]\ncaptcha = "none"\n',
		]) {
			expect(() => parseConfig(text), text).toThrow(/unknown configuration key/);
		}
	});

	it("rejects unknown and misplaced keys", () => {
		expect(() => parseConfig('[database]\npath = "x"\nmaster_key_file = "y"\n')).toThrow(
			/unknown configuration key database\.master_key_file/,
		);
		expect(() => parseConfig("listne = 1\n")).toThrow(/listne/);
	});
});
