#!/usr/bin/env node
// Builds dist/crhs: the bundled crhs, the WebUI and re2, plus the licenses and version of the tree.
// Plain Node TypeScript; the only dependency is esbuild's JS API (pnpm build:crhs).
import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { copyDocFiles } from "../server/src/extensions/docs-source.ts";
import { resolveVersion } from "./version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "crhs");
const skipWeb = process.argv.includes("--skip-web");

/** The bundle banner: CommonJS dependencies expect require, __filename and __dirname in ESM. */
const BANNER =
	"import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" +
	"const __filename=import.meta.filename;const __dirname=import.meta.dirname;";

function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, npm_config_manage_package_manager_versions: "false", ...env },
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

interface PackageInfo {
	dir: string;
	name: string;
	version: string;
}

/** The package a bundled input belongs to, from the last node_modules segment in its path. */
function packageDirOf(input: string): string | undefined {
	const original = input.replaceAll("\\", "/");
	const absolute = isAbsolute(original);
	const normalized = absolute ? original : `/${original}`;
	const marker = "/node_modules/";
	const at = normalized.lastIndexOf(marker);
	if (at < 0) return undefined;
	const rest = normalized.slice(at + marker.length).split("/");
	const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	if (!name) return undefined;
	const dir = `${normalized.slice(0, at)}/node_modules/${name}`;
	return absolute ? dir : join(root, dir.slice(1));
}

async function packageInfo(dir: string): Promise<PackageInfo> {
	const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
	};
	if (!pkg.name || !pkg.version) throw new Error(`${dir}/package.json has no name or version`);
	return { dir, name: pkg.name, version: pkg.version };
}

/** The license text: a LICENSE/LICENCE/COPYING file, else the package.json license field. */
async function licenseText(info: PackageInfo): Promise<string> {
	const entries = await readdir(info.dir);
	const file = entries.sort().find((entry) => /^(licen[cs]e|copying)(\..*)?$/i.test(entry));
	if (file) return (await readFile(join(info.dir, file), "utf8")).trimEnd();
	const pkg = JSON.parse(await readFile(join(info.dir, "package.json"), "utf8")) as {
		license?: string | { type?: string };
	};
	const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
	return license ? `License: ${license}` : "";
}

/** True for the workspace packages, whose licenses this project's own LICENSE covers. */
async function isWorkspacePackage(dir: string): Promise<boolean> {
	const real = await realpath(dir);
	return ["packages", "server", "web"].some(
		(own) => real === join(root, own) || real.startsWith(`${join(root, own)}/`),
	);
}

async function thirdPartyLicenses(inputs: string[], re2: PackageInfo): Promise<string> {
	const packages = new Map<string, PackageInfo>();
	for (const input of inputs) {
		const dir = packageDirOf(input);
		if (!dir || (await isWorkspacePackage(dir))) continue;
		const info = await packageInfo(dir);
		packages.set(`${info.name}@${info.version}`, info);
	}
	packages.set(`${re2.name}@${re2.version}`, re2);
	const blocks: string[] = [];
	for (const key of [...packages.keys()].sort()) {
		const info = packages.get(key) as PackageInfo;
		const text = await licenseText(info);
		blocks.push(`${key}\n\n${text}`);
	}
	return `${blocks.join("\n\n").trimEnd()}\n`;
}

/**
 * Old dependencies (tr46 under grammy's node-fetch) require Node's built-in punycode, which prints a
 * DEP0040 warning on every start, in the middle of the first `crhs init` question. The userland
 * package of the same API takes its place in the bundle.
 */
const userlandPunycode: Plugin = {
	name: "userland-punycode",
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^(node:)?punycode$/ }, (args) =>
			pluginBuild.resolve("punycode/", { kind: args.kind, resolveDir: join(root, "server") }),
		);
	},
};

const version = await resolveVersion();

if (!skipWeb) {
	console.log("building the WebUI");
	await run("pnpm", ["--filter", "@crh/web", "build"], { CRH_VERSION: version });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
	entryPoints: [join(root, "server", "src", "main.ts")],
	outfile: join(outDir, "crhs.mjs"),
	absWorkingDir: root,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	external: ["re2", "cpu-features", "esbuild"],
	plugins: [userlandPunycode],
	banner: { js: BANNER },
	minify: false,
	legalComments: "none",
	metafile: true,
	define: {
		__CRH_VERSION__: JSON.stringify(version),
		__CRH_BUNDLED__: "true",
	},
});

const inputs = Object.keys(result.metafile.inputs);
const esbuildInputs = inputs.filter((input) => `/${input.replaceAll("\\", "/")}`.includes("/node_modules/esbuild/"));
if (esbuildInputs.length > 0) throw new Error(`the bundle contains esbuild: ${esbuildInputs.join(", ")}`);

await cp(join(root, "web", "dist"), join(outDir, "web"), { recursive: true });
// The built-in crhs-docs extension reads the documentation of the running version from the bundle
// (doc/design/extensions.md "Documentation"); images are not copied, because the tools return text.
await copyDocFiles(join(root, "doc"), join(outDir, "doc"));

const re2Source = await realpath(join(root, "server", "node_modules", "re2"));
const re2 = await packageInfo(re2Source);
const re2Target = join(outDir, "node_modules", "re2");
for (const file of ["package.json", "re2.js", "LICENSE", "build/Release/re2.node"]) {
	await mkdir(dirname(join(re2Target, file)), { recursive: true });
	await copyFile(join(re2Source, file), join(re2Target, file));
}

await writeFile(
	join(outDir, "package.json"),
	`${JSON.stringify(
		{ name: "crhs", version, private: true, type: "module", dependencies: { re2: re2.version } },
		null,
		2,
	)}\n`,
);
await writeFile(join(outDir, "THIRD_PARTY_LICENSES.txt"), await thirdPartyLicenses(inputs, re2));
await writeFile(join(outDir, "VERSION"), `${version}\n`);

await smokeTest();

console.log(`built dist/crhs (${version})`);

/**
 * Starts a copy of the bundle outside the tree and checks it prints its version. Inside the tree a
 * module the bundle failed to include still resolves through the workspace's node_modules; outside
 * it, as in the image and the release tarballs, it does not (a runtime require esbuild left alone).
 */
async function smokeTest(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "crhs-smoke-"));
	try {
		await cp(outDir, dir, { recursive: true });
		const { stdout } = await promisify(execFile)(process.execPath, ["crhs.mjs", "--version"], {
			cwd: dir,
			// A launcher's NODE_PATH (pnpm's .bin shims set one) would resolve the workspace's packages.
			env: { ...process.env, NODE_PATH: "" },
			timeout: 60_000,
		});
		if (stdout.trim() !== version)
			throw new Error(`the bundle printed ${JSON.stringify(stdout.trim())}, not ${version}`);
	} catch (error) {
		throw new Error(`dist/crhs does not start outside the tree: ${(error as Error).message}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
