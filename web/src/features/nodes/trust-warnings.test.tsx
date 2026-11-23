import type { TrustWarning } from "@crh/api";
import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TrustWarningList } from "./trust-warnings";

const WARNINGS: TrustWarning[] = [
	{
		kind: "alias_superfluous",
		severity: "danger",
		uuid: "group-2",
		nodeGroupName: "db",
		trustName: null,
		message: "superfluous alias",
	},
	{
		kind: "alias_missing",
		severity: "info",
		uuid: "group-1",
		nodeGroupName: "web",
		trustName: null,
		message: "missing alias",
	},
	{
		kind: "trust_unknown",
		severity: "warning",
		uuid: null,
		nodeGroupName: null,
		trustName: "old-key",
		message: "unknown trust entry",
	},
	{
		kind: "pty_not_denied",
		severity: "warning",
		uuid: null,
		nodeGroupName: null,
		trustName: "crhs",
		message: "pty.create is not denied",
	},
];

describe("TrustWarningList", () => {
	test("lists each warning with its severity and values", () => {
		renderWithI18n(<TrustWarningList warnings={WARNINGS} />);
		expect(screen.getByRole("region", { name: "Trust warnings" })).toBeInTheDocument();
		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(4);
		expect(items[0]).toHaveAttribute("data-severity", "danger");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Reusable authorizations addressed to that group still work here.",
		);
		expect(items[2]).toHaveAttribute("data-severity", "warning");
		expect(screen.getByText("group-2")).toBeInTheDocument();
		expect(screen.getByText("old-key")).toBeInTheDocument();
		expect(screen.getByText(/crhs alone can open a privileged terminal/)).toBeInTheDocument();
	});

	test("translates the warnings in zh-CN", () => {
		renderWithI18n(<TrustWarningList warnings={WARNINGS} />, "zh-CN");
		expect(screen.getByRole("region", { name: "信任警告" })).toBeInTheDocument();
		expect(screen.getByText(/此别名指向节点不在其中的节点组/)).toBeInTheDocument();
	});
});
