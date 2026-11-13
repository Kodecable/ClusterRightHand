import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import type { SshRoute } from "../src/cluster/ssh/connection.ts";
import { SHELL_PROBE_COMMAND, SSH_PRIVILEGED_NOTICE } from "../src/cluster/ssh/exec.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

/**
 * The SSH task path through the cluster with a fake session instead of a real sshd: cancelling a task
 * whose connection is still being made, and the privileged notice of a status task
 * (doc/design/execution.md "SSH transport"). The session is faked by replacing the module's `connect`.
 */
const fake = vi.hoisted(() => ({
	/** Opens the session of the next task; tests replace it. */
	connect: async (_route: unknown): Promise<unknown> => {
		throw new Error("no fake session set");
	},
}));

vi.mock("../src/cluster/ssh/connection.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cluster/ssh/connection.ts")>();
	return { ...actual, connect: (route: SshRoute) => fake.connect(route) };
});

const EXEC: TaskSpec = { kind: "exec", command: { argv: ["id", "-u"] }, env: {}, cwd: "", stdin: null };
const OUTPUT = Buffer.from("0\n");
const PROBE = "crh-shell sh /bin/sh\ncrh-shell bash /usr/bin/bash\n";

/** One channel of the fake connection: listeners are attached before any event is emitted. */
class FakeChannel {
	readonly #handlers = new Map<string, ((arg?: unknown) => void)[]>();
	readonly stderr = {
		on: (event: string, fn: (arg?: unknown) => void) => this.#add(`stderr.${event}`, fn),
		resume: () => {},
	};
	readonly stdout = { on: (event: string, fn: (arg?: unknown) => void) => this.#add(`stdout.${event}`, fn) };

	on(event: string, fn: (arg?: unknown) => void): void {
		this.#add(event, fn);
	}

	emit(event: string, arg?: unknown): void {
		for (const fn of this.#handlers.get(event) ?? []) fn(arg);
	}

	#add(event: string, fn: (arg?: unknown) => void): void {
		const list = this.#handlers.get(event) ?? [];
		list.push(fn);
		this.#handlers.set(event, list);
	}

	end(_data?: Buffer): void {}

	close(): void {
		this.emit("close");
	}
}

/** A fake ssh2 session: it answers the shell probe and runs each task command to exit `code`. */
class FakeSession {
	readonly commands: string[] = [];
	/** What every task command writes to stdout (nothing by default). */
	taskOutput: Buffer = OUTPUT;
	/** Leaves task channels open, so a test can close the session while a task runs. */
	holdTaskCommands = false;
	#closed = false;
	readonly #closeHandlers = new Set<() => void>();

	exec(command: string, onChannel?: (channel: FakeChannel) => void): Promise<FakeChannel> {
		this.commands.push(command);
		const channel = new FakeChannel();
		onChannel?.(channel);
		if (command === SHELL_PROBE_COMMAND) {
			setImmediate(() => {
				channel.emit("data", Buffer.from(PROBE));
				channel.emit("close", 0);
			});
		} else if (!this.holdTaskCommands) {
			setImmediate(() => {
				if (this.taskOutput.length > 0) channel.emit("data", this.taskOutput);
				channel.emit("exit", 0);
				channel.emit("close");
			});
		}
		return Promise.resolve(channel);
	}

	onClose(fn: () => void): () => void {
		if (this.#closed) fn();
		else this.#closeHandlers.add(fn);
		return () => this.#closeHandlers.delete(fn);
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const fn of this.#closeHandlers) fn();
		this.#closeHandlers.clear();
	}

	/** The commands that ran a task (everything but the connection's shell probe). */
	taskCommands(): string[] {
		return this.commands.filter((command) => command !== SHELL_PROBE_COMMAND);
	}
}

describe("SSH tasks", () => {
	let db: Db;
	let cluster: Cluster;
	let ownerUserId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, {
			// The route is never dialled: the module's connect is faked above.
			sshRoute: async () => ({
				hops: [{ host: "127.0.0.1", port: 22, user: "root", hostFingerprint: "SHA256:fake", privateKey: "fake-key" }],
			}),
		});
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		ownerUserId = user.id;
	});

	afterEach(async () => {
		await cluster.close();
		await db.destroy();
		fake.connect = async () => {
			throw new Error("no fake session set");
		};
	});

	const addSshNode = async (name: string): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport: "ssh",
				status: "active",
				public_key: null,
				hostname: name,
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: "127.0.0.1",
				ssh_port: 22,
				ssh_user: "root",
				ssh_host_fingerprint: "SHA256:fake",
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
				grantee_id: ownerUserId,
				target_type: "node",
				target_id: id,
				created_by_user_id: ownerUserId,
				created_at: now,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	const actor = () => ({ type: "user" as const, id: ownerUserId, onBehalfOfUserId: ownerUserId });

	const view = async (id: string) => {
		const task = await cluster.getTask(id);
		if (!task) throw new Error(`task ${id} disappeared`);
		return task;
	};

