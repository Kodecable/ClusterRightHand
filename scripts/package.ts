#!/usr/bin/env node
// Builds the release archives into dist/release and, with --oci, stages the OCI build context; see
// doc/design/distribution.md. Plain Node TypeScript; run with `pnpm package` or `pnpm package:oci`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { resolveVersion } from "./version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const crhsDir = join(distDir, "crhs");
const cacheDir = join(distDir, "cache");
const stageDir = join(distDir, "stage");
const releaseDir = join(distDir, "release");
const ociContextDir = join(distDir, "oci-context");

/** The Node.js release shipped in the crhs-<v>-linux-<arch> archives. */
const NODE_VERSION = "26.13.0";
const NODE_MAJOR = NODE_VERSION.split(".")[0];
/** re2's prebuilt artifacts and the module ABI are those of NODE_VERSION's major. */
const NODE_ABI = process.versions.modules;
const VERSION_PACKAGE = "github.com/Kodecable/ClusterRightHand/client/internal/version";

type Arch = "amd64" | "arm64";
const NODE_ARCH: Record<Arch, "x64" | "arm64"> = { amd64: "x64", arm64: "arm64" };

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const oci = argv.includes("--oci");

const CRHS_WRAPPER = `#!/bin/sh
# Runs the crhs bundle next to this script with the Node.js shipped beside it.
set -eu
dir=$(dirname "$(readlink -f "$0")")
CRHS_LAUNCHER=$0
export CRHS_LAUNCHER
exec "$dir/../node/bin/node" "$dir/../crhs.mjs" "$@"
`;

const CRHS_INSTALL = `#!/bin/sh
# Installs this crhs directory under /opt/crhs/versions and points the crhs command at it.
set -eu
dir=$(dirname "$(readlink -f "$0")")
version=$(cat "$dir/VERSION")
# The bundled Node needs the system's shared libraries; check that it starts before installing anything.
if ! "$dir/node/bin/node" --version >/dev/null 2>&1; then
	echo "install.sh: the bundled Node cannot start on this system:" >&2
	"$dir/node/bin/node" --version >&2 || true
	echo "install.sh: check its dependencies, for example with: ldd $dir/node/bin/node" >&2
	exit 1
fi
target=/opt/crhs/versions/$version
if [ -e "$target" ]; then
	if [ "$(cat "$target/VERSION" 2>/dev/null)" != "$version" ]; then
		echo "install.sh: $target exists with another VERSION; remove it first" >&2
		exit 1
	fi
else
	install -d -m 0755 "$target"
	cp -a "$dir/." "$target/"
fi
ln -sfn "$target" /opt/crhs/current
ln -sfn /opt/crhs/current/bin/crhs /usr/local/bin/crhs
if [ -t 0 ]; then
	/usr/local/bin/crhs init
else
	echo "run: sudo crhs init"
fi
`;

const CRHA_INSTALL = `#!/bin/sh
# Installs crha and enrolls this node.
set -eu
dir=$(dirname "$(readlink -f "$0")")
install -m 0755 "$dir/crha" /usr/local/bin/crha
if [ -t 0 ]; then
	crha enroll
else
	echo "run: sudo crha enroll"
fi
`;

const version = await resolveVersion();
const commit = (await capture("git", ["rev-parse", "--short", "HEAD"])).trim();
const commitTime = (await capture("git", ["log", "-1", "--format=%ct"])).trim();

if (process.versions.node.split(".")[0] !== NODE_MAJOR) {
	throw new Error(
		`packaging needs Node ${NODE_MAJOR} (re2's prebuilt artifacts use that major's ABI), running ${process.versions.node}`,
	);
}

if (!skipBuild) {
	console.log(`building dist/crhs (${version})`);
	await exec("pnpm", ["build:crhs"], {
		env: { ...process.env, CRH_VERSION: version, npm_config_manage_package_manager_versions: "false" },
	});
}

if (oci) {
	const context = await stageOci();
	console.log(`\nbuild the image from the repository root with:`);
	console.log(
		`  podman build -f packaging/oci/Containerfile --build-arg CRH_VERSION=${version} -t crhs:${version} ${relative(context)}`,
	);
} else {
	await packageArchives(parseArches());
}

