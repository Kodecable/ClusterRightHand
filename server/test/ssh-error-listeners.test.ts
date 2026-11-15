/**
 * ssh2 is an EventEmitter: an 'error' event with no listener is thrown. A hop client outlives the
 * init-time listener once it is ready, and an SFTP channel outlives the one ssh2 attaches while it
 * opens. Both must keep a listener (ssh/connection.ts).
 */
import { EventEmitter } from "node:events";
import { type Client, Client as SshClient } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect as connectSsh, type SshRoute, SshSession } from "../src/cluster/ssh/connection.ts";

const fake = vi.hoisted(() => ({
	clients: [] as unknown[],
	onConnect: undefined as ((client: unknown) => void) | undefined,
	sftp: undefined as unknown,
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class FakeClient extends EventEmitter {
		constructor() {
			super();
			fake.clients.push(this);
		}

		connect(): void {
			fake.onConnect?.(this);
		}

		end(): void {}

		sftp(callback: (err: unknown, sftp: unknown) => void): void {
			callback(null, fake.sftp);
		}
	}
	return { Client: FakeClient };
});

const ROUTE: SshRoute = {
	hops: [{ host: "example.test", port: 22, user: "deploy", hostFingerprint: "SHA256:test", privateKey: "key" }],
};

describe("SSH error listeners", () => {
	afterEach(() => {
		fake.clients = [];
		fake.onConnect = undefined;
		fake.sftp = undefined;
	});

	it("closes the session when the SFTP channel errors after it opened", async () => {
		const sftp = Object.assign(new EventEmitter(), { end: () => {} });
		fake.sftp = sftp;
		const session = new SshSession([new SshClient() as unknown as Client]);
		const opened = await session.sftp();
		expect(session.closed).toBe(false);
		// ssh2 removed its open-time listener: without one here this emit throws.
		opened.emit("error", new Error("sftp died"));
		expect(session.closed).toBe(true);
	});

	it("ignores a second error from the same hop client", async () => {
		fake.onConnect = (value) => {
			const client = value as EventEmitter;
			setImmediate(() => client.emit("error", new Error("first")));
			setImmediate(() => client.emit("error", new Error("second")));
		};
		await expect(connectSsh(ROUTE)).rejects.toThrow("deploy@example.test:22: first");
		// The second emit happens on the next macrotask; an unhandled 'error' event would fail the test.
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
});
