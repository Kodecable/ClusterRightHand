import { type ApprovalRequest, type JobNotice, quotaStatus } from "@crh/api";
import { describe, expect, it } from "vitest";
import { type ChatCard, renderCard, renderCardLine, TELEGRAM_LINE_BREAK } from "../src/channels/card.ts";
import { displaySessionTitle, messagesFor } from "../src/channels/messages.ts";
import { markdownEscapesToText } from "../src/channels/plain-text.ts";

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task",
	id: "task-1",
	phase: "awaiting_user",
	source: { type: "session", sessionId: "s1", title: "cleanup" },
	action: { type: "exec", command: "rm -rf /var/log/old/*.gz" },
	nodes: ["app-1", "db-1"],
	privileged: true,
	review: { risk: "medium", reason: "deletion exceeds the instruction" },
	alwaysAllow: [],
	...overrides,
});

const telegram = (card: ChatCard, locale: "en" | "zh-CN" = "en") =>
	renderCard(card, messagesFor(locale).card, "markdown");
const plain = (card: ChatCard, locale: "en" | "zh-CN" = "en") => renderCard(card, messagesFor(locale).card, "plain");

describe("displaySessionTitle", () => {
	it("uses the stored title, and the one New session wording for null, empty or blank titles", () => {
		const en = messagesFor("en");
		const zh = messagesFor("zh-CN");
		expect(displaySessionTitle("Clean up", en)).toBe("Clean up");
		expect(displaySessionTitle("清理", zh)).toBe("清理");
		expect(displaySessionTitle(null, en)).toBe("New session");
		expect(displaySessionTitle(undefined, en)).toBe("New session");
		expect(displaySessionTitle("", en)).toBe("New session");
		expect(displaySessionTitle("  \t ", en)).toBe("New session");
		expect(displaySessionTitle(" ", zh)).toBe("新会话");
	});
});

