/**
 * The crha release cache (doc/design/distribution.md "Fetching the release"): download and verification as
 * separate steps, condemned files downloaded again a bounded number of times, files the operator placed
 * never deleted, and the in-house tar reader. The Sigstore verifier itself is checked against a real
 * signed release when CRH_TEST_NETWORK is set; offline only its "cannot verify" path runs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrhaReleases, isReleaseVersion, MAX_REDOWNLOADS, parseChecksums } from "../src/cluster/crha-release.ts";
import {
	exactIdentity,
	GITHUB_ACTIONS_ISSUER,
	identityPattern,
	type ReleaseSignatureVerifier,
	releaseIdentity,
	type SignatureCheck,
	type SignatureInput,
	SigstoreVerifier,
} from "../src/cluster/release-signature.ts";
import type { CrhaReleaseConfig } from "../src/config.ts";
import { extractTarFile, TarError } from "../src/util/tar.ts";

const VERSION = "1.3.0";
const ARCH = "amd64";
const ARCHIVE = `crha-${VERSION}-linux-${ARCH}.tar.gz`;
const REPO = "https://github.com/o/r";
const BINARY = Buffer.from("\x7fELF crha 1.3.0 binary bytes");

const hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A gzipped tar of top-level directories, built with the system tar as scripts/package.ts does. */
async function makeArchive(dir: string, files: Record<string, Buffer>, extra: string[] = []): Promise<Buffer> {
	const src = await mkdtemp(join(dir, "src-"));
	for (const [name, data] of Object.entries(files)) {
		await mkdir(join(src, name, ".."), { recursive: true });
		await writeFile(join(src, name), data);
	}
	const tops = [...new Set(Object.keys(files).map((name) => name.split("/")[0] as string))];
	const tar = execFileSync("tar", ["-C", src, "--sort=name", "--owner=0", "--group=0", ...extra, "-cf", "-", ...tops]);
	return gzipSync(tar);
}

function config(overrides: Partial<CrhaReleaseConfig> = {}): CrhaReleaseConfig {
	return { url: REPO, download: true, verify: true, github: { owner: "o", repo: "r" }, ...overrides };
}

class FakeVerifier implements ReleaseSignatureVerifier {
	results: SignatureCheck[] = [];
	calls: SignatureInput[] = [];
	async verify(input: SignatureInput): Promise<SignatureCheck> {
		this.calls.push(input);
		return this.results.shift() ?? { kind: "ok" };
	}
}