async function packageArchives(arches: Arch[]): Promise<void> {
	await rm(stageDir, { recursive: true, force: true });
	await rm(releaseDir, { recursive: true, force: true });
	await mkdir(stageDir, { recursive: true });
	await mkdir(releaseDir, { recursive: true });

	await packageCrhs(version);
	for (const arch of arches) {
		await packageCrhsWithNode(version, arch);
		await packageCrha(version, commit, arch);
	}
	await writeSums();
}

/** crhs-<v>.tar.gz: the bundle without Node, installed with npm ci. */
async function packageCrhs(version: string): Promise<void> {
	const top = `crhs-${version}`;
	const dir = join(stageDir, top);
	await mkdir(dir, { recursive: true });
	await copyFile(join(crhsDir, "crhs.mjs"), join(dir, "crhs.mjs"));
	await cp(join(crhsDir, "web"), join(dir, "web"), { recursive: true });
	await copyFile(join(crhsDir, "package.json"), join(dir, "package.json"));
	await copyFile(join(crhsDir, "THIRD_PARTY_LICENSES.txt"), join(dir, "THIRD_PARTY_LICENSES.txt"));
	await copyFile(join(root, "LICENSE"), join(dir, "LICENSE"));
	await writeFile(join(dir, "VERSION"), `${version}\n`);
	await writeFile(join(dir, "README.txt"), readme(version));
	console.log("generating package-lock.json");
	// npm's cache lives under the download cache: the staging directory is disposable, the cache is not.
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.npm_config_manage_package_manager_versions;
	await exec("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
		cwd: dir,
		env: { ...env, npm_config_cache: join(cacheDir, "npm"), npm_config_logs_dir: join(cacheDir, "npm-logs") },
	});
	await gzipTar(top);
}

/** crhs-<v>-linux-<arch>.tar.gz: the bundle, Node.js and re2's binary for one architecture. */
async function packageCrhsWithNode(version: string, arch: Arch): Promise<void> {
	const top = `crhs-${version}-linux-${arch}`;
	const dir = join(stageDir, top);
	const re2Dir = join(dir, "node_modules", "re2");
	await mkdir(join(re2Dir, "build", "Release"), { recursive: true });
	await mkdir(join(dir, "bin"), { recursive: true });
	await copyFile(join(crhsDir, "crhs.mjs"), join(dir, "crhs.mjs"));
	await cp(join(crhsDir, "web"), join(dir, "web"), { recursive: true });
	for (const file of ["package.json", "re2.js", "LICENSE"]) {
		await copyFile(join(crhsDir, "node_modules", "re2", file), join(re2Dir, file));
	}
	await writeFile(join(re2Dir, "build", "Release", "re2.node"), await re2Binary(arch));
	await installNode(dir, arch);
	const licenses = await readFile(join(crhsDir, "THIRD_PARTY_LICENSES.txt"), "utf8");
	const nodeLicense = await readFile(join(dir, "node", "LICENSE"), "utf8");
	await writeFile(
		join(dir, "THIRD_PARTY_LICENSES.txt"),
		`${licenses.trimEnd()}\n\nNode.js ${NODE_VERSION}\n\n${nodeLicense.trimEnd()}\n`,
	);
	await copyFile(join(root, "LICENSE"), join(dir, "LICENSE"));
	await writeFile(join(dir, "VERSION"), `${version}\n`);
	await writeFile(join(dir, "bin", "crhs"), CRHS_WRAPPER);
	await chmod(join(dir, "bin", "crhs"), 0o755);
	await writeFile(join(dir, "install.sh"), CRHS_INSTALL);
	await chmod(join(dir, "install.sh"), 0o755);
	await gzipTar(top);
}

/** crha-<v>-linux-<arch>.tar.gz: the static binary and its installer. */
async function packageCrha(version: string, sha: string, arch: Arch): Promise<void> {
	const top = `crha-${version}-linux-${arch}`;
	const dir = join(stageDir, top);
	await mkdir(dir, { recursive: true });
	await exec(
		"go",
		[
			"build",
			"-trimpath",
			"-ldflags",
			`-s -w -X ${VERSION_PACKAGE}.Version=${version} -X ${VERSION_PACKAGE}.Commit=${sha}`,
			"-o",
			join(dir, "crha"),
			"./cmd/crha",
		],
		{
			cwd: join(root, "client"),
			env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch, GOCACHE: "/tmp/crh-go-cache" },
		},
	);
	await chmod(join(dir, "crha"), 0o755);
	await copyFile(join(root, "LICENSE"), join(dir, "LICENSE"));
	await writeFile(join(dir, "THIRD_PARTY_LICENSES.txt"), await goLicenses());
	await writeFile(join(dir, "VERSION"), `${version}\n`);
	await writeFile(join(dir, "install.sh"), CRHA_INSTALL);
	await chmod(join(dir, "install.sh"), 0o755);
	await gzipTar(top);
}

