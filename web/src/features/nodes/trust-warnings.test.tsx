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
];

describe("TrustWarningList", () => {
	test("lists each warning with its severity and values", () => {
		renderWithI18n(<TrustWarningList warnings={WARNINGS} />);
		expect(screen.getByText("Trust warnings")).toBeInTheDocument();
		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(3);
		expect(items[0]).toHaveAttribute("data-severity", "danger");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Reusable authorizations addressed to that group still work here.",
		);
		expect(items[2]).toHaveAttribute("data-severity", "warning");
		expect(screen.getByText("group-2")).toBeInTheDocument();
		expect(screen.getByText("old-key")).toBeInTheDocument();
	});

	test("translates the warnings in zh-CN", () => {
		renderWithI18n(<TrustWarningList warnings={WARNINGS} />, "zh-CN");
		expect(screen.getByText("信任警告")).toBeInTheDocument();
		expect(screen.getByText(/这个别名指向节点并不属于的节点组/)).toBeInTheDocument();
	});
});
