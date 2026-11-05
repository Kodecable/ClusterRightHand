import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, Env, goAvailable, waitFor } from "./harness.ts";

const hasGo = await goAvailable();

/**
 * M4.1: privileged is carried end to end on the crhs side and crha answers according to its mode. The
 * default mode is `reject`, so a privileged task is refused before it is accepted and ends `failed`.
 */
describe.skipIf(!hasGo)("privileged tasks end to end", () => {
	let tmp = "";
	let bin = "";

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-m4-e2e-"));
		bin = await buildCrha(tmp);
	}, 180_000);

	afterAll(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	describe("with a node in the default reject mode", () => {
		let env: Env;

		beforeAll(async () => {
			env = await Env.create(bin, tmp);
			await env.bringUp();
		}, 60_000);

		afterAll(async () => {
			if (env) await env.destroy();
		});

		it("stores the mode reported in Hello", async () => {
			// crha reports `privileged_mode` in Hello; crhs keeps it for the node page and later phases.
			const mode = await waitFor("the node's privileged mode", async () => {
				const { json } = await env.crhs.api(`/api/nodes/${env.nodeId}`);
				return json.node.privilegedMode as string | null;
			});
			expect(mode).toBe("reject");
		});

		it("fails a privileged exec with privileged_unsupported", async () => {
			const t = await env.crhs.runTask(env.nodeId, { kind: "exec", argv: ["true"], privileged: true });
			expect(t).toMatchObject({ state: "failed", errorCode: "privileged_unsupported" });
			expect(t.errorMessage).toContain("privileged");
			expect(t.privileged).toBe(true);
			// It was refused before acceptance: nothing ran and there is no output.
			expect(t.exitCode).toBeNull();
			expect(t.outputBytes).toBe(0);
		});

		it("fails a privileged file task the same way", async () => {
			const t = await env.crhs.runTask(env.nodeId, { kind: "file.read", path: "/etc/hostname", privileged: true });
			expect(t).toMatchObject({ state: "failed", errorCode: "privileged_unsupported", privileged: true });
		});

		it("runs an ordinary task unchanged", async () => {
			const t = await env.crhs.runTask(env.nodeId, { kind: "exec", argv: ["true"] });
			expect(t).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			expect(t.errorCode).toBeNull();
		});
	});
});
