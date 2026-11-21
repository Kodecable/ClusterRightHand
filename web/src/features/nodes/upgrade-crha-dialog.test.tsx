import { i18n } from "@lingui/core";
import { describe, expect, test } from "vitest";
import { activateLocale } from "@/test/render";
import { selfUpgradeReasonText, upgradeSkipText } from "./upgrade-crha-dialog";

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
