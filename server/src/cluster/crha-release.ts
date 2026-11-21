/**
 * The crha releases crhs upgrades nodes to (doc/design/distribution.md "Fetching the release"): crhs's own
 * version only, downloaded when needed into `<data>/crha-releases/<version>/` under the release's asset
 * names, and verified every time a binary is about to be sent.
 *
 * Downloading and verifying are separate steps, run once per version and architecture however many
 * callers wait (single flight). A definite failure (a bad signature, a hash mismatch, a malformed file)
 * deletes the files it condemns and downloads them again, a bounded number of times; a failure to verify
 * at all deletes nothing. With `download = false` nothing is ever deleted: the operator placed the files.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CrhaReleaseConfig } from "../config.ts";
import { errorText, UserError } from "../util/errors.ts";
import { isReleaseVersion } from "../util/release-version.ts";
import { extractTarFile, TarError } from "../util/tar.ts";
import {
	GITHUB_ACTIONS_ISSUER,
	type ReleaseSignatureVerifier,
	releaseIdentity,
	SigstoreVerifier,
} from "./release-signature.ts";

/** The directory below crhs's data directory that holds the release cache. */
export const RELEASE_CACHE_DIR = "crha-releases";
/** The files of one asset may be at most this large. */
const LIMITS = {
	archive: 128 * 1024 * 1024,
	checksums: 1024 * 1024,
	bundle: 1024 * 1024,
	/** The uncompressed archive. */
	unpacked: 256 * 1024 * 1024,
	binary: 128 * 1024 * 1024,
};
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A definite verification failure downloads the condemned files again at most this many times. */
export const MAX_REDOWNLOADS = 2;

export { isReleaseVersion } from "../util/release-version.ts";

/** The release assets of crha `version` for `arch`. */
export function releaseAssets(version: string, arch: string): { archive: string; checksums: string; bundle: string } {
	return {
		archive: `crha-${version}-linux-${arch}.tar.gz`,
		checksums: "SHA256SUMS",
		bundle: "SHA256SUMS.sigstore.json",
	};
}

export type ReleaseErrorCode =
	| "release_not_a_release"
	| "release_unavailable"
	| "release_unverifiable"
	| "release_invalid"
	| "release_no_arch";

/** A release that cannot be used; the message says what to do. */
export class ReleaseError extends UserError {
	override name = "ReleaseError";
	declare readonly code: ReleaseErrorCode;

	constructor(code: ReleaseErrorCode, message: string) {
		super(message, code);
	}
}

/** The crha binary of one release and architecture, verified as configured. */
export interface CrhaBinary {
	version: string;
	arch: string;
	bytes: Buffer;
	sha256: Buffer;
}

export interface CrhaReleasesOptions {
	/** crhs's data directory; the cache is `<dataDir>/crha-releases`. */
	dataDir: string;
	config: CrhaReleaseConfig;
	/** crhs's version: the only release it fetches. */
	version: string;
	/** The fetch for downloads; the wrapped global fetch by default. */
	fetch?: typeof fetch;
	/** The signature verifier; Sigstore with the TUF metadata in the data directory by default. */
	verifier?: ReleaseSignatureVerifier;
	log?: (message: string) => void;
}

type Asset = "archive" | "checksums" | "bundle";

/** A verification step's outcome: usable, condemned files to fetch again, or a failure that deletes nothing. */
type Check =
	| { kind: "ok"; bytes: Buffer }
	| { kind: "condemn"; assets: Asset[]; reason: string }
	| { kind: "fail"; error: ReleaseError };

class HttpStatusError extends Error {
	readonly status: number;

	constructor(url: string, status: number) {
		super(`GET ${url}: HTTP ${status}`);
		this.status = status;
	}
}

export class CrhaReleases {
	readonly #dataDir: string;
	readonly #config: CrhaReleaseConfig;
	readonly #version: string;
	readonly #fetch: typeof fetch;
	readonly #verifier: ReleaseSignatureVerifier;
	readonly #log: (message: string) => void;
	readonly #flights = new Map<string, Promise<CrhaBinary>>();

