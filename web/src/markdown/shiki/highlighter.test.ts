import { describe, expect, test } from "vitest";
import { ensureLanguage, type LangKey, resolveLang } from "./highlighter";

describe("resolveLang", () => {
	test("resolves languages and their aliases", () => {
		expect(resolveLang("bash")).toBe("bash");
		expect(resolveLang("language-bash")).toBe("bash");
		expect(resolveLang("sh")).toBe("bash");
		expect(resolveLang("tsx")).toBe("typescript");
		expect(resolveLang("yml")).toBe("yaml");
		expect(resolveLang("{.py}")).toBe("python");
		expect(resolveLang("text")).toBeNull();
		expect(resolveLang(undefined)).toBeNull();
	});

	test("does not resolve names inherited from Object.prototype", () => {
		for (const name of ["constructor", "__proto__", "prototype", "toString", "hasOwnProperty"]) {
			expect(resolveLang(name)).toBeNull();
		}
	});

	test("does not load a language inherited from Object.prototype", async () => {
		await expect(ensureLanguage("__proto__" as LangKey)).resolves.toBe(false);
		await expect(ensureLanguage("constructor" as LangKey)).resolves.toBe(false);
	});
});
