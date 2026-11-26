import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import { builtinProvider, configureBuiltinExtensions } from "../src/extensions/builtin.ts";
import { copyDocFiles, defaultDocsRoot, docFiles } from "../src/extensions/docs-source.ts";
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

async function writeDoc(root: string, path: string, content: string): Promise<void> {
	const target = join(root, ...path.split("/"));
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
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

const INSTALL_DOC = [
	"# Install crhs",
	"",
	"crhs runs on the server host.",
	"",
	"## Prerequisites",
	"",
	"The server needs Linux.",
	"",
	"### Requirements",
	"",
	"- glibc Linux",
	"",
	"## Install crhs",
	"",
	"Unpack the archive.",
	"",
	"## Troubleshooting",
	"",
	"### crhs does not start",
	"",
	"Check the bundled Node.",
].join("\n");

const SEARCH_DOC = [
	"# Guide",
	"",
	"## Widget controls",
	"",
	"Controls for the dashboard.",
	"",
	"## Extension approval",
	"",
	"An extension approval is required before use.",
	"",
	"## Troubleshooting",
	"",
	"### crhs does not start",
	"",
	"Check the crhs service.",
	"",
	"### Login fails",
	"",
	"Check the password.",
].join("\n");

async function docsFixture(): Promise<string> {
	const root = await tempDir();
	await writeDoc(root, "README.md", "# Documentation\n\nHow to read these docs.\n");
	await writeDoc(root, "guide/install.md", INSTALL_DOC);
	await writeDoc(root, "guide/reference/cli.md", "# Command line\n\nRun `crhs --help`.\n");
	await writeDoc(root, "examples/crhs.toml", '[service]\nlisten = "0.0.0.0:8080"\ndatabase = "sqlite"\n');
	await writeDoc(root, "images/session.png", "\x89PNG not really an image");
	return root;
}

describe("crhs-docs extension", () => {
	it("searches the running version's documentation for a known heading", async () => {
		configureBuiltinExtensions();
		const found = await callDocs("search_docs", { query: "Built-in extensions" });
		expect(found).toContain("design/extensions.md#built-in-extensions");
		expect(found).toContain("read one with read_doc");
	});

	it("lists a directory and its subdirectories with titles and without images", async () => {
		const root = await docsFixture();
		configureBuiltinExtensions({ docsRoot: root });

		const top = await callDocs("read_doc", { path: "" });
		expect(top).toContain("examples/");
		expect(top).toContain("guide/");
		expect(top).toContain("README.md — Documentation");
		expect(top).not.toContain("images/");
		expect(top).not.toContain("session.png");
		expect(await callDocs("read_doc", { path: "/" })).toContain("README.md — Documentation");

		const guide = await callDocs("read_doc", { path: "guide/" });
		expect(guide).toContain("guide/reference/");
		expect(guide).toContain("guide/install.md — Install crhs");
		expect(guide).not.toContain("README.md");
		// A directory path without the trailing slash is the same directory.
		expect(await callDocs("read_doc", { path: "guide" })).toContain("guide/install.md — Install crhs");

		const first = await callDocs("read_doc", { path: "guide/", limit: 1 });
		expect(first).toContain("guide/reference/");
		expect(first).not.toContain("guide/install.md");
		expect(first).toContain("use offset=2 to continue");
		const second = await callDocs("read_doc", { path: "guide/", offset: 2, limit: 1 });
		expect(second).toContain("guide/install.md — Install crhs");
		expect(second).toContain("end of directory");
	});

	it("rejects a section for a directory", async () => {
		const root = await docsFixture();
		configureBuiltinExtensions({ docsRoot: root });
		await expect(callDocs("read_doc", { path: "guide/", section: "Install crhs" })).rejects.toThrow(
			/directory has no sections/,
		);
	});

	it("outlines a Markdown document with levels, anchors, line counts and a whole-document hint", async () => {
		const root = await docsFixture();
		await writeDoc(root, "guide/options.md", "## First option\n\nText.");
		configureBuiltinExtensions({ docsRoot: root });

		const outline = await callDocs("read_doc", { path: "guide/install.md" });
		expect(outline).toContain("# Install crhs [install-crhs] — 21 lines");
		expect(outline).toContain("  ## Prerequisites [prerequisites] — 8 lines");
		expect(outline).toContain("    ### Requirements [requirements] — 4 lines");
		expect(outline).toContain("  ## Troubleshooting [troubleshooting] — 5 lines");
		expect(outline).toContain("    ### crhs does not start [crhs-does-not-start] — 3 lines");
		expect(outline).toContain('read the whole document with read_doc("guide/install.md", "install-crhs")');
		expect(outline).not.toContain("The server needs Linux.");

		const paged = await callDocs("read_doc", { path: "guide/install.md", offset: 2, limit: 2 });
		expect(paged).toContain("## Prerequisites");
		expect(paged).toContain("### Requirements");
		expect(paged).toContain("use offset=4 to continue");
		expect(paged).not.toContain("# Install crhs [install-crhs]");

		// An empty section is the same as none.
		const emptySection = await callDocs("read_doc", { path: "guide/install.md", section: "" });
		expect(emptySection).toContain('read the whole document with read_doc("guide/install.md", "install-crhs")');

		// Without a first-level heading, the hint uses the first heading.
		const noTitle = await callDocs("read_doc", { path: "guide/options.md" });
		expect(noTitle).toContain("## First option [first-option] — 3 lines");
		expect(noTitle).toContain('read the whole document with read_doc("guide/options.md", "first-option")');
	});

	it("reads a section with its subsections and stops at the next heading of the same level", async () => {
		const root = await docsFixture();
		configureBuiltinExtensions({ docsRoot: root });

		const parent = await callDocs("read_doc", { path: "guide/install.md", section: "prerequisites" });
		expect(parent).toContain("## Prerequisites");
		expect(parent).toContain("The server needs Linux.");
		expect(parent).toContain("### Requirements");
		expect(parent).toContain("- glibc Linux");
		expect(parent).not.toContain("Unpack the archive.");
		expect(parent).toContain("end of section");

		const byHeading = await callDocs("read_doc", { path: "guide/install.md", section: "Install crhs" });
		expect(byHeading).toContain("Unpack the archive.");

		// A parent heading directly followed by subheadings is not empty.
		const troubleshooting = await callDocs("read_doc", { path: "guide/install.md", section: "Troubleshooting" });
		expect(troubleshooting).toContain("### crhs does not start");
		expect(troubleshooting).toContain("Check the bundled Node.");
		expect(troubleshooting).toContain("end of section");
	});

	it("reads a non-Markdown text file whole and pages it, without sections", async () => {
		const root = await docsFixture();
		configureBuiltinExtensions({ docsRoot: root });

		const whole = await callDocs("read_doc", { path: "examples/crhs.toml" });
		expect(whole).toContain("[service]");
		expect(whole).toContain('listen = "0.0.0.0:8080"');
		expect(whole).toContain('database = "sqlite"');
		expect(whole).toContain("end of document");

		const paged = await callDocs("read_doc", { path: "examples/crhs.toml", offset: 2, limit: 1 });
		expect(paged).toContain('listen = "0.0.0.0:8080"');
		expect(paged).toContain("lines 2-2 of 4");
		expect(paged).toContain("use offset=3 to continue");

		await expect(callDocs("read_doc", { path: "examples/crhs.toml", section: "service" })).rejects.toThrow(
			/not a Markdown document/,
		);
	});

	it("lists close matches for an unknown path, including directories", async () => {
		const root = await docsFixture();
		configureBuiltinExtensions({ docsRoot: root });
		await expect(callDocs("read_doc", { path: "guide/instal.md" })).rejects.toThrow(
			/close matches: .*guide\/install\.md/,
		);
		await expect(callDocs("read_doc", { path: "guied/" })).rejects.toThrow(/close matches: guide\//);
	});

	it("skips NUL-containing and unknown-extension files when loading", async () => {
		const root = await tempDir();
		await writeDoc(root, "guide.md", "# Guide\n\nReadable text.\n");
		await writeDoc(root, "good.txt", "alpha\nbeta\n");
		await writeDoc(root, "binary.txt", "nul\0here");
		await writeDoc(root, "nul.md", "# Nul\n\0binary");
		await writeDoc(root, "image.png", "not an image either");
		configureBuiltinExtensions({ docsRoot: root });

		const listing = await callDocs("read_doc", { path: "" });
		expect(listing).toContain("good.txt — good.txt");
		expect(listing).toContain("guide.md — Guide");
		expect(listing).not.toContain("binary.txt");
		expect(listing).not.toContain("nul.md");
		expect(listing).not.toContain("image.png");
		expect(await callDocs("read_doc", { path: "good.txt" })).toContain("beta");
	});

	it("does not return a heading-only snippet when the section has text", async () => {
		const root = await tempDir();
		await writeDoc(root, "guide.md", SEARCH_DOC);
		configureBuiltinExtensions({ docsRoot: root });

		const widget = await callDocs("search_docs", { query: "widget" });
		expect(widget).toContain("guide.md#widget-controls");
		expect(widget).toContain("Controls for the dashboard.");
	});

	it("finds a parent chapter's subsections and does not return the empty chapter", async () => {
		const root = await tempDir();
		await writeDoc(root, "guide.md", SEARCH_DOC);
		configureBuiltinExtensions({ docsRoot: root });

		const found = await callDocs("search_docs", { query: "troubleshooting" });
		expect(found).not.toContain("guide.md#troubleshooting");
		expect(found).toContain("guide.md#crhs-does-not-start");
		expect(found).toContain("guide.md#login-fails");
		expect(found).toContain("Check the crhs service.");
		expect(found).toContain("Check the password.");
	});

	it("takes a typo query's snippet from the text it actually matched", async () => {
		const root = await tempDir();
		await writeDoc(root, "guide.md", SEARCH_DOC);
		configureBuiltinExtensions({ docsRoot: root });

		const found = await callDocs("search_docs", { query: "extention approvl" });
		expect(found).toContain("guide.md#extension-approval");
		expect(found).toContain("An extension approval is required before use.");
	});

	it("finds a non-Markdown file by its content and reads it without a section", async () => {
		const root = await tempDir();
		await writeDoc(root, "examples/crhs.toml", 'listen = "0.0.0.0:8080"\n');
		configureBuiltinExtensions({ docsRoot: root });

		const found = await callDocs("search_docs", { query: "listen", limit: 1 });
		expect(found).toContain("examples/crhs.toml — crhs.toml");
		expect(found).toContain('listen = "0.0.0.0:8080"');
		expect(found).not.toContain("crhs.toml#");
		expect(found).toContain('read_doc("examples/crhs.toml")');
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

			const api = await callDocs("read_doc", { path: "api/" });
			expect(api).toContain("api/nodes.md — Nodes");
			expect(api).toContain("api/schemas.md — Shared API schemas");

			const outline = await callDocs("read_doc", { path: "api/nodes.md" });
			expect(outline).toContain("# Nodes [nodes]");
			expect(outline).toContain('read the whole document with read_doc("api/nodes.md", "nodes")');

			const nodes = await callDocs("read_doc", { path: "api/nodes.md", section: "nodes", limit: 40 });
			expect(nodes).toContain("GET /api/nodes");
			expect(nodes).toContain("Agent access: read (allow)");
			const users = await callDocs("read_doc", { path: "api/users.md", section: "users" });
			expect(users).toContain("GET /api/users");
			expect(users).not.toContain("POST /api/users");
			const schemas = await callDocs("read_doc", { path: "api/schemas.md", section: "shared-api-schemas" });
			expect(schemas).toContain("## NodeGroup");
			// Only the deny route that creates a signing key uses this shape; the credential list is an allow read.
			expect(schemas).not.toContain("## SigningKeyCreateResponse");
			expect(schemas).toContain("## SigningCredentialView");
		} finally {
			await db.destroy();
		}
	});

	it("copies the documentation text files into a bundle and leaves binary files out", async () => {
		const root = await tempDir();
		await mkdir(join(root, "nested"));
		await mkdir(join(root, "images"));
		await mkdir(join(root, "examples"));
		await writeFile(join(root, "root.md"), "# Root\n");
		await writeFile(join(root, "nested", "child.md"), "# Child\n");
		await writeFile(join(root, "nested", "config.yaml"), "key: value\n");
		await writeFile(join(root, "examples", "crhs.toml"), 'listen = "0.0.0.0:8080"\n');
		await writeFile(join(root, "images", "picture.png"), "not markdown");
		await writeFile(join(root, "notes.bin"), "not documentation");
		const target = await tempDir();
		const copied = await copyDocFiles(root, target);
		expect(copied).toEqual(["examples/crhs.toml", "nested/child.md", "nested/config.yaml", "root.md"]);
		expect(await readFile(join(target, "nested", "child.md"), "utf8")).toBe("# Child\n");
		expect(await readFile(join(target, "nested", "config.yaml"), "utf8")).toBe("key: value\n");
		expect(await readFile(join(target, "examples", "crhs.toml"), "utf8")).toBe('listen = "0.0.0.0:8080"\n');
		await expectMissing(join(target, "images", "picture.png"));
		await expectMissing(join(target, "notes.bin"));
	});

	it("resolves the repository's doc tree when unbundled", async () => {
		const paths = await docFiles(defaultDocsRoot());
		expect(paths).toContain("design/extensions.md");
		expect(paths.every((path) => /\.(md|toml|yaml|yml|json|sh|txt|conf)$/i.test(path))).toBe(true);
		expect(paths.some((path) => path.startsWith("images/"))).toBe(false);
	});
});
