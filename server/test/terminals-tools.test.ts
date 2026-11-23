/**
 * The terminal agent tools (doc/design/pty.md "Agent tools"): pty_open under pty.create with its
 * approval, pty.io decisions for writes and resizes, read cursors, watch keywords split across
 * chunks and an OSC terminator's BEL that is not a bell, and pty_close restricted to the creator.
 */
import { generateKeyPair } from "@crh/noise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import type { Actor } from "../src/cluster/types.ts";
import { createRootRuleSet, setRulePreset, setRules } from "../src/policy/store.ts";
import { DEFAULT_SYSTEM_SETTINGS, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TerminalService } from "../src/terminals/registry.ts";
import type { PtyToolContext } from "../src/terminals/tools.ts";
import {
	keysToBytes,
	ptyClose,
	ptyList,
	ptyOpen,
	ptyRead,
	ptyResize,
	ptyWatch,
	ptyWrite,
} from "../src/terminals/tools.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, PTY_REQUIRED_NAMES, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb, revokeNodeGrantAfterList } from "./helpers/db.ts";

describe("terminal tools", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let settings: SettingsStore;
	let terminals: TerminalService;
	let owner: { id: string; username: string };
	let node: NodeRow;
	let crha: FakeCrha;
	let key: ReturnType<typeof generateKeyPair>;
	let sessionId: string;
	let otherSessionId: string;
	let ctx: PtyToolContext;
	let user: SessionUser;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		settings = SettingsStore.fromSystemSettings(DEFAULT_SYSTEM_SETTINGS);
		cluster = new Cluster(db, {});
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test" };
		agents = await TestAgentServer.start(db, identity, cluster);
		owner = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		await createRootRuleSet(db, await defaultOrgId(db), { type: "user", id: owner.id }, "yolo");
		user = { userId: owner.id, username: owner.username, kind: "member", sessionId: "tool-session" };
		key = generateKeyPair();
		node = await addNode(db, "node-1", key.publicKey, owner.id);
		crha = await agents.connect(key, handshakeInit({ commands: [...PTY_REQUIRED_NAMES] }), PTY_REQUIRED_NAMES);
		await crha.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: "" });
		await waitFor("link", () => cluster.isConnected(node.id));
		terminals = new TerminalService({ db, cluster, settings, exitedRetentionMs: 30, idleSweepMs: 10 });
		terminals.start();
		sessionId = await createSessionRow(db, owner.id);
		otherSessionId = await createSessionRow(db, owner.id);
		ctx = {
			db,
			user,
			actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.id } as Actor,
			chain: [{ type: "user", id: owner.id }],
			terminals,
		};
	});

	afterEach(async () => {
		await terminals.shutdown();
		await agents.close();
		await cluster.close();
		await db.destroy();
	});

	it("refuses a node the session's user has no access to, also when the grant is revoked mid-open", async () => {
		const outsider = await createUser(db, { username: "outsider", kind: "member", password: "password-789" });
		const otherKey = generateKeyPair();
		const otherNode = await addNode(db, "node-other", otherKey.publicKey, outsider.id);
		await expect(ptyOpen(ctx, { node: otherNode.id, idle_timeout: 60 })).rejects.toMatchObject({
			code: "node_not_found",
		});

		// The node is listed for this user, then the grant is revoked before the service's second check.
		const racingKey = generateKeyPair();
		const racingNode = await addNode(db, "node-racing", racingKey.publicKey, owner.id);
		const racingTerminals = new TerminalService({
			db: revokeNodeGrantAfterList(db, owner.id, racingNode.id),
			cluster,
			settings,
			exitedRetentionMs: 30,
			idleSweepMs: 10,
		});
		await expect(
			ptyOpen({ ...ctx, terminals: racingTerminals }, { node: racingNode.id, idle_timeout: 60 }),
		).rejects.toMatchObject({ code: "node_not_found" });
	});

	it("opens a terminal under pty.create with a required idle timeout", async () => {
		await expect(ptyOpen(ctx, { node: node.id, idle_timeout: 0 })).rejects.toMatchObject({
			code: "idle_timeout_required",
		});
		await expect(ptyOpen(ctx, { node: node.id, idle_timeout: 99999 })).rejects.toMatchObject({
			code: "idle_timeout_too_large",
		});
		const result = await ptyOpen(ctx, { node: node.id, argv: ["/bin/sh"], idle_timeout: 60 });
		expect(result.isError).toBe(false);
		const terminal = (await terminals.list(user)).terminals[0];
		expect(terminal?.state).toBe("running");
		expect(terminal?.creatingSessionId).toBe(sessionId);
		expect(crha.ptyOpens).toHaveLength(1);
	});

	it("denies pty_create when the rules deny it", async () => {
		await setRulePreset(db, { type: "user", id: owner.id }, "ask");
		await setRules(db, { type: "user", id: owner.id }, [{ action: "deny", method: "pty.create" }]);
		await expect(ptyOpen(ctx, { node: node.id, idle_timeout: 60 })).rejects.toMatchObject({ code: "rule_denied" });
		expect(crha.ptyOpens).toHaveLength(0);
	});

	it("waits for the user's approval on pty_create and then opens", async () => {
		await setRulePreset(db, { type: "user", id: owner.id }, "ask");
		const pending = ptyOpen(ctx, { node: node.id, argv: ["/bin/sh"], idle_timeout: 60 });
		const terminal = await waitFor("opening terminal", async () => {
			const views = await terminals.list(user);
			for (const entry of views.terminals) {
				if (entry.state === "opening") return terminals.get(entry.id);
			}
			return undefined;
		});
		await waitFor("approval view", async () => (await terminals.view(terminal)).approval !== null);
		const view = await terminals.view(terminal);
		if (!view.approval) throw new Error("missing approval");
		expect(view.approval.method).toBe("pty.create");
		expect(view.approval.alwaysAllow[0]?.rule).toMatchObject({ action: "allow", method: "pty.create" });
		await terminals.decideApproval(terminal, user, { decision: "approve" });
		const result = await pending;
		expect(result.isError).toBe(false);
		await waitFor("opened", () => terminal.state === "running");
	});

	it("requires pty.io for a write, and the user's approval decides it", async () => {
		const terminal = await openFromTool(ctx, node);
		await connectData(terminal.id);
		await setRulePreset(db, { type: "user", id: owner.id }, "ask");
		await setRules(db, { type: "user", id: owner.id }, [{ action: "allow", method: "pty.create" }]);
		const pending = ptyWrite(ctx, { id: terminal.id, text: "rm -rf /", keys: ["Enter"] });
		const approval = await waitFor("io approval", async () => {
			const view = await terminals.view(terminal);
			return view.approval ?? undefined;
		});
		expect(approval.method).toBe("pty.io");
		expect(approval.input).toBe("rm -rf /");
		expect(approval.keys).toEqual(["Enter"]);
		await terminals.decideApproval(terminal, user, { decision: "approve" });
		await pending;
		const frame = await connectionOf(terminal.id).next();
		expect(frame.kind).toBe("data");
		expect(frame.kind === "data" ? new TextDecoder().decode(frame.bytes) : "").toBe("rm -rf /\r");
	});

	it("resizes under pty.io and pty_close only closes the creator's terminal", async () => {
		const terminal = await openFromTool(ctx, node);
		const resized = await ptyResize(ctx, { id: terminal.id, rows: 40, cols: 120 });
		expect(resized.isError).toBe(false);
		await waitFor("resize sent", () => crha.ptyResizes.length === 1);
		const other = { ...ctx, actor: { type: "session", id: otherSessionId } as Actor };
		await expect(ptyClose(other, { id: terminal.id })).rejects.toMatchObject({ code: "forbidden" });
		await ptyClose(ctx, { id: terminal.id });
		expect(terminals.get(terminal.id)).toBeUndefined();
	});

	it("reads the screen and advances the output cursor", async () => {
		const terminal = await openFromTool(ctx, node);
		const connection = await connectData(terminal.id);
		connection.send({ kind: "data", bytes: new TextEncoder().encode("one\r\ntwo\r\n") });
		await waitFor("output", async () => (await terminals.screen(terminal)).text.includes("two"));
		const screen = await ptyRead(ctx, { id: terminal.id });
		expect(screen.content[0]?.text).toContain("two");
		const first = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		// The first read returns what was written since the terminal opened.
		expect(first.content[0]?.text).toContain("one");
		connection.send({ kind: "data", bytes: new TextEncoder().encode("three\r\n") });
		await waitFor("more output", async () => (await terminals.screen(terminal)).text.includes("three"));
		const second = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		expect(second.content[0]?.text).toContain("three");
		expect(second.content[0]?.text).not.toContain("one");
	});

	it("returns the screen, not the log, while a full-screen program holds the alternate screen", async () => {
		const terminal = await openFromTool(ctx, node);
		const connection = await connectData(terminal.id);
		const encoder = new TextEncoder();
		connection.send({ kind: "data", bytes: encoder.encode("before\r\n") });
		await waitFor("normal output", async () => (await terminals.screen(terminal)).text.includes("before"));

		// The program enters the alternate screen and draws there: that output is not logged.
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049h") });
		connection.send({ kind: "data", bytes: encoder.encode("ALT-DRAWN\r\n") });
		await waitFor("alternate screen drawn", async () => {
			const screen = terminal.screen;
			return screen?.terminal.buffer.active.type === "alternate" && (await screen.screen()).text.includes("ALT-DRAWN");
		});
		const inside = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		// Output mode has nothing to return, so it returns the current screen in the screen shape,
		// with a note that a full-screen program is running.
		expect(inside.content[0]?.text).toContain("ALT-DRAWN");
		expect(inside.content[0]?.text).toMatch(/\[cursor row \d+, column \d+;/);
		expect(inside.content[0]?.text).toContain("full-screen");
		expect(inside.content[0]?.text).toContain("output mode is unavailable");

		// Leaving resumes the normal screen; the log has only what was written after leaving, and
		// what was already before the full-screen program was covered by the screen read.
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049l") });
		connection.send({ kind: "data", bytes: encoder.encode("after\r\n") });
		await waitFor("normal screen resumed", async () => {
			const screen = terminal.screen;
			return screen?.terminal.buffer.active.type === "normal" && (await screen.screen()).text.includes("after");
		});
		const resumed = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		expect(resumed.content[0]?.text).toContain("after");
		expect(resumed.content[0]?.text).not.toContain("ALT-DRAWN");
		expect(resumed.content[0]?.text).not.toContain("before");
	});

	it("keeps alternate-screen output out of an output read that did not happen inside it", async () => {
		const terminal = await openFromTool(ctx, node);
		const connection = await connectData(terminal.id);
		const encoder = new TextEncoder();
		connection.send({ kind: "data", bytes: encoder.encode("before\r\n") });
		await waitFor("normal output", async () => (await terminals.screen(terminal)).text.includes("before"));
		// The session reads once before the program starts, putting its cursor at the log end. It
		// does not read again while the alternate screen is active: unlike a read inside the screen,
		// that must still not make the program's drawing visible in the next output read.
		const before = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		expect(before.content[0]?.text).toContain("before");

		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049h") });
		await waitFor("alternate screen", () => terminal.screen?.terminal.buffer.active.type === "alternate");
		connection.send({ kind: "data", bytes: encoder.encode("ALT-SECRET\r\n") });
		await waitFor("alternate screen drawn", async () => (await terminals.screen(terminal)).text.includes("ALT-SECRET"));
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049l") });
		await waitFor("normal screen resumed", () => terminal.screen?.terminal.buffer.active.type === "normal");
		connection.send({ kind: "data", bytes: encoder.encode("after\r\n") });
		await waitFor("normal output resumed", async () => (await terminals.screen(terminal)).text.includes("after"));

		const next = await ptyRead(ctx, { id: terminal.id, mode: "output" });
		expect(next.content[0]?.text).toContain("after");
		expect(next.content[0]?.text).not.toContain("ALT-SECRET");
	});

	it("matches a pty_watch keyword drawn on the alternate screen, not one already there", async () => {
		const terminal = await openFromTool(ctx, node);
		const connection = await connectData(terminal.id);
		const encoder = new TextEncoder();
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049h") });
		connection.send({ kind: "data", bytes: encoder.encode("ALREADY-VISIBLE") });
		await waitFor("alternate screen drawn", async () => {
			const screen = terminal.screen;
			return (
				screen?.terminal.buffer.active.type === "alternate" && (await screen.screen()).text.includes("ALREADY-VISIBLE")
			);
		});
		// Already on the alternate screen when the watch starts: no match, even though the
		// full-screen program redraws that same text after the watch started.
		const existing = ptyWatch(ctx, { id: terminal.id, timeout: 0.3, keywords: ["ALREADY-VISIBLE"] });
		await new Promise((resolve) => setTimeout(resolve, 30));
		connection.send({ kind: "data", bytes: encoder.encode("\r\nALREADY-VISIBLE and more") });
		expect((await existing).details?.reason).toBe("timeout");

		// Back on the normal screen, a watch spans the next switch: the keyword is new to the
		// alternate screen that begins during the watch, so it matches.
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049l") });
		await waitFor("normal screen", () => terminal.screen?.terminal.buffer.active.type === "normal");
		const watching = ptyWatch(ctx, { id: terminal.id, timeout: 2, keywords: ["NEW-ALT"] });
		connection.send({ kind: "data", bytes: encoder.encode("\u001b[?1049h") });
		connection.send({ kind: "data", bytes: encoder.encode("NEW-ALT") });
		const result = await watching;
		expect(result.details?.reason).toBe("keyword");
		expect(result.details?.keyword).toBe("NEW-ALT");
		expect(result.content[0]?.text).toContain("NEW-ALT");
	});

	it("matches a keyword split between chunks and ignores an OSC terminator BEL", async () => {
		const terminal = await openFromTool(ctx, node);
		const connection = await connectData(terminal.id);
		const watching = ptyWatch(ctx, { id: terminal.id, timeout: 2, keywords: ["ready>"], bell: true });
		connection.send({ kind: "data", bytes: new TextEncoder().encode("prefix rea") });
		await new Promise((resolve) => setTimeout(resolve, 30));
		connection.send({ kind: "data", bytes: new TextEncoder().encode("dy> and more") });
		const result = await watching;
		expect(result.details?.reason).toBe("keyword");
		expect(result.details?.keyword).toBe("ready>");
		// An OSC title's BEL ends the sequence; it is not a bell.
		const belWatch = ptyWatch(ctx, { id: terminal.id, timeout: 0.2, bell: true });
		connection.send({ kind: "data", bytes: new TextEncoder().encode("\u001b]0;title\u0007") });
		expect((await belWatch).details?.reason).toBe("timeout");
		// A BEL on its own is one.
		const realBell = ptyWatch(ctx, { id: terminal.id, timeout: 2, bell: true });
		connection.send({ kind: "data", bytes: new TextEncoder().encode("\u0007") });
		expect((await realBell).details?.reason).toBe("bell");
	});

	it("caps pty_watch at the configured maximum and lists only this session's terminals", async () => {
		const terminal = await openFromTool(ctx, node);
		await expect(ptyWatch(ctx, { id: terminal.id, timeout: 9999 })).rejects.toMatchObject({
			code: "timeout_too_large",
		});
		const list = await ptyList(ctx);
		expect(list.content[0]?.text).toContain(terminal.id);
		const other = { ...ctx, actor: { type: "session", id: otherSessionId } as Actor };
		expect((await ptyList(other)).content[0]?.text).not.toContain(terminal.id);
	});

	it("translates named keys", () => {
		expect(new TextDecoder().decode(keysToBytes(["Enter", "ctrl-c", "Up"]))).toBe("\r\u0003\u001b[A");
		expect(() => keysToBytes(["nope"])).toThrowError(/unknown key/);
	});

	async function openFromTool(context: PtyToolContext, target: NodeRow) {
		await ptyOpen(context, { node: target.id, argv: ["/bin/sh"], idle_timeout: 60 });
		const terminal = (await terminals.list(user)).terminals.find((entry) => entry.state === "running");
		if (!terminal) throw new Error("the tool opened no terminal");
		return terminals.get(terminal.id) as NonNullable<ReturnType<TerminalService["get"]>>;
	}

	async function connectData(terminalId: string) {
		const connection = await agents.connectPty(key, terminalId);
		connections.set(terminalId, connection);
		await waitFor("data connection", () => terminals.get(terminalId)?.connection !== null);
		return connection;
	}
});

const connections = new Map<string, Awaited<ReturnType<TestAgentServer["connectPty"]>>>();

function connectionOf(terminalId: string): Awaited<ReturnType<TestAgentServer["connectPty"]>> {
	const connection = connections.get(terminalId);
	if (!connection) throw new Error("missing data connection");
	return connection;
}

async function addNode(db: Db, name: string, key: Uint8Array, userId: string): Promise<NodeRow> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport: "client",
			status: "active",
			public_key: Buffer.from(key).toString("base64"),
			hostname: name,
			facts: null,
			client_version: null,
			privileged_mode: "",
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
			grantee_id: userId,
			target_type: "node",
			target_id: id,
			created_by_user_id: userId,
			created_at: now,
		})
		.execute();
	return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
}

async function createSessionRow(db: Db, ownerUserId: string): Promise<string> {
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
			title: "tool session",
			model: JSON.stringify({ provider: "faux", modelId: "faux" }),
			status: "active",
			created_at: now,
			updated_at: now,
			archived_at: null,
			quota_tokens: null,
			state: "idle",
			state_changed_at: now,
		})
		.execute();
	return id;
}
