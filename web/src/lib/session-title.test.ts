import { i18n } from "@lingui/core";
import { describe, expect, test } from "vitest";
import { activateLocale } from "@/test/render";
import { displaySessionTitle } from "./session-title";

describe("displaySessionTitle", () => {
	test("keeps a real title and names an empty or blank one", () => {
		activateLocale("en");
		expect(displaySessionTitle("Deploy the cluster", i18n)).toBe("Deploy the cluster");
		expect(displaySessionTitle(null, i18n)).toBe("New Session");
		expect(displaySessionTitle(undefined, i18n)).toBe("New Session");
		expect(displaySessionTitle("", i18n)).toBe("New Session");
		expect(displaySessionTitle("   \t\n", i18n)).toBe("New Session");
	});

	test("uses the active catalogue's wording", () => {
		activateLocale("zh-CN");
		expect(displaySessionTitle("部署集群", i18n)).toBe("部署集群");
		expect(displaySessionTitle(" ", i18n)).toBe("新会话");
	});
});
