import type { NodeUpgradeResponse } from "@crh/api";
import { i18n } from "@lingui/core";
import { useMutation } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { activateLocale, renderWithRouter } from "@/test/render";
import { selfUpgradeReasonText, UpgradeCrhaDialog, upgradeSkipText } from "./upgrade-crha-dialog";

describe("upgrade texts", () => {
	test("explain a node's reasons, and show a reason from a newer crha as it is", () => {
		activateLocale("en");
		expect(selfUpgradeReasonText(i18n, "package_managed")).toBe(
			"installed by the package manager (upgrade it with apt or dnf)",
		);
		expect(selfUpgradeReasonText(i18n, "some_future_reason")).toBe("some_future_reason");
		expect(upgradeSkipText(i18n, "newer_than_crhs")).toBe("newer than crhs; there is no downgrade");
	});

	test("are translated to Chinese", () => {
		activateLocale("zh-CN");
		expect(selfUpgradeReasonText(i18n, "unmanaged_unit")).toBe("其 systemd 单元不是由 crha enroll 生成的");
		expect(upgradeSkipText(i18n, "up_to_date")).toBe("已是此版本");
	});
});

const calls: { targets: string[]; dryRun: boolean }[] = [];
const plan: NodeUpgradeResponse = {
	version: "1.3.0",
	upgrades: [
		{ nodeId: "n-x86", name: "x86", version: "1.2.0", arch: "amd64", runningTasks: 0 },
		{ nodeId: "n-pi", name: "pi", version: "1.2.0", arch: "arm64", runningTasks: 0 },
	],
	skipped: [],
	taskGroups: [],
};
vi.mock("./api", async (importOriginal) => ({
	...(await importOriginal<typeof import("./api")>()),
	useUpgradeNodes: () =>
		useMutation({
			mutationFn: async (body: { targets: string[]; dryRun: boolean }) => {
				calls.push(body);
				return body.dryRun
					? plan
					: {
							...plan,
							taskGroups: [
								{ arch: "amd64", taskGroupId: "g-amd64" },
								{ arch: "arm64", taskGroupId: "g-arm64" },
							],
						};
			},
		}),
}));

describe("the upgrade dialog", () => {
	test("upgrades exactly the planned nodes and links every task group it started", async () => {
		calls.length = 0;
		await renderWithRouter(<UpgradeCrhaDialog targets={["group-1"]} onClose={() => {}} />);
		await screen.findByText("x86: 1.2.0 → 1.3.0 (amd64)");
		fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
		await screen.findByRole("link", { name: "Task group for arm64" });
		expect(screen.getByRole("link", { name: "Task group for amd64" })).toBeTruthy();
		expect(calls).toEqual([
			{ targets: ["group-1"], dryRun: true },
			{ targets: ["n-x86", "n-pi"], dryRun: false },
		]);
	});
});
