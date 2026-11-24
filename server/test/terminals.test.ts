/**
 * The terminal subsystem (doc/design/pty.md): opens and refusals, the data connection's replay and
 * replacement, the viewers, the exited retention, helper_lost, pty.list adoption, the settings switch,
 * node removal, associations, session deletion and the API access matrix and attach WebSocket.
 *
 * crha is a fake peer on the wire (helpers/agent.ts): the test plays the node's part, so every byte and
 * command is the real protocol.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair } from "@crh/noise";
import {
	type Authorization,
	authorizationCodec,
	encode as encodeCbor,
	type PtyOpen,
	type TrustEntry,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { createRootRuleSet, setRulePreset } from "../src/policy/store.ts";
import { loadAuthorizationSigningKeys } from "../src/privilege/key.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import { DEFAULT_SYSTEM_SETTINGS, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TerminalAttachServer } from "../src/terminals/attach.ts";
import { INPUT_BUFFER_BYTES, TerminalService } from "../src/terminals/registry.ts";
import { ptyWrite } from "../src/terminals/tools.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, PTY_REQUIRED_NAMES, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey } from "./helpers/authenticator.ts";
import { openTestDb, revokeNodeGrantAfterList } from "./helpers/db.ts";
import { registerSshCredential } from "./helpers/signing-credentials.ts";

const EXITED_MS = 60;

/** A fake browser socket: the service only needs send/close and a ready state. */
class FakeViewerSocket {
	readyState = 1;
	readonly OPEN = 1;
	bufferedAmount = 0;
	readonly sent: unknown[] = [];
	send(
		data: unknown,
		options?: { binary?: boolean } | ((err?: Error) => void),
		callback?: (err?: Error) => void,
	): void {
		this.sent.push(data);
		const done = typeof options === "function" ? options : callback;
		done?.();
	}
	close(): void {
		this.readyState = 3;
	}
	terminate(): void {
		this.readyState = 3;
	}
}

function userOf(row: { id: string; username: string }, kind: "member" | "admin" = "member") {
	return { userId: row.id, username: row.username, kind, sessionId: `session:${row.id}` };
}

