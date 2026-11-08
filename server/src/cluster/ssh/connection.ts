import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { SshHop } from "@crh/api";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";

/** One SSH hop. The last hop of a route is the node itself. */
export type { SshHop };

export interface SshRoute {
	hops: SshHop[];
	/** OpenSSH or PEM private key used for every hop. */
	privateKey: string;
}

export class SshError extends Error {
	readonly code: "host_key_mismatch" | "connect_failed";

	constructor(code: SshError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

const CONNECT_TIMEOUT_MS = 15_000;
// Dead links (including a hop behind a jump host) are noticed after about 3 missed keepalives.
const KEEPALIVE_MS = 10_000;

export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** An established route; closing it closes every hop. */
export class SshSession {
	readonly #clients: Client[];
	#closed = false;
	readonly #onClose = new Set<() => void>();

	constructor(clients: Client[]) {
		this.#clients = clients;
		for (const c of clients) {
			c.on("close", () => this.close());
			c.on("end", () => this.close());
			c.on("error", () => this.close());
		}
	}

	get closed(): boolean {
		return this.#closed;
	}

	onClose(fn: () => void): () => void {
		if (this.#closed) fn();
		else this.#onClose.add(fn);
		return () => this.#onClose.delete(fn);
	}

	/**
	 * Opens an exec channel. `onChannel` runs synchronously when the channel opens: a short command's
	 * output and exit status can arrive in the same packet as the open confirmation, and ssh2 emits them
	 * right away, so listeners attached after an `await` would miss the exit status.
	 */
	exec(command: string, onChannel?: (channel: ClientChannel) => void): Promise<ClientChannel> {
		return new Promise((resolve, reject) => {
			if (this.#closed) return reject(new SshError("connect_failed", "connection closed"));
			try {
				this.#target.exec(command, (err, channel) => {
					if (err) return reject(err);
					onChannel?.(channel);
					resolve(channel);
				});
			} catch (err) {
				// ssh2 throws synchronously when the client is no longer connected.
				this.close();
				reject(new SshError("connect_failed", (err as Error).message));
			}
		});
	}

	/** Opens a TCP stream from the last hop, for the next hop of a longer route. */
	forwardTo(host: string, port: number): Promise<Duplex> {
		return forward(this.#target, host, port);
	}

	sftp(): Promise<SFTPWrapper> {
		return new Promise((resolve, reject) => {
			if (this.#closed) return reject(new SshError("connect_failed", "connection closed"));
			try {
				this.#target.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
			} catch (err) {
				this.close();
				reject(new SshError("connect_failed", (err as Error).message));
			}
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const c of [...this.#clients].reverse()) c.end();
		for (const fn of this.#onClose) fn();
		this.#onClose.clear();
	}

	get #target(): Client {
		return this.#clients[this.#clients.length - 1] as Client;
	}
}

/** Connects hop by hop, each through the previous one, checking every pinned host key. */
export async function connect(route: SshRoute): Promise<SshSession> {
	const clients: Client[] = [];
	try {
		let sock: Duplex | undefined;
		for (const [i, hop] of route.hops.entries()) {
			if (!hop.hostKey) throw new SshError("host_key_mismatch", `hop ${i + 1} (${hop.host}) has no pinned host key`);
			const client = await connectHop(hop, route.privateKey, sock, (key) => {
				if (hostKeyFingerprint(key) === hop.hostKey) return true;
				throw new SshError(
					"host_key_mismatch",
					`host key of ${hop.host}:${hop.port} is ${hostKeyFingerprint(key)}, pinned ${hop.hostKey}`,
				);
			});
			clients.push(client);
			const next = route.hops[i + 1];
			if (next) {
				sock = await forward(client, next.host, next.port);
				// When the forwarded stream dies, the hop behind it is gone even if no close arrives.
				sock.on("close", () => client.end());
			}
		}
		return new SshSession(clients);
	} catch (err) {
		for (const c of clients.reverse()) c.end();
		throw err;
	}
}

/**
 * Connects over a fully pinned route, authenticates on every hop and runs `true` on the last one: catches a
 * public key that was not installed, or an account that cannot run commands (ForceCommand, nologin).
 */
export async function testRoute(route: SshRoute): Promise<void> {
	const session = await connect(route);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			session
				.exec("true", (ch) => {
					let status: number | null = null;
					ch.on("exit", (c: number | null) => {
						status = c;
					});
					ch.on("close", () => resolve(status));
					ch.resume();
				})
				.catch(reject);
		});
		if (code !== 0) throw new SshError("connect_failed", `running a command failed (exit status ${code})`);
	} finally {
		session.close();
	}
}

/**
 * Reaches the first hop without a pinned key (all earlier hops must be pinned) and returns its host key
 * fingerprint, without authenticating to it. The user confirms it before the node is saved.
 */
export async function probeHostKey(route: SshRoute): Promise<{ hop: number; fingerprint: string }> {
	const index = route.hops.findIndex((h) => !h.hostKey);
	if (index < 0) throw new Error("every hop is already pinned");
	const pinned = route.hops.slice(0, index);
	const session = pinned.length > 0 ? await connect({ ...route, hops: pinned }) : undefined;
	try {
		const hop = route.hops[index] as SshHop;
		const sock = session ? await session.forwardTo(hop.host, hop.port) : undefined;
		let seen: string | undefined;
		try {
			const c = await connectHop(hop, route.privateKey, sock, (key) => {
				seen = hostKeyFingerprint(key);
				return false; // stop before authenticating
			});
			c.end();
		} catch (err) {
			if (!seen) throw err;
		}
		if (!seen) throw new SshError("connect_failed", `no host key from ${hop.host}:${hop.port}`);
		return { hop: index, fingerprint: seen };
	} finally {
		session?.close();
	}
}

function forward(client: Client, host: string, port: number): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		client.forwardOut("127.0.0.1", 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
	});
}

function connectHop(
	hop: SshHop,
	privateKey: string,
	sock: Duplex | undefined,
	verify: (key: Buffer) => boolean,
): Promise<Client> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let verifyError: unknown;
		const config: ConnectConfig = {
			host: hop.host,
			port: hop.port,
			username: hop.user,
			privateKey,
			readyTimeout: CONNECT_TIMEOUT_MS,
			keepaliveInterval: KEEPALIVE_MS,
			keepaliveCountMax: 3,
			hostVerifier: (key: Buffer) => {
				try {
					return verify(key);
				} catch (err) {
					verifyError = err;
					return false;
				}
			},
			...(sock ? { sock } : {}),
		};
		client.once("ready", () => resolve(client));
		client.once("error", (err) => {
			client.end();
			reject(verifyError ?? new SshError("connect_failed", `${hop.user}@${hop.host}:${hop.port}: ${err.message}`));
		});
		client.connect(config);
	});
}