describe("the crha release cache", () => {
	let dir: string;
	let archive: Buffer;
	let sums: Buffer;
	let served: Map<string, Buffer>;
	let requests: string[];
	let verifier: FakeVerifier;

	const fetchFake: typeof fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		const body = served.get(url);
		return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
	};
	const assetUrl = (name: string) => `${REPO}/releases/download/v${VERSION}/${name}`;
	const releases = (overrides: Partial<CrhaReleaseConfig> = {}, version = VERSION) =>
		new CrhaReleases({ dataDir: dir, config: config(overrides), version, fetch: fetchFake, verifier, log: () => {} });

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crha-release-"));
		archive = await makeArchive(dir, {
			[`crha-${VERSION}-linux-${ARCH}/crha`]: BINARY,
			[`crha-${VERSION}-linux-${ARCH}/VERSION`]: Buffer.from(VERSION),
		});
		sums = Buffer.from(
			`${hex(archive)}  ${ARCHIVE}\n${"0".repeat(64)}  crha-${VERSION}-linux-arm64.tar.gz\n${hex(BINARY)}  crha-${VERSION}-linux-${ARCH}/crha\n`,
		);
		served = new Map([
			[assetUrl(ARCHIVE), archive],
			[assetUrl("SHA256SUMS"), sums],
			[assetUrl("SHA256SUMS.sigstore.json"), Buffer.from("{}")],
		]);
		requests = [];
		verifier = new FakeVerifier();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("downloads, verifies and extracts the binary, then serves it from the cache", async () => {
		const store = releases();
		const binary = await store.binary(ARCH);
		expect(binary.bytes).toEqual(BINARY);
		expect(binary.sha256.toString("hex")).toBe(hex(BINARY));
		expect(verifier.calls[0]).toMatchObject({
			identityPattern: identityPattern({ owner: "o", repo: "r", tag: "v1.3.0" }),
			issuer: GITHUB_ACTIONS_ISSUER,
		});
		expect(requests).toHaveLength(3);
		// The cache holds the assets under their release names; the next call verifies again, without downloads.
		expect((await readdir(store.directory)).sort()).toEqual(["SHA256SUMS", "SHA256SUMS.sigstore.json", ARCHIVE]);
		await store.binary(ARCH);
		expect(requests).toHaveLength(3);
		expect(verifier.calls).toHaveLength(2);
	});

	it("shares one download and verification between concurrent callers", async () => {
		const store = releases();
		const [a, b] = await Promise.all([store.binary(ARCH), store.binary(ARCH)]);
		expect(a).toBe(b);
		expect(requests).toHaveLength(3);
		expect(verifier.calls).toHaveLength(1);
	});

	it("downloads SHA256SUMS and its bundle again after a bad signature", async () => {
		verifier.results = [{ kind: "invalid", reason: "bad signature" }];
		await releases().binary(ARCH);
		expect(requests.filter((url) => url.endsWith("/SHA256SUMS"))).toHaveLength(2);
		expect(requests.filter((url) => url.endsWith(ARCHIVE))).toHaveLength(1);
	});

	it("gives up after a bounded number of new downloads", async () => {
		verifier.results = Array.from({ length: MAX_REDOWNLOADS + 1 }, () => ({ kind: "invalid", reason: "bad" }) as const);
		await expect(releases().binary(ARCH)).rejects.toMatchObject({ code: "release_invalid" });
		expect(requests.filter((url) => url.endsWith("/SHA256SUMS"))).toHaveLength(MAX_REDOWNLOADS + 1);
	});

	it("deletes nothing when it cannot verify at all", async () => {
		const store = releases();
		verifier.results = [{ kind: "unverifiable", reason: "TUF unreachable" }];
		await expect(store.binary(ARCH)).rejects.toMatchObject({ code: "release_unverifiable" });
		expect((await readdir(store.directory)).sort()).toEqual(["SHA256SUMS", "SHA256SUMS.sigstore.json", ARCHIVE]);
	});

	it("downloads a corrupt archive again", async () => {
		const store = releases();
		await mkdir(store.directory, { recursive: true });
		await writeFile(join(store.directory, ARCHIVE), Buffer.from("corrupt"));
		const binary = await store.binary(ARCH);
		expect(binary.bytes).toEqual(BINARY);
		expect(requests.filter((url) => url.endsWith(ARCHIVE))).toHaveLength(1);
	});

	it("never deletes files the operator placed when downloads are off", async () => {
		const store = releases({ download: false });
		await mkdir(store.directory, { recursive: true });
		await writeFile(join(store.directory, ARCHIVE), Buffer.from("corrupt"));
		await writeFile(join(store.directory, "SHA256SUMS"), sums);
		await writeFile(join(store.directory, "SHA256SUMS.sigstore.json"), "{}");
		await expect(store.binary(ARCH)).rejects.toMatchObject({ code: "release_invalid" });
		expect(await readFile(join(store.directory, ARCHIVE), "utf8")).toBe("corrupt");
		expect(requests).toEqual([]);
	});

	it("names the path to copy a missing asset to when downloads are off", async () => {
		const store = releases({ download: false });
		await expect(store.binary(ARCH)).rejects.toThrow(store.directory);
	});

	it("without verification still checks SHA256SUMS when it is there", async () => {
		const store = releases({ verify: false });
		await mkdir(store.directory, { recursive: true });
		await writeFile(join(store.directory, ARCHIVE), archive);
		await writeFile(join(store.directory, "SHA256SUMS"), Buffer.from(`${"1".repeat(64)}  ${ARCHIVE}\n`));
		// The listed hash does not match. An unsigned list may be the wrong file as much as the archive: both
		// are downloaded again, and the release's own list matches.
		expect((await store.binary(ARCH)).bytes).toEqual(BINARY);
		expect(requests.filter((url) => url.endsWith("/SHA256SUMS"))).toHaveLength(1);
		// A release whose list never matches is refused.
		served.set(assetUrl("SHA256SUMS"), Buffer.from(`${"1".repeat(64)}  ${ARCHIVE}\n`));
		await rm(join(store.directory, "SHA256SUMS"));
		await expect(store.binary(ARCH)).rejects.toMatchObject({ code: "release_invalid" });
		expect(verifier.calls).toEqual([]);
	});

	it("lets architectures take turns, since they share SHA256SUMS", async () => {
		const arm = await makeArchive(dir, { [`crha-${VERSION}-linux-arm64/crha`]: BINARY });
		const armSums = Buffer.from(
			`${hex(archive)}  ${ARCHIVE}\n${hex(arm)}  crha-${VERSION}-linux-arm64.tar.gz\n${hex(BINARY)}  crha-${VERSION}-linux-${ARCH}/crha\n${hex(BINARY)}  crha-${VERSION}-linux-arm64/crha\n`,
		);
		served.set(assetUrl("SHA256SUMS"), armSums);
		served.set(assetUrl(`crha-${VERSION}-linux-arm64.tar.gz`), arm);
		// The first verification fails: SHA256SUMS is condemned and downloaded again while the other
		// architecture would read it.
		verifier.results = [{ kind: "invalid", reason: "bad signature" }];
		const store = releases();
		const [a, b] = await Promise.all([store.binary(ARCH), store.binary("arm64")]);
		expect(a.bytes).toEqual(BINARY);
		expect(b.bytes).toEqual(BINARY);
	});

	it("without verification and without SHA256SUMS uses the archive as is", async () => {
		served.delete(assetUrl("SHA256SUMS"));
		const binary = await releases({ verify: false }).binary(ARCH);
		expect(binary.bytes).toEqual(BINARY);
		expect(verifier.calls).toEqual([]);
	});

	it("fails without deleting when SHA256SUMS lists no archive for the architecture", async () => {
		served.set(assetUrl("crha-1.3.0-linux-riscv64.tar.gz"), archive);
		await expect(releases().binary("riscv64")).rejects.toMatchObject({ code: "release_no_arch" });
	});

	it("checks the binary against its own line in SHA256SUMS, the hash a signer compares", async () => {
		const withSums = (text: string) => served.set(assetUrl("SHA256SUMS"), Buffer.from(text));
		withSums(`${hex(archive)}  ${ARCHIVE}\n${"1".repeat(64)}  crha-${VERSION}-linux-${ARCH}/crha\n`);
		await expect(releases().binary(ARCH)).rejects.toMatchObject({
			code: "release_invalid",
			message: expect.stringMatching(/crha has sha256/),
		});
		await rm(join(dir, "crha-releases"), { recursive: true, force: true });
		withSums(`${hex(archive)}  ${ARCHIVE}\n`);
		await expect(releases().binary(ARCH)).rejects.toMatchObject({
			code: "release_invalid",
			message: expect.stringMatching(/lists no crha-1\.3\.0-linux-amd64\/crha/),
		});
	});

	it("reports a missing release asset; a missing archive is an architecture the release lacks", async () => {
		served.delete(assetUrl(ARCHIVE));
		await expect(releases().binary(ARCH)).rejects.toMatchObject({ code: "release_no_arch" });
		served.set(assetUrl(ARCHIVE), archive);
		served.delete(assetUrl("SHA256SUMS"));
		await expect(releases().binary(ARCH)).rejects.toMatchObject({ code: "release_unavailable" });
	});

	it("refuses a version that is not a release", async () => {
		await expect(releases({}, "dev").binary(ARCH)).rejects.toMatchObject({ code: "release_not_a_release" });
		// A `git describe` version keeps the tag's "v", so it never looks like a release.
		await expect(releases({}, "v1.3.0-4-gabcdef-dirty").binary(ARCH)).rejects.toMatchObject({
			code: "release_not_a_release",
		});
		expect(isReleaseVersion("1.3.0")).toBe(true);
		expect(isReleaseVersion("1.3.0-rc.1")).toBe(true);
		expect(isReleaseVersion("dev")).toBe(false);
		expect(isReleaseVersion("v1.3.0")).toBe(false);
		expect(isReleaseVersion("01.3.0")).toBe(false);
	});

	it("removes other versions from the cache", async () => {
		const store = releases();
		await mkdir(join(dir, "crha-releases", "1.2.0"), { recursive: true });
		await mkdir(store.directory, { recursive: true });
		await store.removeOtherVersions();
		expect(await readdir(join(dir, "crha-releases"))).toEqual([VERSION]);
	});

	it("parses sha256sum lines", () => {
		const parsed = parseChecksums(Buffer.from(`${"A".repeat(64)} *bin.tar.gz\n${"b".repeat(64)}  x\nnot a line\n`));
		expect(parsed.get("bin.tar.gz")).toBe("a".repeat(64));
		expect(parsed.get("x")).toBe("b".repeat(64));
		expect(parsed.size).toBe(2);
	});
});

