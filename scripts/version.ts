// The version of the tree: CRH_VERSION, then git describe, then a placeholder. Shared by the build and
// the packaging scripts, so both name the same version.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The version: CRH_VERSION, then git describe, then a placeholder. */
export async function resolveVersion(): Promise<string> {
	if (process.env.CRH_VERSION) return process.env.CRH_VERSION;
	try {
		const { stdout } = await run("git", ["describe", "--tags", "--always", "--dirty"]);
		return stdout.trim() || "0.0.0-dev";
	} catch {
		return "0.0.0-dev";
	}
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