/** The official Node.js binary distribution, checked against SHASUMS256.txt. */
async function installNode(dir: string, arch: Arch): Promise<void> {
	const name = `node-v${NODE_VERSION}-linux-${NODE_ARCH[arch]}`;
	const archive = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz`, `${name}.tar.xz`);
	const sums = await readFile(
		await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, `SHASUMS256-v${NODE_VERSION}.txt`),
		"utf8",
	);
	const expected = sums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find(([, file]) => file === `${name}.tar.xz`)?.[0];
	if (!expected) throw new Error(`SHASUMS256.txt has no ${name}.tar.xz`);
	const actual = sha256(await readFile(archive));
	if (actual !== expected) throw new Error(`${name}.tar.xz: sha256 ${actual} does not match ${expected}`);
	await mkdir(join(dir, "node"), { recursive: true });
	await exec("tar", [
		"-xJf",
		archive,
		"-C",
		join(dir, "node"),
		"--strip-components=1",
		`${name}/bin/node`,
		`${name}/LICENSE`,
	]);
	await chmod(join(dir, "node", "bin", "node"), 0o755);
}

/** re2's prebuilt binary for the arch, the way its installer fetches it, checked against artifactHashes. */
async function re2Binary(arch: Arch): Promise<Buffer> {
	const re2 = JSON.parse(await readFile(join(crhsDir, "node_modules", "re2", "package.json"), "utf8")) as {
		version: string;
		artifactHashes?: Record<string, string>;
	};
	const slot = `linux-${NODE_ARCH[arch]}-${NODE_ABI}`;
	const expected = re2.artifactHashes?.[slot];
	if (!expected) throw new Error(`re2 ${re2.version} has no ${slot} artifact hash`);
	const cached = join(cacheDir, `re2-${re2.version}-${slot}.node`);
	try {
		const bytes = await readFile(cached);
		if (`sha256:${sha256(bytes)}` === expected) return bytes;
	} catch {
		// not cached yet
	}
	const url = `https://github.com/uhop/node-re2/releases/download/${re2.version}/${slot}`;
	const variants: [string, (bytes: Buffer) => Buffer][] = [
		[".br", (bytes) => brotliDecompressSync(bytes)],
		[".gz", (bytes) => gunzipSync(bytes)],
		["", (bytes) => bytes],
	];
	for (const [suffix, decode] of variants) {
		const response = await fetch(url + suffix);
		if (!response.ok) continue;
		let bytes: Buffer;
		try {
			bytes = decode(Buffer.from(await response.arrayBuffer()));
		} catch {
			continue;
		}
		if (`sha256:${sha256(bytes)}` !== expected) throw new Error(`re2 ${slot}: sha256 mismatch`);
		await mkdir(cacheDir, { recursive: true });
		await writeFile(cached, bytes);
		return bytes;
	}
	throw new Error(`re2 ${re2.version} has no prebuilt ${slot} artifact`);
}

/** The licenses of the Go modules in the build, one block per license file. */
async function goLicenses(): Promise<string> {
	const text = await capture("go", ["list", "-m", "-json", "all"], {
		cwd: join(root, "client"),
		env: { ...process.env, GOCACHE: "/tmp/crh-go-cache" },
	});
	const blocks: string[] = [];
	for (const module of parseJsonObjects(text)) {
		if (module.Main || !module.Dir) continue;
		const files = (await readdir(module.Dir)).filter((file) => /^(licen[cs]e|copying|notice)/i.test(file)).sort();
		for (const file of files) {
			const body = (await readFile(join(module.Dir, file), "utf8")).trimEnd();
			blocks.push(`${module.Path}@${module.Version ?? "local"}\n\n${body}`);
		}
	}
	return `${blocks.sort().join("\n\n")}\n`;
}

