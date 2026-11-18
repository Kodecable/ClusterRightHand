import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { openDb } from "../src/storage/db.ts";

describe("api", () => {
	it("reports health", async () => {
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		try {
			const res = await createApp(db).request("/api/health");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok" });
		} finally {
			await db.destroy();
		}
	});
});

describe("web root", () => {
	it("serves files, falls back to index.html, and keeps /api and /agent out of the fallback", async () => {
		const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const root = await mkdtemp(join(tmpdir(), "crh-web-"));
		await writeFile(join(root, "index.html"), "<html>shell</html>");
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets", "a.js"), "console.log(1)");
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		try {
			const app = createApp(db, { webRoot: root });
			expect(await (await app.request("/")).text()).toContain("shell");
			expect(await (await app.request("/nodes/x")).text()).toContain("shell");
			expect(await (await app.request("/assets/a.js")).text()).toContain("console.log");
			expect((await app.request("/api/unknown")).status).toBe(401);
			expect((await app.request("/agent/unknown")).status).toBe(404);
		} finally {
			await db.destroy();
		}
	});

	it("sends the WebUI's security headers on the document, not on API responses", async () => {
		const { mkdtemp, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const root = await mkdtemp(join(tmpdir(), "crh-web-"));
		const inline = "document.documentElement.dataset.theme = 'dark'";
		await writeFile(
			join(root, "index.html"),
			`<html><script>${inline}</script><script type="module" src="/assets/app.js"></script>shell</html>`,
		);
		const { createHash } = await import("node:crypto");
		const hash = `'sha256-${createHash("sha256").update(inline).digest("base64")}'`;
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		try {
			const app = createApp(db, { webRoot: root });
			for (const path of ["/", "/nodes/x"]) {
				const res = await app.request(path);
				const csp = res.headers.get("content-security-policy") ?? "";
				expect(csp).toContain("default-src 'self'");
				expect(csp).toContain("frame-ancestors 'none'");
				expect(csp).toContain("base-uri 'self'");
				expect(csp).toContain("object-src 'none'");
				// Only the shell's own inline script runs: by its hash, never 'unsafe-inline'.
				expect(csp).toContain(`script-src 'self' ${hash} 'wasm-unsafe-eval'`);
				expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
				expect(res.headers.get("x-frame-options")).toBe("DENY");
				expect(res.headers.get("referrer-policy")).toBe("same-origin");
			}
			const health = await app.request("/api/health");
			expect(health.headers.get("content-security-policy")).toBeNull();
			expect(health.headers.get("x-frame-options")).toBeNull();
		} finally {
			await db.destroy();
		}
	});
});