describe("terminals", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let identity: ServerIdentity;
	let settings: SettingsStore;
	let terminals: TerminalService;
	let audit: Audit;
	let signingKeys: Awaited<ReturnType<typeof loadAuthorizationSigningKeys>>;
	let owner: { id: string; username: string };
	let other: { id: string; username: string };
	let admin: { id: string; username: string };

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		settings = SettingsStore.fromSystemSettings(DEFAULT_SYSTEM_SETTINGS);
		// The API tests sign in with a password: the default captcha is turned off through the store.
		await settings.patch(db, { auth: { captcha: "none" } }, null);
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signingKeys = await loadAuthorizationSigningKeys(db, masterKey);
		cluster = new Cluster(db, { signingKeys });
		identity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		owner = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		other = await createUser(db, { username: "other", kind: "member", password: "password-456" });
		admin = await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		// The tools' rule chain reads a root rule set; Yolo lets the open tests through and a per-test
		// preset changes it where the rules are the subject.
		await createRootRuleSet(db, await defaultOrgId(db), { type: "user", id: owner.id }, "yolo");
		await createRootRuleSet(db, await defaultOrgId(db), { type: "user", id: other.id }, "yolo");
		await createRootRuleSet(db, await defaultOrgId(db), { type: "user", id: admin.id }, "yolo");
		audit = new Audit(db);
		terminals = new TerminalService({
			db,
			cluster,
			settings,
			audit,
			exitedRetentionMs: EXITED_MS,
			idleSweepMs: 10,
			sessionState: async (id) => {
				const row = await db.selectFrom("sessions").select("state").where("id", "=", id).executeTakeFirst();
				return row?.state;
			},
		});
		terminals.start();
	});

	afterEach(async () => {
		await terminals.shutdown();
		await agents.close();
		await cluster.close();
		await db.destroy();
	});

	const addNode = async (
		name: string,
		key: Uint8Array,
		options: { transport?: "client" | "ssh"; userId?: string; mode?: string | null } = {},
	): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport: options.transport ?? "client",
				status: "active",
				public_key: Buffer.from(key).toString("base64"),
				hostname: name,
				facts: null,
				client_version: null,
				privileged_mode: options.mode === undefined ? "forward" : options.mode,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: options.userId ?? owner.id,
				target_type: "node",
				target_id: id,
				created_by_user_id: owner.id,
				created_at: now,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	const connect = async (
		name = "node-1",
		options: { userId?: string; mode?: string; pty?: boolean; transport?: "client" | "ssh" } = {},
	): Promise<{ node: NodeRow; crha: FakeCrha; key: ReturnType<typeof generateKeyPair> }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey, {
			...(options.userId === undefined ? {} : { userId: options.userId }),
			...(options.mode === undefined ? {} : { mode: options.mode }),
			...(options.transport === undefined ? {} : { transport: options.transport }),
		});
		const names = options.pty === false ? undefined : PTY_REQUIRED_NAMES;
		const crha = await agents.connect(
			key,
			names === undefined ? handshakeInit() : handshakeInit({ commands: [...names] }),
			names,
		);
		await crha.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: options.mode ?? "forward" });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return { node, crha, key };
	};

	const openPerson = async (node: NodeRow, overrides: { argv?: string[]; privileged?: boolean } = {}) => {
		const terminal = await terminals.openForPerson({
			user: userOf(owner) as never,
			node: node.id,
			...(overrides.argv === undefined ? {} : { argv: overrides.argv }),
			...(overrides.privileged === undefined ? {} : { privileged: overrides.privileged }),
		});
		await waitFor("terminal running or opening", () => terminals.get(terminal.id) !== undefined);
		return terminal;
	};

	const output = async (terminalId: string, key: ReturnType<typeof generateKeyPair>, text: string) => {
		const connection = await agents.connectPty(key, terminalId);
		await waitFor("data connection accepted", () => terminals.get(terminalId)?.connection !== null);
		connection.send({ kind: "data", bytes: new TextEncoder().encode(text) });
		const needle = (text.split(/\r?\n/)[0] ?? "").trimEnd();
		await waitFor("output applied", async () => {
			const view = terminals.get(terminalId);
			if (!view?.screen) return false;
			await view.screen.whenIdle();
			return (await view.screen.screen()).text.includes(needle);
		});
		return connection;
	};

	it("opens a terminal, sends pty.open and reaches running", async () => {
		const { node, crha } = await connect();
		const terminal = await openPerson(node, { argv: ["/bin/sh"], privileged: false });
		await waitFor("running", () => terminal.state === "running");
		const open = crha.ptyOpens[0] as unknown as PtyOpen;
		expect(open.ptyId).toBe(terminal.id);
		expect(open.argv).toEqual(["/bin/sh"]);
		expect(open.privileged).toBe(false);
		expect(open.attempt).toBe(0);
		expect(open.authorizations).toEqual([]);
		expect(open.cosign).toBeNull();
		expect(open).not.toHaveProperty("meta");
		expect(terminal.nodeName).toBe("node-1");
	});

	it("answers terminal queries from its headless emulator, once for every viewer", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		const connection = await agents.connectPty(key, terminal.id);
		await waitFor("data connection", () => terminals.get(terminal.id)?.connection !== null);
		const encoder = new TextEncoder();
		const text = (frame: Awaited<ReturnType<typeof connection.next>>) =>
			frame.kind === "data" ? new TextDecoder().decode(frame.bytes) : frame.kind;

		// crhs's own emulator parses the output, so it answers the queries the program asks: cursor
		// position first, then device attributes, in the order the program wrote them.
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[5;10H\u001b[6n\u001b[c") });
		expect(text(await connection.next())).toBe("\u001b[5;10R");
		expect(text(await connection.next())).toBe("\u001b[?1;2c");

		// Every browser forwards only its user's input, so two viewers add no answers of their own.
		await terminals.attachViewer(terminal, userOf(owner) as never, new FakeViewerSocket() as never, null);
		await terminals.attachViewer(terminal, userOf(owner) as never, new FakeViewerSocket() as never, null);
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[6n") });
		expect(text(await connection.next())).toBe("\u001b[5;10R");
		expect(
			await Promise.race([
				connection.next().then(text),
				new Promise<string>((resolve) => setTimeout(() => resolve("no reply"), 100)),
			]),
		).toBe("no reply");

		// The answers are input bytes like any other: the 64 KiB resend buffer continues them on a
		// reconnected data connection.
		const replaced = await agents.connectPty(key, terminal.id, 0);
		expect(text(await replaced.next())).toBe("\u001b[5;10R\u001b[?1;2c\u001b[5;10R");
		replaced.close();
		connection.close();
	});

	it("refuses a disabled subsystem, SSH nodes, offline nodes, old crha and the limits", async () => {
		const { node } = await connect();
		const ssh = await addNode("ssh-1", generateKeyPair().publicKey, { transport: "ssh" });
		await settings.patch(db, { pty: { enabled: false } }, null);
		terminals.applySettings();
		await expect(terminals.openForPerson({ user: userOf(owner) as never, node: node.id })).rejects.toMatchObject({
			code: "disabled",
		});
		await settings.patch(db, { pty: { enabled: true } }, null);
		await expect(terminals.openForPerson({ user: userOf(owner) as never, node: ssh.id })).rejects.toMatchObject({
			code: "unsupported_node",
		});
		const offline = await addNode("offline-1", generateKeyPair().publicKey);
		await expect(terminals.openForPerson({ user: userOf(owner) as never, node: offline.id })).rejects.toMatchObject({
			code: "node_offline",
		});
		// A node whose handshake did not offer the terminal names.
		const old = await connect("old-1", { pty: false });
		await expect(terminals.openForPerson({ user: userOf(owner) as never, node: old.node.id })).rejects.toMatchObject({
			code: "unsupported_node",
		});
		await settings.patch(db, { pty: { maxPerNode: 1 } }, null);
		await openPerson(node);
		await expect(terminals.openForPerson({ user: userOf(owner) as never, node: node.id })).rejects.toMatchObject({
			code: "limit_node",
		});
	});

	it("continues output and resends only unacknowledged input on a new data connection", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		const first = await output(terminal.id, key, "hello\r\n");
		expect((await terminals.screen(terminal)).text).toContain("hello");
		// Three input bytes reach the node; it reports that it received only the first.
		await terminals.write(terminal, new TextEncoder().encode("abc"));
		const sent = await first.next();
		expect(sent.kind === "data" ? new TextDecoder().decode(sent.bytes) : "").toBe("abc");

		const second = await agents.connectPty(key, terminal.id, 1);
		// The handshake states where the output stream continues: no replay, no gap.
		expect(second.response.outputReceived).toBe(new TextEncoder().encode("hello\r\n").length);
		await waitFor("old connection closed", () => first.ws.readyState === WebSocket.CLOSED);
		// The buffer resends exactly the missing input bytes, once.
		const resent = await second.next();
		expect(resent.kind === "data" ? new TextDecoder().decode(resent.bytes) : "").toBe("bc");
		await terminals.write(terminal, new TextEncoder().encode("d"));
		const next = await second.next();
		expect(next.kind === "data" ? new TextDecoder().decode(next.bytes) : "").toBe("d");

		// The screen keeps what it had and continues with what arrives next.
		second.send({ kind: "data", bytes: new TextEncoder().encode("world\r\n") });
		await waitFor("continued output", async () => {
			const screen = terminals.get(terminal.id)?.screen;
			if (!screen) return false;
			await screen.whenIdle();
			const text = (await terminals.screen(terminal)).text;
			return text.includes("hello") && text.includes("world");
		});
		second.close();
	});

	it("closes stream_lost when the input buffer no longer holds what crha missed", async () => {
		const { node, crha, key } = await connect();
		const terminal = await openPerson(node);
		const first = await agents.connectPty(key, terminal.id);
		await waitFor("data connection", () => terminals.get(terminal.id)?.connection !== null);
		// More input than the buffer keeps: crha reports it received none of it.
		await terminals.write(terminal, new Uint8Array(INPUT_BUFFER_BYTES + 1024));
		const second = await agents.connectPty(key, terminal.id, 0);
		const abort = await second.next();
		expect(abort).toEqual({ kind: "abort", code: "stream_lost" });
		await waitFor("terminal closed", () => terminals.get(terminal.id) === undefined);
		await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
		expect(crha.ptyCloses.at(-1)).toEqual({ ptyId: terminal.id, reason: "stream_lost" });
		first.close();
		second.close();
	});

	it("closes stream_lost when crha aborts the connection", async () => {
		const { node, crha, key } = await connect();
		const terminal = await openPerson(node);
		const connection = await agents.connectPty(key, terminal.id);
		await waitFor("data connection", () => terminals.get(terminal.id)?.connection !== null);
		connection.send({ kind: "abort", code: "stream_lost" });
		await waitFor("terminal closed", () => terminals.get(terminal.id) === undefined);
		await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
		expect(crha.ptyCloses.at(-1)).toEqual({ ptyId: terminal.id, reason: "stream_lost" });
	});

	it("gives a joining viewer the snapshot first, then live bytes, and never a reset", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		await output(terminal.id, key, "prompt$ ");
		const socket = new FakeViewerSocket();
		await terminals.attachViewer(terminal, userOf(owner) as never, socket as never, "127.0.0.1");
		const first = socket.sent[0];
		expect(typeof first).toBe("string");
		const snapshot = JSON.parse(first as string) as { type: string; data: string };
		expect(snapshot.type).toBe("snapshot");
		expect(snapshot.data).toContain("prompt$");
		// A replacement data connection continues the stream; the viewer's screen is not reset.
		const connection = await agents.connectPty(key, terminal.id);
		connection.send({ kind: "data", bytes: new TextEncoder().encode("live") });
		await waitFor("live bytes", () =>
			socket.sent.some((frame) => frame instanceof Uint8Array && new TextDecoder().decode(frame).includes("live")),
		);
		expect(
			socket.sent.some(
				(frame) => typeof frame === "string" && (JSON.parse(frame) as { type: string }).type === "reset",
			),
		).toBe(false);
		expect(terminal.viewers.size).toBe(1);
	});

	it("keeps the program's title, broadcasts it and never uses it as the node label", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		const connection = await agents.connectPty(key, terminal.id);
		await waitFor("data connection", () => terminals.get(terminal.id)?.connection !== null);
		const socket = new FakeViewerSocket();
		await terminals.attachViewer(terminal, userOf(owner) as never, socket as never, null);

		connection.send({
			kind: "data",
			bytes: new TextEncoder().encode("\u001b]0;  build   log ready \u0007"),
		});
		await waitFor("title", () => terminal.title === "build log ready");

		const view = await terminals.view(terminal);
		expect(view.title).toBe("build log ready");
		// The trusted label stays the node name.
		expect(view.nodeName).toBe("node-1");
		const frames = socket.sent
			.filter((frame): frame is string => typeof frame === "string")
			.map((frame) => JSON.parse(frame) as { type: string; title?: string });
		expect(frames.some((frame) => frame.type === "state" && frame.title === "build log ready")).toBe(true);
		connection.close();
	});

	it("keeps an exited terminal for the retention or until its last viewer detaches, then closes it", async () => {
		const { node, crha } = await connect();
		const terminal = await openPerson(node);
		crha.peer.emit("pty.exited", { ptyId: terminal.id, exitCode: 7, reason: "exited" });
		await waitFor("exited", () => terminal.state === "exited" && terminal.exitCode === 7);
		const socket = new FakeViewerSocket();
		await terminals.attachViewer(terminal, userOf(owner) as never, socket as never, null);
		await new Promise((resolve) => setTimeout(resolve, EXITED_MS + 20));
		// The viewer kept it past the retention.
		expect(terminals.get(terminal.id)).toBeDefined();
		const viewer = [...terminal.viewers.values()][0];
		if (!viewer) throw new Error("missing viewer");
		terminals.detachViewer(terminal, viewer);
		await waitFor("retired", () => terminals.get(terminal.id) === undefined);
		await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
		expect(crha.ptyCloses.at(-1)).toEqual({ ptyId: terminal.id, reason: "exited" });
	});

	it("opens a privileged terminal through crhs's trust and reports helper_lost", async () => {
		const { node, crha } = await connect();
		const key = signingKeys.newest;
		if (!key) throw new Error("missing signing key");
		const summary = {
			nodeId: node.id,
			aliases: [],
			clockSkewMs: 0,
			identities: { unprivileged: { uid: 998, gid: 998, user: "crha" }, privileged: { uid: 0, gid: 0, user: "root" } },
			trust: [
				{
					name: "crhs",
					source: "local" as const,
					role: "crhs" as const,
					key: { kind: "sshsig" as const, publicKey: key.authorizedKey, fingerprint: key.fingerprint },
					kinds: ["execute" as const, "cosign" as const],
					requireSpec: true,
					requireTask: false,
					requireUv: false,
					maxTtlMs: 5 * 60 * 1000,
					allow: [],
					deny: [],
					envAllow: [],
				},
			],
			localWindow: { kind: "open" as const, openedByUid: 0, openedAtMs: 1, untilMs: Number.MAX_SAFE_INTEGER },
		};
		crha.trust({ kind: "ok", summary });
		await waitFor("trust stored", async () => {
			const row = await db.selectFrom("nodes").select("trust_report").where("id", "=", node.id).executeTakeFirst();
			return row?.trust_report !== null && row?.trust_report !== undefined;
		});
		const terminal = await terminals.openForPerson({ user: userOf(owner) as never, node: node.id, privileged: true });
		await waitFor("opened", () => crha.ptyOpens.length === 1);
		await waitFor("running", () => terminal.state === "running");
		const open = crha.ptyOpens[0] as unknown as PtyOpen;
		expect(open.privileged).toBe(true);
		expect(open.attempt).toBe(1);
		expect(open.authorizations).toHaveLength(1);
		crha.peer.emit("pty.exited", { ptyId: terminal.id, exitCode: -1, reason: "helper_lost" });
		await waitFor("exited", () => terminal.state === "exited");
		expect(terminal.exitCode).toBe(-1);
		expect(terminal.exitReason).toBe("helper_lost");
	});

	it("reconciles pty.list: continues a held terminal, drops unknown ones and closes unlisted ones", async () => {
		const { node, crha } = await connect();
		const terminal = await openPerson(node);
		const unknown = newId();
		// crhs holds the first id and not the second: the second is forgotten by a crhs restart, so it
		// is dropped on the node, never adopted.
		crha.peer.emit("pty.list", {
			terminals: [
				{ ptyId: terminal.id, exited: false, exitCode: 0 },
				{ ptyId: unknown, exited: false, exitCode: 0 },
			],
		});
		await waitFor("unknown listed terminal dropped", () => crha.ptyCloses.some((close) => close.ptyId === unknown));
		expect(crha.ptyCloses.at(-1)).toEqual({ ptyId: unknown, reason: "crhs_restarted" });
		expect(terminals.get(unknown)).toBeUndefined();
		expect(terminals.get(terminal.id)).toBeDefined();
		// An exit crhs missed while its control connection was down comes from the list.
		crha.peer.emit("pty.list", { terminals: [{ ptyId: terminal.id, exited: true, exitCode: 9 }] });
		await waitFor("exit taken from the list", () => terminal.state === "exited" && terminal.exitCode === 9);
		// A held terminal the node no longer lists is gone from crha: it is closed locally, and no
		// pty.close is sent for it.
		crha.peer.emit("pty.list", { terminals: [] });
		await waitFor("unlisted terminal closed", () => terminals.get(terminal.id) === undefined);
		expect(crha.ptyCloses.some((close) => close.ptyId === terminal.id)).toBe(false);
		await audit.flush();
		const closed = await db
			.selectFrom("audit_events")
			.select("detail")
			.where("action", "=", "pty.closed")
			.where("target_id", "=", terminal.id)
			.executeTakeFirst();
		expect(JSON.parse(closed?.detail ?? "{}")).toMatchObject({ reason: "crha_restarted" });
		await waitFor("unknown drop audited", async () => {
			await audit.flush();
			const row = await db
				.selectFrom("audit_events")
				.select("detail")
				.where("action", "=", "pty.closed")
				.where("target_id", "=", unknown)
				.executeTakeFirst();
			return (JSON.parse(row?.detail ?? "{}") as { reason?: string }).reason === "crhs_restarted";
		});
	});

	it("keeps a watch across a data-connection reconnect without matching earlier output", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		await output(terminal.id, key, "before-reconnect\r\n");
		// The watch starts after the keyword was written: it matches only output written from now on,
		// and the continued stream never repeats it.
		const watching = terminals.watch(terminal, "watcher", {
			timeoutMs: 300,
			keywords: ["before-reconnect"],
			bell: false,
		});
		const second = await agents.connectPty(key, terminal.id, 0);
		const result = await watching;
		expect(result.reason).toBe("timeout");
		second.close();
	});

	it("refuses a data connection from another node and keeps the real one", async () => {
		const { node, key } = await connect();
		const terminal = await openPerson(node);
		const real = await agents.connectPty(key, terminal.id);
		await waitFor("real connection", () => terminals.get(terminal.id)?.connection !== null);
		expect(terminals.get(terminal.id)?.connection?.nodeId).toBe(node.id);

		const { key: strangerKey } = await connect("node-2");
		// The handshake answers only for a terminal this node holds; a stranger's connection is closed
		// before it can replace the real one.
		await expect(agents.connectPty(strangerKey, terminal.id)).rejects.toThrow(/closed: 1008/);
		expect(terminals.get(terminal.id)?.connection?.nodeId).toBe(node.id);
		real.close();
	});

	it("closes a node's terminals when its key is revoked by re-enrollment", async () => {
		const { node, crha } = await connect();
		const terminal = await openPerson(node);
		cluster.nodeRevoked(node.id);
		await waitFor("revoked node's terminal closed", () => terminals.get(terminal.id) === undefined);
		await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
		expect(crha.ptyCloses.at(-1)).toMatchObject({ ptyId: terminal.id, reason: "node_removed" });
	});

	it("closes a user's terminals when the user is removed, and leaves another user's alone", async () => {
		const { node, crha } = await connect();
		const { node: otherNode } = await connect("node-2", { userId: other.id });
		const owned = await openPerson(node);
		const otherTerminal = await terminals.openForPerson({ user: userOf(other) as never, node: otherNode.id });
		await waitFor("both running", () => owned.state === "running" && otherTerminal.state === "running");
		terminals.userRemoved(owner.id);
		await waitFor("removed user's terminal closed", () => terminals.get(owned.id) === undefined);
		await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === owned.id));
		expect(crha.ptyCloses.at(-1)).toMatchObject({ ptyId: owned.id, reason: "user_removed" });
		expect(terminals.get(otherTerminal.id)).toBeDefined();
	});

	it("associates sessions and unassociates them", async () => {
		const { node } = await connect();
		const terminal = await openPerson(node);
		const session = await createSessionRow(db, owner.id, "assoc");
		await terminals.associate(terminal, session.id, userOf(owner) as never);
		expect(terminal.sessionIds).toEqual([session.id]);
		await terminals.unassociate(terminal, session.id, userOf(owner) as never);
		expect(terminal.sessionIds).toEqual([]);
		// The association is refused for someone else's session.
		const foreign = await createSessionRow(db, other.id, "foreign");
		await expect(terminals.associate(terminal, foreign.id, userOf(owner) as never)).rejects.toMatchObject({
			code: "session_not_owned",
		});
	});

	it("closes a terminal when its creating session is deleted and unassociates a deleted associated session", async () => {
		const { node } = await connect();
		const session = await createSessionRow(db, owner.id, "creator");
		const terminal = await terminals.openForAgent({
			user: userOf(owner) as never,
			sessionId: session.id,
			chain: [{ type: "user", id: owner.id }],
			node: node.id,
			idleTimeoutMs: 60_000,
		});
		const associated = await createSessionRow(db, owner.id, "assoc");
		await terminals.associate(terminal, associated.id, userOf(owner) as never);
		terminals.sessionDeleted(associated.id);
		expect(terminal.sessionIds).toEqual([]);
		expect(terminals.get(terminal.id)).toBeDefined();
		terminals.sessionDeleted(session.id);
		expect(terminals.get(terminal.id)).toBeUndefined();
	});

	it("closes an agent terminal only when no viewer, no watch and every session are idle", async () => {
		const { node, crha } = await connect();
		const session = await createSessionRow(db, owner.id, "creator", "running");
		const terminal = await terminals.openForAgent({
			user: userOf(owner) as never,
			sessionId: session.id,
			chain: [{ type: "user", id: owner.id }],
			node: node.id,
			idleTimeoutMs: 40,
		});
		// The creating session runs: not idle, so the timer never starts.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(terminals.get(terminal.id)).toBeDefined();
		await db.updateTable("sessions").set({ state: "idle" }).where("id", "=", session.id).execute();
		await waitFor("idle close", () => terminals.get(terminal.id) === undefined);
		expect(crha.ptyCloses.at(-1)).toMatchObject({ ptyId: terminal.id, reason: "idle" });
	});

	it("keeps a person-opened terminal when every session is idle", async () => {
		const { node } = await connect();
		const session = await createSessionRow(db, owner.id, "creator", "idle");
		const terminal = await terminals.openForPerson({ user: userOf(owner) as never, node: node.id });
		await terminals.associate(terminal, session.id, userOf(owner) as never);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(terminals.get(terminal.id)).toBeDefined();
	});

	/**
	 * The idle-sweep tests drive the interval themselves (setInterval is faked, wall-clock time is
	 * faked with it) and hold each session-state read on its own promise, so nothing depends on how
	 * long a real timer or a database read takes.
	 */
	const sweepTerminal = async (
		node: NodeRow,
		idleTimeoutMs: number,
		sessionState: () => Promise<SessionRunState>,
	): Promise<{ service: TerminalService; terminal: Awaited<ReturnType<TerminalService["openForAgent"]>> }> => {
		const session = await createSessionRow(db, owner.id, "sweep");
		const service = new TerminalService({
			db,
			cluster,
			settings,
			audit,
			exitedRetentionMs: EXITED_MS,
			idleSweepMs: 10,
			sessionState,
		});
		const terminal = await service.openForAgent({
			user: userOf(owner) as never,
			sessionId: session.id,
			chain: [{ type: "user", id: owner.id }],
			node: node.id,
			idleTimeoutMs,
		});
		return { service, terminal };
	};

	/** Runs `body` with fake sweep timers, then settles every held read and shuts the service down. */
	const withSweepTimers = async (
		service: TerminalService,
		reads: Deferred<SessionRunState>[],
		body: () => Promise<void>,
	): Promise<void> => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		service.start();
		try {
			await body();
		} finally {
			for (const read of reads) read.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			await service.shutdown();
			vi.useRealTimers();
		}
	};

	/** Yields to real I/O (setImmediate is not faked) until `done`, without a wall-clock sleep. */
	const waitForIo = async (done: () => boolean): Promise<void> => {
		for (let i = 0; i < 500 && !done(); i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
	};

	it("does not overlap idle sweeps while a session-state read is held", async () => {
		const { node, crha } = await connect();
		const reads: Deferred<SessionRunState>[] = [];
		const { service, terminal } = await sweepTerminal(node, 5, () => {
			const read = deferred<SessionRunState>();
			reads.push(read);
			return read.promise;
		});
		await withSweepTimers(service, reads, async () => {
			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(1);
			// More intervals pass while the first sweep still awaits: every tick is skipped.
			await vi.advanceTimersByTimeAsync(40);
			expect(reads).toHaveLength(1);
			expect(service.get(terminal.id)).toBe(terminal);

			reads[0]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			expect(terminal.idleSince).not.toBeNull();

			// The next tick starts one fresh sweep, which sees the timeout elapsed and closes once.
			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(2);
			reads[1]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			expect(service.get(terminal.id)).toBeUndefined();
			await waitForIo(() => crha.ptyCloses.length > 0);
			expect(crha.ptyCloses.filter((close) => close.ptyId === terminal.id)).toEqual([
				{ ptyId: terminal.id, reason: "idle" },
			]);
		});
	});

	it("logs a rejected idle sweep, stays alive, and closes on a later sweep", async () => {
		const { node, crha } = await connect();
		const failure = new Error("session state read failed");
		const reads: Deferred<SessionRunState>[] = [];
		let calls = 0;
		const { service, terminal } = await sweepTerminal(node, 5, () => {
			calls += 1;
			if (calls === 1) return Promise.reject(failure);
			const read = deferred<SessionRunState>();
			reads.push(read);
			return read.promise;
		});
		const errors: unknown[][] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args);
		});
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			await withSweepTimers(service, reads, async () => {
				await vi.advanceTimersByTimeAsync(10);
				expect(calls).toBe(1);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(rejections).toEqual([]);
				expect(errors).toEqual([["idle sweep failed:", failure]]);

				// The rejection neither stops the interval nor leaves the in-flight flag set.
				await vi.advanceTimersByTimeAsync(10);
				expect(calls).toBe(2);
				reads[0]?.resolve("idle");
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(10);
				expect(calls).toBe(3);
				reads[1]?.resolve("idle");
				await vi.advanceTimersByTimeAsync(0);
				expect(service.get(terminal.id)).toBeUndefined();
				await waitForIo(() => crha.ptyCloses.length > 0);
				expect(crha.ptyCloses.filter((close) => close.ptyId === terminal.id)).toEqual([
					{ ptyId: terminal.id, reason: "idle" },
				]);
			});
		} finally {
			process.off("unhandledRejection", onRejection);
			errorSpy.mockRestore();
		}
	});

	it("keeps an agent terminal open when a viewer attaches during the session read", async () => {
		const { node } = await connect();
		const reads: Deferred<SessionRunState>[] = [];
		const { service, terminal } = await sweepTerminal(node, 20, () => {
			const read = deferred<SessionRunState>();
			reads.push(read);
			return read.promise;
		});
		await withSweepTimers(service, reads, async () => {
			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(1);
			await service.attachViewer(
				terminal,
				userOf(owner) as never,
				new FakeViewerSocket() as unknown as WebSocket,
				null,
			);
			reads[0]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			// The viewer arrived while the sweep awaited: the timer must not have started.
			expect(terminal.idleSince).toBeNull();
			expect(service.get(terminal.id)).toBe(terminal);
			await vi.advanceTimersByTimeAsync(200);
			expect(service.get(terminal.id)).toBe(terminal);
			expect(terminal.idleSince).toBeNull();
		});
	});

	it("reads the clock after the session read so a held sweep does not age the timer", async () => {
		const { node } = await connect();
		const reads: Deferred<SessionRunState>[] = [];
		const { service, terminal } = await sweepTerminal(node, 20, () => {
			const read = deferred<SessionRunState>();
			reads.push(read);
			return read.promise;
		});
		await withSweepTimers(service, reads, async () => {
			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(1);
			// The read is held for 90 ms; the sweep's clock must not be the one from before it.
			await vi.advanceTimersByTimeAsync(90);
			reads[0]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			const idleSince = terminal.idleSince;
			expect(idleSince).not.toBeNull();

			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(2);
			reads[1]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			// 10 ms of the 20 ms timeout: still idle, not closed with the stale start.
			expect(terminal.idleSince).toBe(idleSince);
			expect(service.get(terminal.id)).toBe(terminal);

			// The timer runs out on the next sweep.
			await vi.advanceTimersByTimeAsync(10);
			expect(reads).toHaveLength(3);
			reads[2]?.resolve("idle");
			await vi.advanceTimersByTimeAsync(0);
			expect(service.get(terminal.id)).toBeUndefined();
		});
	});

	it("stops the interval and waits for an in-flight sweep at shutdown", async () => {
		const { node } = await connect();
		const reads: Deferred<SessionRunState>[] = [];
		let calls = 0;
		const { service, terminal } = await sweepTerminal(node, 60_000, () => {
			calls += 1;
			const read = deferred<SessionRunState>();
			reads.push(read);
			return read.promise;
		});
		let shutdown: Promise<void> | undefined;
		let stopped = false;
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		service.start();
		try {
			await vi.advanceTimersByTimeAsync(10);
			expect(calls).toBe(1);
			shutdown = service.shutdown().then(() => {
				stopped = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(stopped).toBe(false);
			reads[0]?.resolve("idle");
			await shutdown;
			expect(stopped).toBe(true);
			expect(service.get(terminal.id)).toBeUndefined();
			// The interval is gone: no later tick reads a session state.
			await vi.advanceTimersByTimeAsync(100);
			expect(calls).toBe(1);
		} finally {
			for (const read of reads) read.resolve("idle");
			await shutdown?.catch(() => {});
			await service.shutdown();
			vi.useRealTimers();
		}
	});

	describe("API", () => {
		let app: App;
		let server: Server;
		let attach: TerminalAttachServer;
		let base: string;

		beforeEach(async () => {
			app = makeApp(db, undefined, { cluster, terminals, settings, serverFingerprint: "test-server" });
			attach = new TerminalAttachServer(db, terminals, {
				realIpHeader: () => settings.current().realIpHeader,
			});
			server = createServer((req, res) => {
				void (async () => {
					const response = await app.fetch(
						new Request(`http://localhost${req.url ?? "/"}`, {
							method: req.method,
							headers: req.headers as Record<string, string>,
						}),
					);
					res.writeHead(response.status, Object.fromEntries(response.headers));
					res.end(Buffer.from(await response.arrayBuffer()));
				})();
			});
			server.on("upgrade", (req, socket, head) => {
				if (!attach.handleUpgrade(req, socket, head)) socket.destroy();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		afterEach(async () => {
			if (attach) await attach.close();
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("lists and shows a terminal to its user and administrators, never to another member", async () => {
			const { node } = await connect();
			const terminal = await openPerson(node);
			const ownerCookie = await login(app, "owner", "password-123");
			const otherCookie = await login(app, "other", "password-456");
			const adminCookie = await login(app, "root", "root-password");
			const ownerList = await call(app, "/api/ptys", { cookie: ownerCookie });
			expect(ownerList.status).toBe(200);
			const body = (await ownerList.json()) as { enabled: boolean; terminals: { id: string }[] };
			expect(body.enabled).toBe(true);
			expect(body.terminals.map((entry) => entry.id)).toEqual([terminal.id]);
			expect((await call(app, `/api/ptys/${terminal.id}`, { cookie: ownerCookie })).status).toBe(200);
			expect((await call(app, `/api/ptys/${terminal.id}`, { cookie: otherCookie })).status).toBe(404);
			expect(
				((await (await call(app, "/api/ptys", { cookie: otherCookie })).json()) as { terminals: unknown[] }).terminals,
			).toEqual([]);
			expect((await call(app, `/api/ptys/${terminal.id}`, { cookie: adminCookie })).status).toBe(200);
			expect(
				((await (await call(app, "/api/ptys", { cookie: adminCookie })).json()) as { terminals: unknown[] }).terminals,
			).toHaveLength(1);
		});

		it("creates, resizes, associates, closes and audits through the API", async () => {
			const { node } = await connect();
			const cookie = await login(app, "owner", "password-123");
			const created = await call(app, "/api/ptys", {
				cookie,
				body: { node: node.id, argv: ["/bin/sh"] },
			});
			expect(created.status).toBe(201);
			const body = (await created.json()) as {
				terminal: { id: string; state: string; size: { rows: number; cols: number } };
			};
			expect(body.terminal.state).toBe("running");
			const id = body.terminal.id;
			const resized = await call(app, `/api/ptys/${id}/resize`, { cookie, body: { rows: 30, cols: 100 } });
			expect(resized.status).toBe(200);
			expect(((await resized.json()) as { terminal: { size: unknown } }).terminal.size).toEqual({
				rows: 30,
				cols: 100,
			});
			const session = await createSessionRow(db, owner.id, "api-assoc");
			const associated = await call(app, `/api/ptys/${id}/sessions/${session.id}`, {
				cookie,
				method: "PUT",
				body: {},
			});
			expect(associated.status).toBe(200);
			expect(
				(await call(app, `/api/ptys/${id}/sessions/${session.id}`, { cookie, method: "DELETE", body: {} })).status,
			).toBe(200);
			expect((await call(app, `/api/ptys/${id}`, { cookie, method: "DELETE", body: {} })).status).toBe(200);
			expect(terminals.get(id)).toBeUndefined();
			await audit.flush();
			const events = await db
				.selectFrom("audit_events")
				.select(["action", "detail"])
				.where("action", "in", ["pty.opened", "pty.closed", "pty.associated", "pty.unassociated"])
				.execute();
			const actions = events.map((row) => row.action);
			expect(actions).toContain("pty.opened");
			expect(actions).toContain("pty.associated");
			expect(actions).toContain("pty.unassociated");
			expect(actions).toContain("pty.closed");
		});

		it("refuses a member without node access, also when the grant is revoked mid-open", async () => {
			const { node } = await connect();
			const otherCookie = await login(app, "other", "password-456");
			const refused = await call(app, "/api/ptys", {
				cookie: otherCookie,
				body: { node: node.id, argv: ["/bin/sh"] },
			});
			expect(refused.status).toBe(404);

			// The node is listed for the owner, then the grant disappears before the service's second check.
			const racingTerminals = new TerminalService({
				db: revokeNodeGrantAfterList(db, owner.id, node.id),
				cluster,
				settings,
				exitedRetentionMs: EXITED_MS,
				idleSweepMs: 10,
			});
			const racingApp = makeApp(db, undefined, {
				cluster,
				terminals: racingTerminals,
				settings,
				serverFingerprint: "test-server",
			});
			const ownerCookie = await login(racingApp, "owner", "password-123");
			const raced = await call(racingApp, "/api/ptys", {
				cookie: ownerCookie,
				body: { node: node.id, argv: ["/bin/sh"] },
			});
			expect(raced.status).toBe(404);
		});

		it("lists an agent's terminal approval with its terminal action and decides it through the shared route", async () => {
			const { node, key } = await connect();
			const session = await createSessionRow(db, owner.id, "pty-approval");
			await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: session.id }, "yolo");
			const chain = [{ type: "session" as const, id: session.id }];
			const terminal = await terminals.openForAgent({
				user: userOf(owner) as never,
				sessionId: session.id,
				chain,
				node: node.id,
				argv: ["/bin/sh"],
				idleTimeoutMs: 60_000,
			});
			const connection = await agents.connectPty(key, terminal.id);
			await waitFor("data connection", () => terminals.get(terminal.id)?.connection !== null);
			// The approval comes from the root's own default (Ask), so an appended allow rule ends it.
			await setRulePreset(db, { type: "session", id: session.id }, "ask");
			const writing = ptyWrite(
				{
					db,
					user: userOf(owner) as never,
					actor: { type: "session", id: session.id, onBehalfOfUserId: owner.id },
					chain,
					terminals,
				},
				{ id: terminal.id, text: "rm -rf /", keys: ["Enter"] },
			).then(
				(result) => result,
				(error: unknown) => error,
			);
			const cookie = await login(app, "owner", "password-123");
			const otherCookie = await login(app, "other", "password-456");
			const listed = (await (await call(app, "/api/approvals", { cookie })).json()) as {
				ptys: {
					terminalId: string;
					nodeName: string | null;
					rootSessionId: string;
					request: {
						kind: string;
						phase: string;
						action: Record<string, unknown>;
						nodes?: string[];
						alwaysAllow: { option: string; rule: Record<string, unknown> }[];
					};
				}[];
				requests: { kind: string; id: string }[];
			};
			expect(listed.ptys).toHaveLength(1);
			expect(listed.ptys[0]).toMatchObject({
				terminalId: terminal.id,
				nodeName: "node-1",
				rootSessionId: session.id,
				request: {
					kind: "pty",
					phase: "awaiting_user",
					action: { type: "pty.io", input: "rm -rf /", keys: ["Enter"] },
					nodes: ["node-1"],
					alwaysAllow: [{ option: "request" }],
				},
			});
			expect(listed.requests).toContainEqual(expect.objectContaining({ kind: "pty", id: terminal.id }));
			// Another member's approvals list does not carry it.
			const otherList = (await (await call(app, "/api/approvals", { cookie: otherCookie })).json()) as {
				ptys: unknown[];
			};
			expect(otherList.ptys).toEqual([]);
			// The shared decision body decides it, and the waiting tool resumes. "Always allow" appends the
			// server-built candidate to the root of the session's chain.
			const candidate = listed.ptys[0]?.request.alwaysAllow[0]?.rule;
			expect(candidate).toMatchObject({ action: "allow", method: "pty.io", nodes: [node.id] });
			const decided = await call(app, `/api/ptys/${terminal.id}/approval`, {
				cookie,
				body: { decision: "approve", reason: "known command", always: candidate },
			});
			expect(decided.status).toBe(200);
			expect(await writing).toMatchObject({ isError: false });
			const rules = await db
				.selectFrom("rule_sets")
				.select("rules")
				.where("scope_type", "=", "session")
				.where("scope_id", "=", session.id)
				.executeTakeFirst();
			expect(JSON.parse(rules?.rules ?? "[]")).toContainEqual(
				expect.objectContaining({ action: "allow", method: "pty.io", nodes: [node.id] }),
			);
			const frame = await connection.next();
			expect(frame.kind === "data" ? new TextDecoder().decode(frame.bytes) : "").toBe("rm -rf /\r");
			// The wait is gone from the list once decided.
			const after = (await (await call(app, "/api/approvals", { cookie })).json()) as { ptys: unknown[] };
			expect(after.ptys).toEqual([]);
		});

		it("lists an agent's privileged terminal signature wait and rejects it through the terminal route", async () => {
			const { node, crha } = await connect();
			const ownerKey = createSshKey();
			const identity = {
				unprivileged: { uid: 998, gid: 998, user: "crha" },
				privileged: { uid: 0, gid: 0, user: "root" },
			};
			const entry: TrustEntry = {
				name: "alice",
				source: "local",
				role: "user",
				key: { kind: "sshsig", publicKey: ownerKey.line, fingerprint: ownerKey.fingerprint },
				kinds: ["execute"],
				requireSpec: false,
				requireTask: false,
				requireUv: false,
				maxTtlMs: 24 * 60 * 60 * 1000,
				allow: [],
				deny: [],
				envAllow: [],
			};
			crha.trust({
				kind: "ok",
				summary: {
					nodeId: node.id,
					aliases: [],
					clockSkewMs: 0,
					identities: identity,
					trust: [entry],
					localWindow: { kind: "closed" },
				},
			});
			await waitFor("trust stored", async () => {
				const row = await db.selectFrom("nodes").select("trust_report").where("id", "=", node.id).executeTakeFirst();
				return row?.trust_report !== null && row?.trust_report !== undefined;
			});
			const cookie = await login(app, "owner", "password-123");
			expect((await registerSshCredential(app, cookie, ownerKey, "alice")).status).toBe(201);

			const session = await createSessionRow(db, owner.id, "pty-signature");
			await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: session.id }, "yolo");
			const opening = terminals
				.openForAgent({
					user: userOf(owner) as never,
					sessionId: session.id,
					chain: [{ type: "session" as const, id: session.id }],
					node: node.id,
					argv: ["/bin/sh"],
					privileged: true,
					idleTimeoutMs: 60_000,
				})
				.then(
					(terminal) => ({ terminal }),
					(error: unknown) => ({ error }),
				);
			const view = await waitFor("terminal signature wait", async () => {
				const views = await terminals.views(userOf(owner) as never);
				return views.find((entry) => entry.creatingSessionId === session.id && entry.authorizationPhase === "waiting");
			});
			expect(terminals.hasPendingAuthorization(session.id)).toBe(true);
			expect(terminals.pendingAuthorizationSessions()).toContain(session.id);

			const listed = (await (await call(app, "/api/approvals", { cookie })).json()) as {
				authorizations: {
					ptys: {
						terminalId: string;
						nodeName: string | null;
						rootSessionId: string;
						request: {
							kind: string;
							phase: string;
							action: Record<string, unknown>;
							nodes?: string[];
							alwaysAllow: unknown[];
						};
					}[];
				};
				requests: { kind: string; id: string; phase: string }[];
			};
			expect(listed.authorizations.ptys).toHaveLength(1);
			expect(listed.authorizations.ptys[0]).toMatchObject({
				terminalId: view.id,
				nodeName: "node-1",
				rootSessionId: session.id,
				request: {
					kind: "pty",
					phase: "awaiting_signature",
					action: { type: "pty.create", argv: ["/bin/sh"] },
					nodes: ["node-1"],
					alwaysAllow: [],
				},
			});
			expect(listed.requests).toContainEqual(
				expect.objectContaining({ kind: "pty", id: view.id, phase: "awaiting_signature" }),
			);

			const rejected = await call(app, `/api/ptys/${view.id}/authorization/reject`, {
				cookie,
				body: { reason: "not now" },
			});
			expect(rejected.status).toBe(200);
			const outcome = (await opening) as { error?: { code?: string } };
			expect(outcome.error?.code).toBe("authorization_declined");
			expect(terminals.hasPendingAuthorization(session.id)).toBe(false);
			const after = (await (await call(app, "/api/approvals", { cookie })).json()) as {
				authorizations: { ptys: unknown[] };
			};
			expect(after.authorizations.ptys).toEqual([]);
		});

		it("attaches a browser WebSocket with the snapshot first and binary output afterwards", async () => {
			const { node, crha, key } = await connect();
			const terminal = await openPerson(node);
			const connection = await agents.connectPty(key, terminal.id);
			connection.send({ kind: "data", bytes: new TextEncoder().encode("$ ls\r\nfile\r\n") });
			await waitFor("screen", async () => {
				const screen = terminals.get(terminal.id)?.screen;
				if (!screen) return false;
				await screen.whenIdle();
				return (await terminals.screen(terminal)).text.includes("file");
			});
			const cookie = await login(app, "owner", "password-123");
			const ws = new WebSocket(
				`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ptys/${terminal.id}/attach`,
				{
					headers: { cookie, origin: base },
				},
			);
			const frames: unknown[] = [];
			await new Promise<void>((resolve, reject) => {
				ws.on("message", (data, isBinary) => frames.push(isBinary ? data : data.toString()));
				ws.on("open", () => resolve());
				ws.on("error", reject);
			});
			await waitFor("snapshot", () =>
				frames.some((frame) => typeof frame === "string" && frame.includes('"snapshot"')),
			);
			const snapshot = JSON.parse(
				frames.find((frame) => typeof frame === "string" && frame.includes('"snapshot"')) as string,
			) as { type: string; data: string };
			expect(snapshot.data).toContain("file");
			// A viewer's binary frame is input: the node receives it as a data frame.
			ws.send(new TextEncoder().encode("x"));
			await waitFor("input", async () => {
				const frame = await connection.next();
				return frame.kind === "data" && new TextDecoder().decode(frame.bytes) === "x";
			});
			ws.close();
			connection.close();
			void crha;
		});

		it("accepts a proxied HTTPS origin against host:443 and refuses a cross-origin attach", async () => {
			const { node } = await connect();
			const terminal = await openPerson(node);
			const cookie = await login(app, "owner", "password-123");
			const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ptys/${terminal.id}/attach`;
			const accepted = new WebSocket(url, {
				headers: { cookie, origin: "https://example.com", host: "example.com:443" },
			});
			const opened = await new Promise<number>((resolve) => {
				accepted.once("open", () => resolve(101));
				accepted.once("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0));
				accepted.once("error", () => resolve(0));
			});
			expect(opened).toBe(101);
			accepted.close();

			const refusedSocket = new WebSocket(url, {
				headers: { cookie, origin: "https://evil.example", host: "example.com:443" },
			});
			const refused = await new Promise<number>((resolve) => {
				refusedSocket.once("open", () => resolve(101));
				refusedSocket.once("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0));
				refusedSocket.once("error", () => resolve(0));
			});
			expect(refused).toBe(403);
			refusedSocket.terminate();
		});

		it("records the viewer's address from the configured real-IP header", async () => {
			const { node } = await connect();
			const terminal = await openPerson(node);
			await settings.patch(db, { realIpHeader: "X-Real-IP" }, null);
			const cookie = await login(app, "owner", "password-123");
			const ws = new WebSocket(
				`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ptys/${terminal.id}/attach`,
				{ headers: { cookie, origin: base, "x-real-ip": "203.0.113.9" } },
			);
			await new Promise<void>((resolve, reject) => {
				ws.once("open", () => resolve());
				ws.once("error", reject);
			});
			await waitFor("viewer attached", async () => (await terminals.view(terminal)).viewers.length === 1);
			const view = await terminals.view(terminal);
			expect(view.viewers[0]?.clientAddress).toBe("203.0.113.9");
			await audit.flush();
			const event = await db
				.selectFrom("audit_events")
				.select("detail")
				.where("action", "=", "pty.attached")
				.orderBy("seq", "desc")
				.executeTakeFirst();
			expect(JSON.parse(event?.detail ?? "{}")).toMatchObject({ client_address: "203.0.113.9" });
			ws.close();
		});

		it("shows the owner's signature wait and opens after the signed authorization", async () => {
			const { node, crha } = await connect();
			const ownerKey = createSshKey();
			const identity = {
				unprivileged: { uid: 998, gid: 998, user: "crha" },
				privileged: { uid: 0, gid: 0, user: "root" },
			};
			const entry: TrustEntry = {
				name: "alice",
				source: "local",
				role: "user",
				key: { kind: "sshsig", publicKey: ownerKey.line, fingerprint: ownerKey.fingerprint },
				kinds: ["execute"],
				requireSpec: false,
				requireTask: false,
				requireUv: false,
				maxTtlMs: 24 * 60 * 60 * 1000,
				allow: [],
				deny: [],
				envAllow: [],
			};
			crha.trust({
				kind: "ok",
				summary: {
					nodeId: node.id,
					aliases: [],
					clockSkewMs: 0,
					identities: identity,
					trust: [entry],
					localWindow: { kind: "closed" },
				},
			});
			await waitFor("trust stored", async () => {
				const row = await db.selectFrom("nodes").select("trust_report").where("id", "=", node.id).executeTakeFirst();
				return row?.trust_report !== null && row?.trust_report !== undefined;
			});
			const cookie = await login(app, "owner", "password-123");
			expect((await registerSshCredential(app, cookie, ownerKey, "alice")).status).toBe(201);
			const created = await call(app, "/api/ptys", {
				cookie,
				body: { node: node.id, argv: ["/bin/sh"], privileged: true },
			});
			expect(created.status).toBe(201);
			const id = ((await created.json()) as { terminal: { id: string } }).terminal.id;
			const pending = await waitFor("sign options", async () => {
				const response = await call(app, `/api/ptys/${id}/authorization`, { cookie });
				if (response.status !== 200) return undefined;
				const body = (await response.json()) as {
					phase: string;
					authorization: { options: { kind: string; payload?: { payload: string } }[] } | null;
				};
				const sign = body.authorization?.options.find((option) => option.kind === "sign");
				return body.phase === "waiting" && sign?.payload ? sign.payload.payload : undefined;
			});
			const payloadBytes = Uint8Array.from(Buffer.from(pending, "base64"));
			const wire: Authorization = {
				payload: payloadBytes,
				signatures: [{ kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, payloadBytes) }],
			};
			const submitted = await call(app, "/api/authorizations", {
				cookie,
				body: { authorization: Buffer.from(encodeCbor(authorizationCodec.encode(wire))).toString("base64") },
			});
			expect(submitted.status).toBe(200);
			await waitFor("opened after the signature", () => crha.ptyOpens.length === 1);
			expect(terminals.get(id)?.state).toBe("running");
			const open = crha.ptyOpens[0] as unknown as PtyOpen;
			expect(open.privileged).toBe(true);
			expect(open.authorizations).toHaveLength(1);
		});

		it("closes a disabled user's terminals with reason user_removed", async () => {
			const { node, crha } = await connect();
			const terminal = await openPerson(node);
			const adminCookie = await login(app, "root", "root-password");
			const disabled = await call(app, `/api/users/${owner.id}`, {
				cookie: adminCookie,
				method: "PATCH",
				body: { status: "disabled" },
			});
			expect(disabled.status).toBe(200);
			await waitFor("disabled user's terminal closed", () => terminals.get(terminal.id) === undefined);
			await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
			expect(crha.ptyCloses.at(-1)).toMatchObject({ ptyId: terminal.id, reason: "user_removed" });
		});

		it("closes every terminal when System settings turns the subsystem off", async () => {
			const { node, crha } = await connect();
			const terminal = await openPerson(node);
			const cookie = await login(app, "root", "root-password");
			const disabled = await call(app, "/api/settings", {
				cookie,
				method: "PATCH",
				body: { pty: { enabled: false } },
			});
			expect(disabled.status).toBe(200);
			await waitFor("closed by the setting", () => terminals.get(terminal.id) === undefined);
			await waitFor("close sent", () => crha.ptyCloses.some((close) => close.ptyId === terminal.id));
			expect(crha.ptyCloses.at(-1)).toMatchObject({ ptyId: terminal.id, reason: "disabled" });
		});

		it("hides the enabled flag when the subsystem is off", async () => {
			await settings.patch(db, { pty: { enabled: false } }, null);
			const cookie = await login(app, "owner", "password-123");
			const response = await call(app, "/api/ptys/enabled", { cookie });
			expect(await response.json()).toEqual({ enabled: false });
		});
	});
});

/** A session state as the idle rule sees it: absent when the session was deleted. */
type SessionRunState = "idle" | "running" | "awaiting" | undefined;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A session row with the minimum columns a terminal's idle check and association read. */
async function createSessionRow(
	db: Db,
	ownerUserId: string,
	title: string,
	state: "idle" | "running" = "idle",
): Promise<{ id: string }> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("sessions")
		.values({
			id,
			org_id: await defaultOrgId(db),
			owner_user_id: ownerUserId,
			conversation_id: `conv-${id}`,
			parent_session_id: null,
			root_session_id: id,
			title,
			model: JSON.stringify({ provider: "faux", modelId: "faux" }),
			status: "active",
			created_at: now,
			updated_at: now,
			archived_at: null,
			quota_tokens: null,
			state,
			state_changed_at: now,
		})
		.execute();
	return { id };
}