	constructor(options: CrhaReleasesOptions) {
		this.#dataDir = options.dataDir;
		this.#config = options.config;
		this.#version = options.version;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#verifier =
			options.verifier ?? new SigstoreVerifier({ tufDir: join(options.dataDir, "sigstore-tuf"), fetch: this.#fetch });
		this.#log = options.log ?? ((message) => console.warn(message));
	}

	get version(): string {
		return this.#version;
	}

	/** The cache directory of this crhs's version; the operator copies the assets here when downloads are off. */
	get directory(): string {
		return join(this.#dataDir, RELEASE_CACHE_DIR, this.#version);
	}

	/** Removes the cached releases of other versions (at startup). */
	async removeOtherVersions(): Promise<void> {
		const root = join(this.#dataDir, RELEASE_CACHE_DIR);
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			return;
		}
		await Promise.all(
			entries
				.filter((entry) => entry !== this.#version)
				.map((entry) => rm(join(root, entry), { recursive: true, force: true })),
		);
	}

	/**
	 * The verified crha binary for `arch`. Callers waiting on the same architecture share one download and
	 * one verification; the next call verifies again.
	 */
	binary(arch: string): Promise<CrhaBinary> {
		const key = arch;
		const running = this.#flights.get(key);
		if (running) return running;
		const flight = this.#resolve(arch).finally(() => this.#flights.delete(key));
		this.#flights.set(key, flight);
		return flight;
	}

	async #resolve(arch: string): Promise<CrhaBinary> {
		if (!/^[a-z0-9_]+$/.test(arch)) throw new ReleaseError("release_no_arch", `unknown architecture ${arch}`);
		if (!isReleaseVersion(this.#version)) {
			throw new ReleaseError(
				"release_not_a_release",
				`crhs ${this.#version} is not a release version, so there is no crha release to fetch; turn ` +
					`crha_release.verify off and copy the crha archive to ${this.directory}`,
			);
		}
		const assets = releaseAssets(this.#version, arch);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		let lastReason = "";
		for (let attempt = 0; attempt <= MAX_REDOWNLOADS; attempt++) {
			await this.#downloadMissing(assets);
			const check = await this.#check(assets);
			if (check.kind === "ok") {
				return {
					version: this.#version,
					arch,
					bytes: check.bytes,
					sha256: createHash("sha256").update(check.bytes).digest(),
				};
			}
			if (check.kind === "fail") throw check.error;
			lastReason = check.reason;
			if (!this.#config.download) {
				// The operator placed these files; they are never deleted.
				throw new ReleaseError("release_invalid", `${check.reason}; replace the files in ${this.directory}`);
			}
			this.#log(`crha release ${this.#version}: ${check.reason}; downloading ${check.assets.join(", ")} again`);
			await Promise.all(check.assets.map((asset) => rm(join(this.directory, assets[asset]), { force: true })));
		}
		throw new ReleaseError(
			"release_invalid",
			`${lastReason} after ${MAX_REDOWNLOADS} new downloads; the release is broken or the download is tampered with`,
		);
	}

	async #exists(name: string): Promise<boolean> {
		try {
			return (await stat(join(this.directory, name))).isFile();
		} catch {
			return false;
		}
	}

	/** Downloads every missing asset the configuration needs; `SHA256SUMS` is optional without verification. */
	async #downloadMissing(assets: Record<Asset, string>): Promise<void> {
		const needed: { asset: Asset; required: boolean }[] = [
			{ asset: "archive", required: true },
			{ asset: "checksums", required: this.#config.verify },
			{ asset: "bundle", required: this.#config.verify },
		];
		for (const { asset, required } of needed) {
			const name = assets[asset];
			if (await this.#exists(name)) continue;
			if (!this.#config.download) {
				if (!required) continue;
				throw new ReleaseError(
					"release_unavailable",
					`${name} is missing and crha_release.download is off; copy it to ${this.directory}`,
				);
			}
			const url = `${this.#config.url}/releases/download/v${this.#version}/${name}`;
			try {
				await this.#download(url, join(this.directory, name), LIMITS[asset]);
			} catch (err) {
				if (!required && err instanceof HttpStatusError && err.status === 404) continue;
				throw new ReleaseError(
					"release_unavailable",
					err instanceof HttpStatusError && err.status === 404
						? `the release v${this.#version} at ${this.#config.url} has no ${name}`
						: `cannot download ${url}: ${errorText(err)}`,
				);
			}
		}
	}

	async #download(url: string, path: string, limit: number): Promise<void> {
		const response = await this.#fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) throw new HttpStatusError(url, response.status);
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > limit) throw new Error(`${declared} bytes is more than ${limit}`);
		// Streamed to a file of its own, so a body past the limit is never held whole, and two
		// architectures that fetch the shared SHA256SUMS at once never write the same temporary file.
		const temp = `${path}.${randomUUID()}.tmp`;
		const file = await open(temp, "wx", 0o600);
		let closed = false;
		try {
			let received = 0;
			for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
				received += chunk.byteLength;
				if (received > limit) throw new Error(`more than ${limit} bytes`);
				await file.write(chunk);
			}
			await file.close();
			closed = true;
			await rename(temp, path);
		} finally {
			if (!closed) await file.close();
			await rm(temp, { force: true });
		}
	}

	async #read(name: string, limit: number): Promise<Buffer | undefined> {
		const path = join(this.directory, name);
		try {
			if ((await stat(path)).size > limit) return Buffer.alloc(limit + 1);
			return await readFile(path);
		} catch {
			return undefined;
		}
	}

	/** Verifies the cached assets and extracts the binary. */
	async #check(assets: Record<Asset, string>): Promise<Check> {
		const archive = await this.#read(assets.archive, LIMITS.archive);
		if (archive === undefined) {
			return {
				kind: "fail",
				error: new ReleaseError("release_unavailable", `${assets.archive} is missing from ${this.directory}`),
			};
		}
		if (archive.length > LIMITS.archive) {
			return {
				kind: "condemn",
				assets: ["archive"],
				reason: `${assets.archive} is larger than ${LIMITS.archive} bytes`,
			};
		}
		const checksums = await this.#read(assets.checksums, LIMITS.checksums);
		if (this.#config.verify) {
			const bundle = await this.#read(assets.bundle, LIMITS.bundle);
			if (checksums === undefined || bundle === undefined) {
				return {
					kind: "fail",
					error: new ReleaseError("release_unavailable", `SHA256SUMS or its bundle is missing from ${this.directory}`),
				};
			}
			const github = this.#config.github;
			if (github === null) {
				return {
					kind: "fail",
					error: new ReleaseError("release_unverifiable", "crha_release.url is not a github.com repository"),
				};
			}
			const result = await this.#verifier.verify({
				artifact: checksums,
				bundle,
				identity: releaseIdentity(github.owner, github.repo, `v${this.#version}`),
				issuer: GITHUB_ACTIONS_ISSUER,
			});
			if (result.kind === "unverifiable") {
				return {
					kind: "fail",
					error: new ReleaseError(
						"release_unverifiable",
						`${result.reason}; verification needs GitHub and the Sigstore TUF repository, or turn crha_release.verify off`,
					),
				};
			}
			if (result.kind === "invalid") return { kind: "condemn", assets: ["checksums", "bundle"], reason: result.reason };
		}
		if (checksums !== undefined) {
			const listed = parseChecksums(checksums).get(assets.archive);
			if (listed === undefined) {
				return {
					kind: "fail",
					error: new ReleaseError("release_no_arch", `SHA256SUMS of v${this.#version} lists no ${assets.archive}`),
				};
			}
			const actual = createHash("sha256").update(archive).digest("hex");
			if (actual !== listed) {
				return {
					kind: "condemn",
					assets: ["archive"],
					reason: `${assets.archive} has sha256 ${actual}, SHA256SUMS lists ${listed}`,
				};
			}
		}
		const top = assets.archive.slice(0, -".tar.gz".length);
		const binaryName = `${top}/crha`;
		let bytes: Buffer;
		try {
			bytes = await extractTarFile(archive, binaryName, {
				archiveBytes: LIMITS.unpacked,
				fileBytes: LIMITS.binary,
			});
		} catch (err) {
			if (!(err instanceof TarError)) throw err;
			// A listed hash proves these are the release's bytes, so downloading them again cannot help.
			if (checksums !== undefined) {
				return {
					kind: "fail",
					error: new ReleaseError("release_invalid", `${assets.archive} of the release is unusable: ${err.message}`),
				};
			}
			return { kind: "condemn", assets: ["archive"], reason: `${assets.archive} is unusable: ${err.message}` };
		}
		// SHA256SUMS also lists the binary, under its path in the archive: the hash an authorization binds,
		// which a signer compares with the release. A signed list that disagrees with its own archive is a
		// broken release, which no download repairs.
		if (checksums !== undefined) {
			const listed = parseChecksums(checksums).get(binaryName);
			const actual = createHash("sha256").update(bytes).digest("hex");
			if (listed === undefined ? this.#config.verify : actual !== listed) {
				return {
					kind: "fail",
					error: new ReleaseError(
						"release_invalid",
						listed === undefined
							? `SHA256SUMS of v${this.#version} lists no ${binaryName}`
							: `${binaryName} has sha256 ${actual}, SHA256SUMS lists ${listed}`,
					),
				};
			}
		}
		return { kind: "ok", bytes };
	}
}

/** The `sha256sum` lines of a SHA256SUMS file: name → lowercase hex digest. Malformed lines are skipped. */
export function parseChecksums(data: Uint8Array): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of Buffer.from(data).toString("utf8").split("\n")) {
		const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trimEnd());
		if (match?.[1] && match[2]) out.set(match[2], match[1].toLowerCase());
	}
	return out;
}