describe("chat cards", () => {
	it("renders an approval card with a bold title, hard breaks and one inline-code detail on Telegram", () => {
		const card = messagesFor("en").approvalCard(request(), { withButtons: true, withSource: false });
		expect(card).toEqual({
			title: "Approval needed",
			privileged: true,
			meta: "Nodes: app-1, db-1",
			risk: "medium",
			reason: "deletion exceeds the instruction",
			detail: "rm -rf /var/log/old/*.gz",
			hints: ["Reject with a reason: /reject task-1 reason"],
		});
		expect(telegram(card)).toBe(
			`${[
				"**Approval needed** · privileged",
				"Nodes: app\\-1, db\\-1",
				"🟡 Medium risk · deletion exceeds the instruction",
				"`rm -rf /var/log/old/*.gz`",
			].join(TELEGRAM_LINE_BREAK)}\n\nReject with a reason: /reject task-1 reason`,
		);
	});

	it("renders the same card as plain text on Satori, with no Markdown syntax", () => {
		const card = messagesFor("en").approvalCard(request(), { withButtons: false, withSource: false });
		expect(plain(card)).toBe(
			[
				"Approval needed · privileged",
				"Nodes: app-1, db-1",
				"🟡 Medium risk · deletion exceeds the instruction",
				"rm -rf /var/log/old/*.gz",
				"",
				"/approve task-1",
				"/reject task-1 [reason]",
			].join("\n"),
		);
		expect(plain(card)).not.toContain("**");
		expect(plain(card)).not.toContain("`");
		expect(telegram(card)).not.toContain("**Approval needed** · privileged\\\nNodes:\\");
	});

	it("renders a terminal approval with its input, keys and screen excerpt in both languages", () => {
		const pty = request({
			kind: "pty",
			id: "pty-1",
			privileged: false,
			review: undefined,
			nodes: ["app-1"],
			action: { type: "pty.io", input: "rm -rf /", keys: ["Enter"], screen: "$ rm -rf /\n[yes/no]" },
		});
		const en = messagesFor("en").approvalCard(pty, { withButtons: false, withSource: false });
		expect(en.detail).toBe("Type rm -rf / · keys Enter");
		expect(en.screen).toBe("$ rm -rf /\n[yes/no]");
		expect(telegram(en)).toContain("`Type rm -rf / · keys Enter`");
		expect(telegram(en)).toContain("Terminal screen:");
		expect(plain(en)).toContain("/reject pty-1 [reason]");
		const zh = messagesFor("zh-CN").approvalCard(pty, { withButtons: false, withSource: false });
		expect(zh.title).toBe("需要你的审批");
		expect(zh.detail).toBe("输入 rm -rf / · 按键 Enter");
		expect(zh.screen).toBe("$ rm -rf /\n[yes/no]");
		expect(plain(zh, "zh-CN")).toContain("终端屏幕：");
		// pty.create renders its argv the way the rule target does.
		const create = request({ kind: "pty", action: { type: "pty.create", argv: ["/bin/sh", "-c", "id"] } });
		expect(messagesFor("en").approvalCard(create, { withButtons: false, withSource: false }).detail).toBe(
			"/bin/sh -c id",
		);
	});

	it("adds one job line, with the job's action only when it differs from the card's", () => {
		const sameAction = request({
			job: { id: "exec-3f2a1b2c3d4e5f6a", kind: "exec", action: { type: "exec", command: "rm -rf /var/log/old/*.gz" } },
		});
		const same = messagesFor("en").approvalCard(sameAction, { withButtons: false, withSource: false });
		expect(same.job).toBe("Job: exec exec-3f2a1b2c3d4e5f6a");
		expect(plain(same)).toBe(
			[
				"Approval needed · privileged",
				"Nodes: app-1, db-1",
				"Job: exec exec-3f2a1b2c3d4e5f6a",
				"🟡 Medium risk · deletion exceeds the instruction",
				"rm -rf /var/log/old/*.gz",
				"",
				"/approve task-1",
				"/reject task-1 [reason]",
			].join("\n"),
		);
		expect(telegram(same)).toContain("Job: exec exec\\-3f2a1b2c3d4e5f6a");

		const differentAction = request({
			action: { type: "api_request", method: "GET", path: "/api/nodes" },
			job: { id: "call-abc123", kind: "call", action: { type: "exec", command: "echo *hi*" } },
		});
		const different = messagesFor("en").approvalCard(differentAction, { withButtons: false, withSource: false });
		expect(different.job).toBe("Job: call call-abc123 · echo *hi*");
		expect(telegram(different)).toContain("Job: call call\\-abc123 · echo \\*hi\\*");
		expect(plain(different)).toContain("Job: call call-abc123 · echo *hi*");
		expect(plain(different)).toContain("GET /api/nodes");

		// A card without a job is unchanged: no line, and the existing exact renderings still hold.
		const noJob = messagesFor("en").approvalCard(request(), { withButtons: false, withSource: false });
		expect(noJob.job).toBeUndefined();
		expect(plain(noJob)).not.toContain("Job:");
		expect(telegram(noJob)).not.toContain("Job:");
	});

	it("renders the job line in Chinese, on an approval and on a signature card", () => {
		const zh = request({
			job: {
				id: "call-abc123",
				kind: "call",
				action: { type: "extension_tool", extension: "github", tool: "create_issue" },
			},
		});
		const approval = messagesFor("zh-CN").approvalCard(zh, { withButtons: false, withSource: false });
		expect(approval.job).toBe("后台任务：call call-abc123 · github/create_issue");
		expect(plain(approval, "zh-CN")).toContain("后台任务：call call-abc123 · github/create_issue");
		expect(telegram(approval, "zh-CN")).toContain("后台任务：call call\\-abc123 · github/create\\_issue");

		const signature = messagesFor("zh-CN").signatureCard(
			request({
				phase: "awaiting_signature",
				job: { id: "exec-abc123", kind: "exec", action: { type: "exec", command: "rm -rf /tmp/*" } },
			}),
			null,
			{ sign: false, localWindows: [], awaitingNode: false, withButtons: false, withSource: false },
		);
		expect(signature.job).toBe("后台任务：exec exec-abc123 · rm -rf /tmp/*");
		expect(plain(signature, "zh-CN")).toContain("后台任务：exec exec-abc123 · rm -rf /tmp/*");
	});

	it("adds the source only when no source thread routed the card", () => {
		const withoutSource = messagesFor("en").approvalCard(request(), {
			withButtons: false,
			withSource: false,
		});
		expect(withoutSource.meta).toBe("Nodes: app-1, db-1");
		const withSource = messagesFor("en").approvalCard(request(), {
			withButtons: false,
			withSource: true,
		});
		expect(withSource.meta).toBe("Nodes: app-1, db-1 · Source: Session cleanup");
		expect(plain(withSource)).toContain("Nodes: app-1, db-1 · Source: Session cleanup");
		expect(telegram(withSource)).toContain("Nodes: app\\-1, db\\-1 · Source: Session cleanup");

		const token = messagesFor("en").approvalCard(
			request({
				source: { type: "api_token", tokenId: "t1", name: "deploy" },
				nodes: undefined,
				review: undefined,
			}),
			{ withButtons: false, withSource: true },
		);
		expect(token.meta).toBe("Source: API token deploy");
		expect(token.risk).toBeUndefined();
	});

	it("shows the review risk with its emoji and localized level, and no review line without one", () => {
		const low = messagesFor("en").approvalCard(request({ review: { risk: "low", reason: "read-only" } }), {
			withButtons: false,
			withSource: false,
		});
		expect(plain(low)).toContain("🟢 Low risk · read-only");
		const high = messagesFor("zh-CN").approvalCard(request({ review: { risk: "high", reason: "删除系统文件" } }), {
			withButtons: false,
			withSource: false,
		});
		expect(plain(high, "zh-CN")).toContain("🔴 高风险 · 删除系统文件");
		const none = messagesFor("en").approvalCard(request({ review: undefined }), {
			withButtons: false,
			withSource: false,
		});
		expect(none.risk).toBeUndefined();
		expect(plain(none)).not.toContain("risk");
	});

	it("renders each action's detail in the shared form", () => {
		const labels = messagesFor("en");
		const file = labels.approvalCard(
			request({
				action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 2, end: 4 } },
				nodes: undefined,
				privileged: false,
				review: undefined,
			}),
			{ withButtons: false, withSource: false },
		);
		expect(file.detail).toBe("Read file /etc/hosts (lines 2-4)");
		const api = labels.approvalCard(request({ action: { type: "api_request", method: "GET", path: "/api/nodes" } }), {
			withButtons: false,
			withSource: false,
		});
		expect(api.detail).toBe("GET /api/nodes");
		const tool = labels.approvalCard(
			request({ action: { type: "extension_tool", extension: "github", tool: "create_issue" } }),
			{ withButtons: false, withSource: false },
		);
		expect(tool.detail).toBe("github/create_issue");
		expect(plain(file)).toContain("Read file /etc/hosts (lines 2-4)");
	});

	it("renders the Chinese approval card", () => {
		const card = messagesFor("zh-CN").approvalCard(request(), { withButtons: true, withSource: true });
		expect(plain(card, "zh-CN")).toBe(
			[
				"需要你的审批 · 特权",
				"节点：app-1、db-1 · 请求源：会话 cleanup",
				"🟡 中风险 · deletion exceeds the instruction",
				"rm -rf /var/log/old/*.gz",
				"",
				"拒绝并说明原因：/reject task-1 原因",
			].join("\n"),
		);
	});

	it("renders a signature card from a request whose phase waits for a signature", () => {
		const card = messagesFor("en").signatureCard(
			request({
				phase: "awaiting_signature",
				action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 2, end: 4 } },
				nodes: ["app-1"],
				privileged: false,
				review: undefined,
			}),
			"https://crh.example/approvals/tasks/task-1",
			{ sign: true, localWindows: [], awaitingNode: false, withButtons: false, withSource: false },
		);
		expect(card.title).toBe("Signature needed");
		expect(card.hints).toEqual([
			"Sign in the WebUI: https://crh.example/approvals/tasks/task-1",
			"/reject task-1 [reason]",
		]);
		expect(plain(card)).toBe(
			[
				"Signature needed",
				"Nodes: app-1",
				"Read file /etc/hosts (lines 2-4)",
				"",
				"Sign in the WebUI: https://crh.example/approvals/tasks/task-1",
				"/reject task-1 [reason]",
			].join("\n"),
		);
		expect(plain(card)).not.toContain("/approve");

		// A surface with buttons carries the reject button, so its hint says how to reject with a reason.
		const buttonCard = messagesFor("en").signatureCard(
			request({ phase: "awaiting_signature", nodes: ["app-1"], review: undefined }),
			"https://crh.example/approvals/tasks/task-1",
			{ sign: true, localWindows: [], awaitingNode: false, withButtons: true, withSource: false },
		);
		expect(buttonCard.hints).toEqual([
			"Sign in the WebUI: https://crh.example/approvals/tasks/task-1",
			"Reject with a reason: /reject task-1 reason",
		]);

		const windowCard = messagesFor("en").signatureCard(
			request({ phase: "awaiting_signature", nodes: ["app-1"], review: undefined }),
			"https://crh.example/approvals/tasks/task-1",
			{ sign: false, localWindows: ["app-1"], awaitingNode: false, withButtons: false, withSource: false },
		);
		expect(windowCard.hints).toEqual(["Run sudo crha approve --for 30m on app-1", "/reject task-1 [reason]"]);

		const signedCard = messagesFor("zh-CN").signatureCard(
			request({ phase: "awaiting_signature", nodes: ["app-1"], review: undefined }),
			"https://crh.example/approvals/tasks/task-1",
			{ sign: false, localWindows: [], awaitingNode: true, withButtons: false, withSource: false },
		);
		expect(signedCard.hints).toEqual(["已签名：节点上线后发送", "/reject task-1 [原因]"]);
	});

	it("renders the quota card with the session title once, never wrapped in sessionBody", () => {
		const card = messagesFor("en").quotaCard("Clean up", quotaStatus(0, 120));
		expect(card).toEqual({
			title: "Token quota used up",
			privileged: false,
			meta: "Clean up",
			detail: "Used up, over by 0",
			hints: ["Continue: /quota add <tokens>", "End this turn: /quota stop"],
		});
		const text = telegram(card);
		expect(text).toBe(
			["**Token quota used up**", "Clean up", "`Used up, over by 0`"].join(TELEGRAM_LINE_BREAK) +
				`\n\nContinue: /quota add &lt;tokens\\>\\\nEnd this turn: /quota stop`,
		);
		expect(text.split("Clean up")).toHaveLength(2);
		expect(text).not.toContain('Session "Clean up"');
		expect(plain(card)).toBe(
			[
				"Token quota used up",
				"Clean up",
				"Used up, over by 0",
				"",
				"Continue: /quota add <tokens>",
				"End this turn: /quota stop",
			].join("\n"),
		);
		const zh = messagesFor("zh-CN").quotaCard("", quotaStatus(3, 42));
		expect(plain(zh, "zh-CN")).toBe(
			["令牌配额已用完", "新会话", "已用 42 · 剩余 3", "", "继续：/quota add <tokens>", "结束本回合：/quota stop"].join(
				"\n",
			),
		);
	});

	it("words a used-up and a remaining quota with one order and full separators", () => {
		const en = messagesFor("en");
		expect(en.quotaUsedUp(1234, 5678)).toContain("Used up, over by 1,234 tokens (5,678 used).");
		expect(en.quotaRemaining(5678, 1234)).toBe("Used 5,678 · 1,234 left.");
		expect(en.quotaCard("Clean up", quotaStatus(-300, 12_000)).detail).toBe("Used up, over by 300");
		expect(en.quotaCard("Clean up", quotaStatus(3, 12_000)).detail).toBe("Used 12,000 · 3 left");
		const zh = messagesFor("zh-CN");
		expect(zh.quotaUsedUp(1234, 5678)).toContain("已用完，超出 1,234 个令牌（已用 5,678）。");
		expect(zh.quotaRemaining(5678, 1234)).toBe("已用 5,678 · 剩余 1,234。");
		expect(zh.quotaCard("", quotaStatus(-300, 12_000)).detail).toBe("已用完，超出 300");
	});

	it("renders every result line and its localization", () => {
		const en = messagesFor("en");
		expect(en.approvedResult("alice")).toBe("✅ Approved · by alice");
		expect(en.approvedResult(en.card.autoReview)).toBe("✅ Approved · by Auto Review");
		expect(en.rejectedResult("alice", "not needed")).toBe("❌ Rejected · by alice: not needed");
		expect(en.rejectedResult("alice", null)).toBe("❌ Rejected · by alice");
		expect(en.expiredResult).toBe("Expired");
		const zh = messagesFor("zh-CN");
		expect(zh.approvedResult("alice")).toBe("✅ 已批准 · 由 alice");
		expect(zh.rejectedResult("alice", "不需要")).toBe("❌ 已拒绝 · 由 alice：不需要");
		expect(zh.expiredResult).toBe("已失效");
	});

	it("renders a standalone result line for each surface", () => {
		expect(renderCardLine("✅ Approved · by alice", "markdown")).toBe("✅ Approved · by alice");
		expect(renderCardLine("❌ Rejected · by a.b: not needed", "markdown")).toBe("❌ Rejected · by a\\.b: not needed");
		expect(renderCardLine("❌ Rejected · by a.b: not needed", "plain")).toBe("❌ Rejected · by a.b: not needed");
		expect(renderCardLine("Expired", "plain")).toBe("Expired");
	});
});

describe("completion notice lines", () => {
	const notice: JobNotice = {
		jobId: "call-1",
		kind: "call",
		action: { type: "file", operation: "read", path: "docs/a_b*c.txt" },
		outcome: { kind: "succeeded", failed: false },
		woke: true,
	};

	it("renders the Telegram Markdown line with escaped values", () => {
		expect(messagesFor("en").jobNotice(notice)).toBe(
			"Background job finished: Read file docs/a\\_b\\*c\\.txt · Done · the agent was woken",
		);
	});

	it("renders the same line as plain text on Satori, and localizes it", () => {
		expect(markdownEscapesToText(messagesFor("en").jobNotice(notice))).toBe(
			"Background job finished: Read file docs/a_b*c.txt · Done · the agent was woken",
		);
		expect(markdownEscapesToText(messagesFor("zh-CN").jobNotice({ ...notice, woke: false }))).toBe(
			"后台任务已完成：读取文件 docs/a_b*c.txt · 已完成",
		);
	});
});