describe("the tar reader", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crha-tar-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const limits = { archiveBytes: 1 << 20, fileBytes: 1 << 20 };

	it("finds a file in a GNU tar, with a long name, and in a pax tar", async () => {
		const long = `top/${"d".repeat(120)}/crha`;
		for (const format of ["gnu", "pax"]) {
			const archive = await makeArchive(dir, { "top/crha": BINARY, [long]: Buffer.from("long") }, [
				`--format=${format}`,
			]);
			expect(await extractTarFile(archive, "top/crha", limits)).toEqual(BINARY);
			expect((await extractTarFile(archive, long, limits)).toString()).toBe("long");
			// `tar -C dir .` writes "./" before every name; it names the same file.
			expect(await extractTarFile(archive, "./top/crha", limits)).toEqual(BINARY);
		}
	});

	it("reads a pax path with multi-byte characters, whose record length counts bytes", async () => {
		const name = `top/${"é".repeat(60)}/${"中".repeat(30)}/crha`;
		const archive = await makeArchive(dir, { [name]: Buffer.from("wide"), "top/after": Buffer.from("after") }, [
			"--format=pax",
		]);
		expect((await extractTarFile(archive, name, limits)).toString()).toBe("wide");
		expect((await extractTarFile(archive, "top/after", limits)).toString()).toBe("after");
	});

	it("rejects what it cannot use", async () => {
		const archive = await makeArchive(dir, { "top/crha": BINARY });
		await expect(extractTarFile(archive, "top/missing", limits)).rejects.toThrow(TarError);
		await expect(extractTarFile(archive, "top", limits)).rejects.toThrow(/not a regular file/);
		await expect(extractTarFile(archive, "top/crha", { archiveBytes: 1 << 20, fileBytes: 4 })).rejects.toThrow(
			/larger/,
		);
		await expect(extractTarFile(Buffer.from("not gzip"), "x", limits)).rejects.toThrow(/gzip/);
		const tampered = gzipSync(Buffer.from(execFileSync("tar", ["-C", dir, "-cf", "-", "."])).fill(7, 0, 4));
		await expect(extractTarFile(tampered, "x", limits)).rejects.toThrow(/checksum/);
	});
});

