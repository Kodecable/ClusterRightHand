/**
 * Verifies the Sigstore signature of a crha release's SHA256SUMS (doc/design/distribution.md "Fetching the
 * release"). The trusted root comes from Sigstore's TUF repository, refreshed on every verification through
 * crhs's own fetch (so it carries crhs's User-Agent); a refresh that fails is never replaced by a bundled
 * or cached root, so a host that cannot reach the repository must turn verification off.
 *
 * A result tells a signature that is wrong (`invalid`: the files are condemned) from one that could not be
 * checked at all (`unverifiable`: the network or TUF failed, which proves nothing about the files).
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import seeds from "@sigstore/tuf/seeds.json" with { type: "json" };
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { BaseFetcher, Updater } from "tuf-js";
// tuf-js tells "no newer root" (403/404) apart from a failure only through this error type, which its
// index does not export.
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { errorText } from "../util/errors.ts";
import { escapeRegExp } from "../util/regex.ts";

/** Sigstore's public-good TUF repository, whose seed root ships with @sigstore/tuf. */
export const SIGSTORE_TUF_URL = "https://tuf-repo-cdn.sigstore.dev";
/** The OIDC issuer of GitHub Actions, which signs a release workflow's keyless certificate. */
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
/** One TUF request gives up after this long. */
const TUF_TIMEOUT_MS = 20_000;

export type SignatureCheck =
	| { kind: "ok" }
	| { kind: "invalid"; reason: string }
	| { kind: "unverifiable"; reason: string };

export interface SignatureInput {
	/** The signed bytes: the release's SHA256SUMS. */
	artifact: Uint8Array;
	/** The Sigstore bundle (`SHA256SUMS.sigstore.json`). */
	bundle: Uint8Array;
	/**
	 * The pattern the certificate's subject alternative name must match, anchored: identityPattern for a
	 * release, exactIdentity for one fixed name.
	 */
	identityPattern: string;
	issuer: string;
}

export interface ReleaseSignatureVerifier {
	verify(input: SignatureInput): Promise<SignatureCheck>;
}

/** The repository and tag of a release. */
export interface ReleaseIdentity {
	owner: string;
	repo: string;
	tag: string;
}

/** The workflow identity a release is signed with (doc/design/distribution.md), as GitHub spells it. */
export function releaseIdentity(id: ReleaseIdentity): string {
	return `https://github.com/${id.owner}/${id.repo}/.github/workflows/release.yml@refs/tags/${id.tag}`;
}

/** The pattern that matches exactly `identity`. */
export function exactIdentity(identity: string): string {
	return `^${escapeRegExp(identity)}$`;
}

/**
 * The pattern a release's certificate identity must match. @sigstore/verify tests the identity against
 * the policy as a regular expression, unanchored, so the pattern is anchored and escaped: otherwise
 * `v1.2.3` would also accept `…@refs/tags/v1.2.30` or a workflow named `release-yml`. GitHub names
 * owners and repositories without regard to case and the certificate carries their canonical spelling,
 * so those two match in any case; the workflow and the tag match exactly.
 */
export function identityPattern(id: ReleaseIdentity): string {
	const anyCase = (text: string) =>
		[...escapeRegExp(text)].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");
	return `^${escapeRegExp("https://github.com/")}${anyCase(id.owner)}/${anyCase(id.repo)}${escapeRegExp(`/.github/workflows/release.yml@refs/tags/${id.tag}`)}$`;
}

class CrhsFetcher extends BaseFetcher {
	readonly #fetch: typeof fetch;

	constructor(fetchFn: typeof fetch) {
		super();
		this.#fetch = fetchFn;
	}

	override async fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
		const response = await this.#fetch(url, { signal: AbortSignal.timeout(TUF_TIMEOUT_MS) });
		if (!response.ok || response.body === null) {
			throw new DownloadHTTPError(`GET ${url}: HTTP ${response.status}`, response.status);
		}
		return response.body as ReadableStream<Uint8Array<ArrayBuffer>>;
	}
}

export interface SigstoreVerifierOptions {
	/** Where the TUF metadata lives between verifications (crhs's data directory). */
	tufDir: string;
	/** The fetch for TUF requests; the wrapped global fetch by default. */
	fetch?: typeof fetch;
	/** Tests: the TUF repository. */
	mirror?: string;
	/** Tests: the root to start from instead of the bundled seed. */
	seedRoot?: Uint8Array;
}

export class SigstoreVerifier implements ReleaseSignatureVerifier {
	readonly #tufDir: string;
	readonly #fetch: typeof fetch;
	readonly #mirror: string;
	readonly #seedRoot: Uint8Array | undefined;

	constructor(options: SigstoreVerifierOptions) {
		this.#tufDir = options.tufDir;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#mirror = options.mirror ?? SIGSTORE_TUF_URL;
		this.#seedRoot = options.seedRoot;
	}

	/** Refreshes TUF and returns the current trusted root; throws on any failure. */
	async #trustedRoot(): Promise<TrustedRoot> {
		const targets = join(this.#tufDir, "targets");
		await mkdir(targets, { recursive: true, mode: 0o700 });
		// TUF starts from the root it has: the seed the first time, then the newest it verified. A newer
		// root always chains from the previous one, so a stored root is a starting point, not a fallback.
		const seed =
			this.#seedRoot ??
			Buffer.from((seeds as Record<string, { "root.json": string }>)[this.#mirror]?.["root.json"] ?? "", "base64");
		if (seed.length === 0) throw new Error(`no seed root for ${this.#mirror}`);
		// Placed whole or not at all: a root cut short by a crash would fail every refresh after it.
		const temp = join(this.#tufDir, `.root.json.${randomUUID()}.tmp`);
		await writeFile(temp, seed, { flag: "wx", mode: 0o600 });
		try {
			await link(temp, join(this.#tufDir, "root.json")).catch((err: unknown) => {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			});
		} finally {
			await rm(temp, { force: true });
		}
		const updater = new Updater({
			metadataBaseUrl: this.#mirror,
			targetBaseUrl: `${this.#mirror}/targets`,
			metadataDir: this.#tufDir,
			targetDir: targets,
			fetcher: new CrhsFetcher(this.#fetch),
		});
		await updater.refresh();
		const info = await updater.getTargetInfo("trusted_root.json");
		if (info === undefined) throw new Error("the TUF repository has no trusted_root.json");
		const path = (await updater.findCachedTarget(info)) ?? (await updater.downloadTarget(info));
		return TrustedRoot.fromJSON(JSON.parse(await readFile(path, "utf8")));
	}

	async verify(input: SignatureInput): Promise<SignatureCheck> {
		let root: TrustedRoot;
		try {
			root = await this.#trustedRoot();
		} catch (err) {
			return { kind: "unverifiable", reason: `cannot refresh the Sigstore trusted root: ${errorText(err)}` };
		}
		try {
			const bundle = bundleFromJSON(JSON.parse(Buffer.from(input.bundle).toString("utf8")));
			const verifier = new Verifier(toTrustMaterial(root), { tlogThreshold: 1, ctlogThreshold: 1 });
			verifier.verify(toSignedEntity(bundle, Buffer.from(input.artifact)), {
				subjectAlternativeName: input.identityPattern,
				extensions: { issuer: input.issuer },
			});
			return { kind: "ok" };
		} catch (err) {
			return { kind: "invalid", reason: `the Sigstore signature of SHA256SUMS does not verify: ${errorText(err)}` };
		}
	}
}
