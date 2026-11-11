import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { probeHostFingerprint, type SshRoute, testRoute } from "../src/cluster/ssh/connection.ts";

// A loaded machine can push these past the default 5 s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const target = process.env.CRH_TEST_SSH;
const keyPath = process.env.CRH_TEST_SSH_KEY;

describe.skipIf(!target || !keyPath)("testRoute against a live sshd", () => {
	const m = /^(.+)@(.+):(\d+)$/.exec(target ?? "");
	const hop = { host: m?.[2] ?? "", port: Number(m?.[3]), user: m?.[1] ?? "", hostFingerprint: "" };
	const pinned = async (): Promise<SshRoute> => {
		const key = readFileSync(keyPath ?? "", "utf8");
		const unpinned: SshRoute = { hops: [{ ...hop, privateKey: key }] };
		const { fingerprint } = await probeHostFingerprint(unpinned);
		return { hops: [{ ...hop, hostFingerprint: fingerprint, privateKey: key }] };
	};

	it("succeeds with an installed key", async () => {
		await expect(testRoute(await pinned())).resolves.toBeUndefined();
	});

	it("fails with a key the server does not know", async () => {
		const { generateKeyPair } = await import("../src/cluster/ssh/nodes.ts");
		const route = await pinned();
		const unknown = generateKeyPair("crh:unknown").private;
		await expect(testRoute({ hops: route.hops.map((h) => ({ ...h, privateKey: unknown })) })).rejects.toMatchObject({
			code: "connect_failed",
		});
	});
});

describe("generateKeyPair", () => {
	it("only returns keys that ssh2 can load", async () => {
		const { utils } = await import("ssh2");
		const { generateKeyPair } = await import("../src/cluster/ssh/nodes.ts");
		for (let i = 0; i < 2000; i++) expect(utils.parseKey(generateKeyPair("crh:t").private)).not.toBeInstanceOf(Error);
	});
});
