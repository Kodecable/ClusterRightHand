#!/usr/bin/env node
// Builds dist/crhs: the bundled crhs, the WebUI and re2, plus the licenses and version of the tree.
// Plain Node TypeScript; the only dependency is esbuild's JS API (pnpm build:crhs).
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "crhs");
const skipWeb = process.argv.includes("--skip-web");

/** The bundle banner: CommonJS dependencies expect require, __filename and __dirname in ESM. */
const BANNER =
	"import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" +
	"const __filename=import.meta.filename;const __dirname=import.meta.dirname;";

/** The version: CRH_VERSION, then git describe, then a placeholder. */
async function resolveVersion(): Promise<string> {
	if (process.env.CRH_VERSION) return process.env.CRH_VERSION;
	try {
		const { stdout } = await run("git", ["describe", "--tags", "--always", "--dirty"]);
		return stdout.trim() || "0.0.0-dev";
	} catch {
		return "0.0.0-dev";
	}
}

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

const version = await resolveVersion();

if (!skipWeb) {
	console.log("building the WebUI");
	await run("pnpm", ["--filter", "@crh/web", "build"]);
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

console.log(`built dist/crhs (${version})`);
