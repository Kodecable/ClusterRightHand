/// <reference types="vite/client" />

declare const __CRH_VERSION__: string;

declare module "*.po" {
	export const messages: Record<string, string>;
}
