import { describe, expect, it } from "vitest";
import { createLiveTask } from "../src/cluster/batch-output.ts";
import { SSH_PRIVILEGED_NOTICE, sshPrivilegedNotice } from "../src/cluster/ssh/exec.ts";

/**
 * Unit-level checks of the SSH notice, which the cluster stores in `tasks.notice` for a privileged
 * task (D114). It is crhs's own line and never part of the task's output stream. The SSH exec/SFTP
 * tests need a real sshd (CRH_TEST_SSH) and skip here.
 */
describe("SSH privileged notice", () => {
	it("is one line, only for privileged tasks", () => {
		expect(SSH_PRIVILEGED_NOTICE).toBe("crh: privileged was ignored: SSH nodes run tasks as the SSH user\n");
		expect(new TextDecoder().decode(sshPrivilegedNotice(true))).toBe(SSH_PRIVILEGED_NOTICE);
		expect(sshPrivilegedNotice(false)).toBeUndefined();
	});

	it("is not written into the single output stream", () => {
		// The accumulator has no notice path any more: only the node's output is part of it.
		const live = createLiveTask("full");
		live.append(0, Buffer.from("hello\n"));
		const out = live.snapshot();
		expect(out.outputBytes).toBe("hello\n".length);
		expect(out.outputHead?.toString()).toBe("hello\n");
	});

	it("a status task keeps only the byte count, not the notice", () => {
		const live = createLiveTask("status");
		live.append(0, Buffer.from("hello\n"));
		const out = live.snapshot();
		expect(out.outputHead).toBeNull();
		expect(out.outputTail).toBeNull();
		expect(out.outputBytes).toBe("hello\n".length);
	});
});