/** Stages dist/oci-context: the contents of dist/crhs plus the entrypoint, the image's build context. */
async function stageOci(): Promise<string> {
	await rm(ociContextDir, { recursive: true, force: true });
	await mkdir(ociContextDir, { recursive: true });
	await cp(crhsDir, ociContextDir, { recursive: true });
	await copyFile(join(root, "packaging", "oci", "entrypoint.sh"), join(ociContextDir, "entrypoint.sh"));
	await chmod(join(ociContextDir, "entrypoint.sh"), 0o755);
	console.log(`staged ${relative(ociContextDir)}`);
	return ociContextDir;
}

/** tar --sort=name ... | gzip -n: the top directory only, with fixed mtime and owner. */
async function gzipTar(top: string): Promise<void> {
	const out = join(releaseDir, `${top}.tar.gz`);
	const tar = spawn(
		"tar",
		[
			"-C",
			stageDir,
			"--sort=name",
			`--mtime=@${commitTime}`,
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"-cf",
			"-",
			top,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const gzip = spawn("gzip", ["-n"], { stdio: ["pipe", "pipe", "inherit"] });
	tar.stdout.pipe(gzip.stdin);
	const stream = createWriteStream(out);
	gzip.stdout.pipe(stream);
	const closed = onceClose(stream);
	const [tarCode, gzipCode] = await Promise.all([onceExit(tar), onceExit(gzip)]);
	await closed;
	if (tarCode !== 0 || gzipCode !== 0) throw new Error(`tar or gzip failed for ${top}`);
	const size = (await stat(out)).size;
	console.log(`wrote dist/release/${top}.tar.gz (${(size / (1024 * 1024)).toFixed(1)} MiB)`);
}

async function writeSums(): Promise<void> {
	const archives = (await readdir(releaseDir)).filter((name) => name.endsWith(".tar.gz")).sort();
	const lines: string[] = [];
	for (const name of archives) lines.push(`${sha256(await readFile(join(releaseDir, name)))}  ${name}`);
	await writeFile(join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
	console.log(`wrote dist/release/SHA256SUMS (${archives.length} archives)`);
}

function readme(version: string): string {
	return `ClusterRightHand server (crhs) ${version}

This is the crhs bundle without Node.js. It needs Node.js 24.7 or newer on glibc Linux.
Install the dependency once in this directory: npm ci --omit=dev
(it downloads a prebuilt re2, or builds it when no binary matches this platform).
Then run: node crhs.mjs init   (as root, for the fixed host layout)
      and: node crhs.mjs serve
For a container or a data-directory install set CRHS_DATA_DIR; init keeps every file there.
See the install guide: https://github.com/Kodecable/ClusterRightHand/blob/main/doc/guide/install.md
`;
}

async function download(url: string, name: string): Promise<string> {
	await mkdir(cacheDir, { recursive: true });
	const path = join(cacheDir, name);
	try {
		await access(path);
		return path;
	} catch {
		// not cached yet
	}
	console.log(`downloading ${url}`);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
	await writeFile(path, Buffer.from(await response.arrayBuffer()));
	return path;
}

function exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? root,
			env: options.env ?? process.env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
		});
	});
}

function capture(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? root,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
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
			if (code === 0) resolve(stdout);
			else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr}`));
		});
	});
}

function onceExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

function onceClose(stream: ReturnType<typeof createWriteStream>): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.once("close", resolve);
		stream.once("error", reject);
	});
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function relative(path: string): string {
	return path.slice(root.length).replace(/^\//, "");
}

function parseArches(): Arch[] {
	const index = argv.findIndex((arg) => arg === "--arch" || arg.startsWith("--arch="));
	if (index < 0) return ["amd64", "arm64"];
	const value = argv[index]?.startsWith("--arch=") ? (argv[index] as string).slice("--arch=".length) : argv[index + 1];
	if (!value) throw new Error("--arch needs amd64, arm64 or a comma-separated list of them");
	const arches = value
		.split(",")
		.map((arch) => arch.trim())
		.filter(Boolean);
	for (const arch of arches) {
		if (arch !== "amd64" && arch !== "arm64") throw new Error(`unknown arch ${arch}`);
	}
	return arches as Arch[];
}

interface GoModule {
	Path: string;
	Version?: string;
	Main?: boolean;
	Dir?: string;
}

/** `go list -m -json all` prints one JSON object after another. */
function parseJsonObjects(text: string): GoModule[] {
	const modules: GoModule[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = index;
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) modules.push(JSON.parse(text.slice(start, index + 1)) as GoModule);
		}
	}
	return modules;
}
