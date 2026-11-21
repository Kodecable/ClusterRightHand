// The version of the tree, the one place that turns a tag or a `git describe` into a version
// (doc/design/distribution.md "Versions"). The build and packaging scripts call resolveVersion();
// the release workflow runs this file once and hands its outputs to every job.
//
//   tag v0.2.0-rc.1                       -> 0.2.0-rc.1                (a release)
//   git describe v0.2.0-rc.1-4-gabc1234   -> 0.2.0-rc.1+4.gabc1234     (not a release: build metadata)
//   ... -dirty                             -> ...+...dirty
//   no version tag: abc1234                -> 0.0.0+gabc1234
//   no git                                 -> dev
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isPrerelease, isReleaseVersion } from "../server/src/util/release-version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The release a tag names: `v` and a release version. Anything else is refused. */
export function versionFromTag(tag: string): string {
	const version = tag.startsWith("v") ? tag.slice(1) : "";
	if (!isReleaseVersion(version)) throw new Error(`tag ${tag} is not v followed by a release version`);
	return version;
}

/** The version of a `git describe --tags --always --dirty` output. */
export function versionFromDescribe(describe: string): string {
	const bare = /^([0-9a-f]{4,})(-dirty)?$/.exec(describe);
	if (bare) return `0.0.0+g${bare[1]}${bare[2] ? ".dirty" : ""}`;
	const match = /^(v.+?)(?:-([0-9]+)-g([0-9a-f]+))?(-dirty)?$/.exec(describe);
	if (!match?.[1]) throw new Error(`cannot read git describe output ${JSON.stringify(describe)}`);
	const release = versionFromTag(match[1]);
	const meta = [...(match[2] ? [match[2], `g${match[3]}`] : []), ...(match[4] ? ["dirty"] : [])];
	return meta.length === 0 ? release : `${release}+${meta.join(".")}`;
}

/** A version CRH_VERSION may set: a release, a release with build metadata, or `dev`. */
const OVERRIDE = /^(dev|(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)$/;

/**
 * The version: CRH_VERSION when set (a manual override), the tag a GitHub Actions run was started for,
 * then git describe over the version tags, then `dev`. In a tag run the override must agree with the tag,
 * so a release never carries another version than its tag.
 */
export async function resolveVersion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const tagged = env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME ? versionFromTag(env.GITHUB_REF_NAME) : undefined;
	if (env.CRH_VERSION) {
		if (!OVERRIDE.test(env.CRH_VERSION)) {
			throw new Error(`CRH_VERSION ${env.CRH_VERSION} is not a version (x.y.z[-pre][+build] or dev)`);
		}
		if (tagged !== undefined && env.CRH_VERSION !== tagged) {
			throw new Error(`CRH_VERSION ${env.CRH_VERSION} disagrees with the tag ${env.GITHUB_REF_NAME}`);
		}
		return env.CRH_VERSION;
	}
	if (tagged !== undefined) return tagged;
	let describe: string;
	try {
		// Only version tags: another tag (a marker, a test) would not read as a version.
		describe = (await run("git", ["describe", "--tags", "--match", "v[0-9]*", "--always", "--dirty"])).stdout.trim();
	} catch {
		return "dev";
	}
	return describe === "" ? "dev" : versionFromDescribe(describe);
}

/** Runs a git command in the repository root and captures its output. */
function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, npm_config_manage_package_manager_versions: "false" },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr}`));
		});
	});
}

// `node scripts/version.ts` prints the version; `--github-output` also writes `version` and
// `prerelease` to $GITHUB_OUTPUT for the release workflow.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const version = await resolveVersion();
	console.log(version);
	if (process.argv.includes("--github-output")) {
		const output = process.env.GITHUB_OUTPUT;
		if (!output) throw new Error("--github-output needs GITHUB_OUTPUT");
		await appendFile(output, `version=${version}\nprerelease=${isPrerelease(version)}\n`);
	}
}