describe("the Sigstore verifier", () => {
	it("matches the release identity exactly, owner and repository in any case", () => {
		const release = { owner: "Kodecable", repo: "ClusterRightHand", tag: "v1.2.3" };
		const identity = releaseIdentity(release);
		const pattern = identityPattern({ ...release, owner: "kodecable", repo: "clusterrighthand" });
		expect(identity.match(pattern)).not.toBeNull();
		expect(identity.match(identityPattern(release))).not.toBeNull();
		for (const other of [
			releaseIdentity({ ...release, tag: "v1.2.30" }),
			releaseIdentity({ ...release, tag: "v1.2.3-rc.1" }),
			releaseIdentity({ ...release, tag: "V1.2.3" }),
			releaseIdentity({ ...release, repo: "ClusterRightHand2" }),
			identity.replace("release.yml", "release-yml"),
			identity.replace("release.yml", "Release.yml"),
			`x${identity}`,
		]) {
			expect(other.match(pattern)).toBeNull();
		}
	});

	const fixtures = new URL("./fixtures/sigstore/", import.meta.url);
	// cosign's own release, signed by its release service account: a real bundle of the same shape.
	const identity = "keyless@projectsigstore.iam.gserviceaccount.com";
	const issuer = "https://accounts.google.com";

	it("cannot verify, and says so, when the TUF repository is unreachable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "crha-tuf-"));
		try {
			const verifier = new SigstoreVerifier({
				tufDir: dir,
				fetch: async () => {
					throw new Error("network down");
				},
			});
			const result = await verifier.verify({
				artifact: Buffer.from("x"),
				bundle: Buffer.from("{}"),
				identityPattern: exactIdentity(identity),
				issuer,
			});
			expect(result).toMatchObject({ kind: "unverifiable" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!process.env.CRH_TEST_NETWORK)(
		"verifies a real release and rejects tampering and a wrong identity",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "crha-tuf-"));
			try {
				const verifier = new SigstoreVerifier({ tufDir: dir });
				const artifact = await readFile(new URL("cosign_checksums.txt", fixtures));
				const bundle = await readFile(new URL("cosign_checksums.txt.sigstore.json", fixtures));
				expect(await verifier.verify({ artifact, bundle, identityPattern: exactIdentity(identity), issuer })).toEqual({
					kind: "ok",
				});
				const tampered = Buffer.from(artifact);
				tampered[0] = (tampered[0] ?? 0) ^ 1;
				expect(
					await verifier.verify({ artifact: tampered, bundle, identityPattern: exactIdentity(identity), issuer }),
				).toMatchObject({
					kind: "invalid",
				});
				expect(
					await verifier.verify({ artifact, bundle, identityPattern: exactIdentity(`${identity}x`), issuer }),
				).toMatchObject({
					kind: "invalid",
				});
				// A part of the identity is not the identity.
				expect(
					await verifier.verify({ artifact, bundle, identityPattern: exactIdentity(identity.slice(0, -4)), issuer }),
				).toMatchObject({
					kind: "invalid",
				});
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
