import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeHostKey, type SshRoute, testRoute } from "../src/cluster/ssh/connection.ts";

const target = process.env.CRH_TEST_SSH;
const keyPath = process.env.CRH_TEST_SSH_KEY;

describe.skipIf(!target || !keyPath)("testRoute against a live sshd", () => {
	const m = /^(.+)@(.+):(\d+)$/.exec(target ?? "");
	const hop = { host: m?.[2] ?? "", port: Number(m?.[3]), user: m?.[1] ?? "", hostKey: "" };
	const pinned = async (): Promise<SshRoute> => {
		const route = { hops: [hop], privateKey: readFileSync(keyPath ?? "", "utf8") };
		const { fingerprint } = await probeHostKey(route);
		return { ...route, hops: [{ ...hop, hostKey: fingerprint }] };
	};

	it("succeeds with an installed key", async () => {
		await expect(testRoute(await pinned())).resolves.toBeUndefined();
	});

	it("fails with a key the server does not know", async () => {
		const { utils } = await import("ssh2");
		const route = { ...(await pinned()), privateKey: utils.generateKeyPairSync("ed25519").private };
		await expect(testRoute(route)).rejects.toMatchObject({ code: "connect_failed" });
	});
});