	it("cancels a task whose connection never completes without running it", async () => {
		const node = await addSshNode("ssh-cancel");
		let releaseConnect!: (session: FakeSession) => void;
		fake.connect = () =>
			new Promise((resolve) => {
				releaseConnect = resolve;
			});
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		await waitFor("dispatched", async () => (await view(task.id)).state === "dispatched");

		expect(await cluster.cancelTask(task.id, "the session was stopped")).toBe(true);
		const session = new FakeSession();
		releaseConnect(session);
		const done = await waitFor("cancelled", async () => {
			const current = await view(task.id);
			return current.state === "exited" ? current : undefined;
		});
		// Nothing ran: the cancellation was set while the connection was being made.
		expect(done).toMatchObject({ state: "exited", cancelled: true, exitCode: null });
		expect(session.taskCommands()).toHaveLength(0);
	});

	it("keeps the privileged notice of a status task", async () => {
		const node = await addSshNode("ssh-status");
		const session = new FakeSession();
		fake.connect = async () => session;
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			privileged: true,
			outputMode: "status",
			actor: actor(),
		});
		const done = await waitFor("finished", async () => {
			const current = await view(task.id);
			return current.state === "exited" ? current : undefined;
		});
		// A status task keeps no output, but the notice is stored on the task.
		expect(done).toMatchObject({ outputMode: "status", exitCode: 0, privileged: true });
		expect(done.notice).toBe(SSH_PRIVILEGED_NOTICE);
		expect(done.outputBytes).toBe(OUTPUT.length);
		expect(done.outputHead).toBe("");
		expect(done.outputFile).toBeNull();
		// crhs sees all SSH output itself, so it counts the merged lines instead of reading task.exit.
		expect(done.outputLines).toBe(1);
		expect(session.taskCommands()).toHaveLength(1);
	});

	it("writes no notice for an ordinary status task", async () => {
		const node = await addSshNode("ssh-status-plain");
		fake.connect = async () => new FakeSession();
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			outputMode: "status",
			actor: actor(),
		});
		const done = await waitFor("finished", async () => {
			const current = await view(task.id);
			return current.state === "exited" ? current : undefined;
		});
		expect(done.notice).toBeNull();
		expect(done.outputBytes).toBe(OUTPUT.length);
	});

	it("counts the merged output's lines, including a last line without a newline", async () => {
		const node = await addSshNode("ssh-lines");
		const session = new FakeSession();
		session.taskOutput = Buffer.from("a\nb");
		fake.connect = async () => session;
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		const done = await waitFor("finished", async () => {
			const current = await view(task.id);
			return current.state === "exited" ? current : undefined;
		});
		expect(done).toMatchObject({ outputLines: 2, outputTail: "a\nb", outputTailLines: 2 });
	});

	it("closes one node's pooled connection, so the next task dials again", async () => {
		const node = await addSshNode("ssh-close");
		const first = new FakeSession();
		let connects = 0;
		fake.connect = async () => {
			connects++;
			return first;
		};
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		await waitFor("finished", async () => (await view(task.id)).state === "exited");
		expect(connects).toBe(1);
		expect(first.closed).toBe(false);

		cluster.closeSshNode(node.id);
		await waitFor("closed", async () => (first.closed ? true : undefined));
		expect(first.closed).toBe(true);

		const second = new FakeSession();
		fake.connect = async () => {
			connects++;
			return second;
		};
		const next = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		await waitFor("finished", async () => (await view(next.id)).state === "exited");
		expect(connects).toBe(2);
	});

	it("makes a task running on the closed connection unknown", async () => {
		const node = await addSshNode("ssh-close-running");
		const session = new FakeSession();
		session.holdTaskCommands = true;
		fake.connect = async () => session;
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		await waitFor("running", async () => (await view(task.id)).state === "running");

		cluster.closeSshNode(node.id);
		const done = await waitFor("unknown", async () => {
			const current = await view(task.id);
			return current.state === "unknown" ? current : undefined;
		});
		expect(done.errorCode).toBe("connection_lost");
	});

	it("fails a transfer task whose stored descriptor cannot be opened instead of leaving it dispatched", async () => {
		const node = await addSshNode("ssh-bad-transfer");
		const session = new FakeSession();
		fake.connect = async () => session;
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: {
				kind: "file.pull",
				path: "/etc/passwd",
				maxBytes: 1024,
				endpoint: { kind: "crhs", transferId: "bad-transfer" },
			},
			transfer: JSON.stringify({ transferId: "bad-transfer", location: { kind: "nonsense" } }),
			actor: actor(),
		});
		const done = await waitFor("failed", async () => {
			const current = await view(task.id);
			return current.state === "failed" ? current : undefined;
		});
		expect(done.errorCode).toBe("connect_failed");
		expect(done.errorMessage).toContain("unknown transfer location kind");
		// Nothing ran on the node: the task never reached the connection.
		expect(session.taskCommands()).toHaveLength(0);
	});
});
