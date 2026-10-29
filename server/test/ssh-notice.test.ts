import { describe, expect, it } from "vitest";
import { createLiveTask } from "../src/cluster/batch-output.ts";
import { SSH_PRIVILEGED_NOTICE, sshPrivilegedNotice } from "../src/cluster/ssh/exec.ts";

/**
 * Unit-level checks of the SSH notice, which the cluster writes into a privileged task's stderr before
 * the task starts. The SSH exec/SFTP tests need a real sshd (CRH_TEST_SSH) and skip here.
 */
describe("SSH privileged notice", () => {
	it("is one stderr line, only for privileged tasks", () => {
		expect(SSH_PRIVILEGED_NOTICE).toBe("crh: privileged was ignored: SSH nodes run tasks as the SSH user\n");
		expect(new TextDecoder().decode(sshPrivilegedNotice(true))).toBe(SSH_PRIVILEGED_NOTICE);
		expect(sshPrivilegedNotice(false)).toBeUndefined();
	});

	it("comes before the task's own output", () => {
		// The same accumulator and offsets the cluster uses for a task between dispatch and exit.
		const live = createLiveTask("full");
		const notice = sshPrivilegedNotice(true) as Uint8Array;
		live.append("stderr", live.end("stderr"), notice);
		live.append("stdout", 0, Buffer.from("hello\n"));
		live.append("stderr", live.end("stderr"), Buffer.from("oops\n"));
		const out = live.snapshot();
		expect(out.stdoutHead?.toString()).toBe("hello\n");
		expect(out.stderrHead?.toString()).toBe(`${SSH_PRIVILEGED_NOTICE}oops\n`);
		expect(out.stderrBytes).toBe(SSH_PRIVILEGED_NOTICE.length + "oops\n".length);
	});
});
