import type { LinguiConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

const config: LinguiConfig = {
	locales: ["en", "zh-CN"],
	sourceLocale: "en",
	catalogs: [
		{
			path: "<rootDir>/src/locales/{locale}",
			include: ["<rootDir>/src/**/*.ts", "<rootDir>/src/**/*.tsx"],
			exclude: [
				"<rootDir>/src/**/*.test.ts",
				"<rootDir>/src/**/*.test.tsx",
				"<rootDir>/src/test/**",
				"<rootDir>/src/markdown/__fixtures__/**",
			],
		},
	],
	format: formatter({ lineNumbers: false }),
	compileNamespace: "es",
};

export default config;
