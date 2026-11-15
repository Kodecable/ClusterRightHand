import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import { builtinProvider, configureBuiltinExtensions } from "../src/extensions/builtin.ts";
import { copyDocMarkdown, defaultDocsRoot, markdownDocs } from "../src/extensions/docs-source.ts";
import { sessionExtensionsForUser } from "../src/extensions/registry.ts";
import { saveExtension } from "../src/extensions/store.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

/** The built-in `crhs-docs` extension (doc/design/extensions.md "Documentation"). */

const temporary: string[] = [];

afterEach(async () => {
	configureBuiltinExtensions();
	for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "crh-docs-"));
	temporary.push(dir);
	return dir;
}

function textOf(result: CallToolResult): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text !== "")
		.join("\n");
}

async function callDocs(tool: string, args: Record<string, unknown>): Promise<string> {
	const provider = builtinProvider("crhs-docs");
	if (!provider) throw new Error("no crhs-docs extension");
	const result = (await provider.call(tool, args, {})) as CallToolResult;
	return textOf(result);
}

async function expectMissing(path: string): Promise<void> {
	await expect(access(path)).rejects.toThrow();
}

describe("crhs-docs extension", () => {
	it("searches the running version's documentation for a known heading", async () => {
		configureBuiltinExtensions();
		const found = await callDocs("search_docs", { query: "Built-in extensions" });
		expect(found).toContain("design/extensions.md#built-in-extensions");
		expect(found).toContain("read one with read_doc");
	});

	it("reads a whole document, one section by anchor or heading, and pages long content", async () => {
		const root = await tempDir();
		const lines = ["# Guide", "", "The guide's introduction.", "", "## Known heading", ""];
		for (let index = 1; index <= 30; index += 1) lines.push(`line ${index}`);
		await writeFile(join(root, "guide.md"), `${lines.join("\n")}\n`);
		configureBuiltinExtensions({ docsRoot: root });

		const whole = await callDocs("read_doc", { path: "guide.md", limit: 5 });
		expect(whole).toContain("# Guide");
		expect(whole).toContain("lines 1-5 of");

		const byAnchor = await callDocs("read_doc", { path: "guide.md", section: "known-heading", limit: 4 });
		expect(byAnchor).toContain("## Known heading");
		expect(byAnchor).not.toContain("The guide's introduction.");
		expect(byAnchor).toContain("line 1");
		expect(byAnchor).toContain("use offset=5 to continue");

		const byHeading = await callDocs("read_doc", { path: "guide.md", section: "Known heading", offset: 31, limit: 10 });
		expect(byHeading).toContain("line 29");
		expect(byHeading).toContain("end of section");

		const searched = await callDocs("search_docs", { query: "known heading" });
		expect(searched).toContain("guide.md#known-heading");
	});

	it("ranks a natural-language query's node group section first", async () => {
		configureBuiltinExtensions();
		const found = await callDocs("search_docs", { query: "what is a node group and how do I create one" });
		const first = found.split("\n")[0] ?? "";
		expect(first).toContain("#node-groups");
		expect(first).toContain("Node groups");
	});

	it("finds the API requests section from api_request and request", async () => {
		configureBuiltinExtensions();
		for (const query of ["api_request", "request"]) {
			const found = await callDocs("search_docs", { query });
			expect(found).toContain("design/extensions.md#api-requests");
		}
	});

	it("stems plurals, tolerates a typo, and ranks a heading hit above a text-only hit", async () => {
		const root = await tempDir();
		await writeFile(
			join(root, "guide.md"),
			[
				"# Guide",
				"",
				"## Widget controls",
				"",
				"Controls for the dashboard.",
				"",
				"## Other topic",
				"",
				"A widget appears here in the text once.",
				"",
				"## Node group",
				"",
				"A node group is a named set of nodes.",
				"",
			].join("\n"),
		);
		configureBuiltinExtensions({ docsRoot: root });

		const groups = await callDocs("search_docs", { query: "groups" });
		expect(groups).toContain("guide.md#node-group");

		const typo = await callDocs("search_docs", { query: "grup" });
		expect(typo).toContain("guide.md#node-group");

		const widget = await callDocs("search_docs", { query: "widget" });
		expect(widget.split("\n")[0]).toContain("guide.md#widget-controls");
	});

	it("returns nothing for a stopword-only query", async () => {
		configureBuiltinExtensions();
		const found = await callDocs("search_docs", { query: "what is the" });
		expect(found).toContain("No documentation section matched");
	});

	it("lists close matches for an unknown path", async () => {
		configureBuiltinExtensions();
		await expect(callDocs("read_doc", { path: "design/extension.md" })).rejects.toThrow(
			/close matches: design\/extensions\.md/,
		);
	});

	it("renders the API reference with allow routes and without deny routes, even with crhs-api disabled", async () => {
		const db: Db = await openTestDb("sqlite");
		try {
			const audit = new Audit(db);
			createApp(db, { audit });
			const admin = await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
			await saveExtension(db, MasterKey.generate(), "crhs-api", { enabled: false }, admin.id);

			const entries = await sessionExtensionsForUser(db, admin.id, [], undefined);
			expect(entries.map((entry) => entry.extension.name)).toContain("crhs-docs");
			expect(entries.map((entry) => entry.extension.name)).not.toContain("crhs-api");

			const nodes = await callDocs("read_doc", { path: "api/nodes.md", limit: 40 });
			expect(nodes).toContain("GET /api/nodes");
			expect(nodes).toContain("Agent access: read (allow)");
			const users = await callDocs("read_doc", { path: "api/users.md" });
			expect(users).toContain("GET /api/users");
			expect(users).not.toContain("POST /api/users");
			const schemas = await callDocs("read_doc", { path: "api/schemas.md" });
			expect(schemas).toContain("## NodeGroup");
			expect(schemas).not.toContain("## SigningCredentialView");
		} finally {
			await db.destroy();
		}
	});

	it("copies only Markdown into a bundle, preserving the tree", async () => {
		const root = await tempDir();
		await mkdir(join(root, "nested"));
		await mkdir(join(root, "images"));
		await writeFile(join(root, "root.md"), "# Root\n");
		await writeFile(join(root, "nested", "child.md"), "# Child\n");
		await writeFile(join(root, "images", "picture.png"), "not markdown");
		const target = await tempDir();
		const copied = await copyDocMarkdown(root, target);
		expect(copied).toEqual(["nested/child.md", "root.md"]);
		expect(await readFile(join(target, "nested", "child.md"), "utf8")).toBe("# Child\n");
		expect(await readFile(join(target, "root.md"), "utf8")).toBe("# Root\n");
		await expectMissing(join(target, "images", "picture.png"));
	});

	it("resolves the repository's doc tree when unbundled", async () => {
		const paths = await markdownDocs(defaultDocsRoot());
		expect(paths).toContain("design/extensions.md");
		expect(paths.every((path) => path.endsWith(".md"))).toBe(true);
	});
});
