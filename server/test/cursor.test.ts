import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/storage/db.ts";
import {
	CursorError,
	type CursorKey,
	cursorRows,
	decodeCursor,
	descendingKeyset,
	encodeCursor,
	parseLimit,
} from "../src/util/cursor.ts";
import { openTestDb } from "./helpers/db.ts";

const TEXT_CURSOR = { columns: [{ name: "created_at", type: "string" }], idType: "string" } as const;
const NUMBER_CURSOR = { columns: [{ name: "seq", type: "number" }], idType: "string" } as const;

/** The base64url of a UTF-8 string, for cursors that decode but are not the expected shape. */
const encoded = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

describe("keyset cursors", () => {
	it("round-trips the sort key and the id", () => {
		const raw = encodeCursor(["2026-01-02T03:04:05.000Z"], "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
		expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(raw).not.toContain("=");
		expect(decodeCursor(raw, TEXT_CURSOR)).toEqual({
			values: ["2026-01-02T03:04:05.000Z"],
			id: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
		});
		const numeric = encodeCursor([42], "abc");
		expect(decodeCursor(numeric, NUMBER_CURSOR)).toEqual({ values: [42], id: "abc" });
		// A history cursor has no sort column: the entry id is the whole position.
		const history = encodeCursor([], 123);
		expect(decodeCursor(history, { columns: [], idType: "number" })).toEqual({ values: [], id: 123 });
	});

	it("rejects garbage strictly", () => {
		const garbage = [
			"",
			"!",
			"====",
			"not base64url!",
			encoded(""),
			encoded("not json"),
			encoded("null"),
			encoded("[]"),
			encoded('"x"'),
			encoded("{}"),
			encoded('{"k":["x"]}'),
			encoded('{"id":"x"}'),
			encoded('{"k":[],"id":"x"}'),
			encoded('{"k":["x","y"],"id":"z"}'),
			encoded('{"k":[1],"id":"z"}'),
			encoded('{"k":["x"],"id":1}'),
			encoded('{"k":["x"],"id":"z","extra":1}'),
			encoded(`{"k":["${"x".repeat(300)}"],"id":"z"}`),
			encoded('{"k":null,"id":"z"}'),
			encoded('{"k":{"0":"x"},"id":"z"}'),
			`${"A".repeat(600)}`,
		];
		for (const raw of garbage) {
			expect(() => decodeCursor(raw, TEXT_CURSOR), raw.slice(0, 40)).toThrow(CursorError);
		}
		// A number cursor refuses a string sort value even when the JSON is otherwise well formed.
		expect(() => decodeCursor(encoded('{"k":["1"],"id":"z"}'), NUMBER_CURSOR)).toThrow(CursorError);
		// 1.5 is not an integer position.
		expect(() => decodeCursor(encoded('{"k":[1.5],"id":"z"}'), NUMBER_CURSOR)).toThrow(CursorError);
	});

	it("accepts a page size from 1 to 200 and defaults otherwise", () => {
		expect(parseLimit(undefined)).toBe(50);
		expect(parseLimit(undefined, 100)).toBe(100);
		expect(parseLimit("1")).toBe(1);
		expect(parseLimit("200")).toBe(200);
		for (const raw of ["", " ", "0", "-1", "201", "1.5", "1e2", "abc", "null"]) {
			expect(() => parseLimit(raw), raw).toThrow(CursorError);
		}
	});
});

describe("keyset paging", () => {
	let db: Db;
	// biome-ignore lint/suspicious/noExplicitAny: the scratch table is not part of the application schema
	let scratch: Kysely<any>;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		scratch = db as Kysely<unknown> as Kysely<Record<string, unknown>>;
		await scratch.schema
			.createTable("scratch")
			.addColumn("a", "text", (c) => c.notNull())
			.addColumn("b", "text", (c) => c.notNull())
			.addColumn("id", "text", (c) => c.notNull().primaryKey())
			.addColumn("seq", "integer", (c) => c.notNull())
			.execute();
		// Ties on `a` and on `(a, b)`: only the id can tell the rows apart.
		const rows: { a: string; b: string; id: string; seq: number }[] = [];
		const groups = [
			["2026-01-02", "x"],
			["2026-01-02", "y"],
			["2026-01-01", "z"],
		];
		for (let index = 0; index < 30; index++) {
			const group = groups[index % groups.length] as [string, string];
			rows.push({ a: group[0], b: group[1], id: `id-${String(index).padStart(2, "0")}`, seq: index });
		}
		await scratch.insertInto("scratch").values(rows).execute();
	});

	afterAll(async () => {
		await db.destroy();
	});

	/** The expected order for the given columns, all descending, id last. */
	const expected = async (columns: ("a" | "b" | "seq")[]): Promise<string[]> => {
		const rows = (await scratch.selectFrom("scratch").selectAll().execute()) as {
			a: string;
			b: string;
			id: string;
			seq: number;
		}[];
		rows.sort((left, right) => {
			for (const column of columns) {
				if (left[column] < right[column]) return 1;
				if (left[column] > right[column]) return -1;
			}
			return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
		});
		return rows.map((row) => row.id);
	};

	const pageThrough = async (columns: ("a" | "b" | "seq")[], limit: number): Promise<string[]> => {
		const spec = {
			columns: columns.map((name) => ({ name, type: name === "seq" ? ("number" as const) : ("string" as const) })),
			idType: "string" as const,
		};
		const seen: string[] = [];
		let cursor: CursorKey | undefined;
		for (let guard = 0; guard < 100; guard++) {
			const condition = cursor ? descendingKeyset(columns, cursor) : undefined;
			const page = await cursorRows(
				limit,
				(limitPlusOne) => {
					let query = scratch.selectFrom("scratch").select(["a", "b", "id", "seq"]);
					if (condition) query = query.where(condition);
					for (const column of columns) query = query.orderBy(column, "desc");
					return query.orderBy("id", "desc").limit(limitPlusOne).execute();
				},
				(row) =>
					encodeCursor(
						columns.map((column) => row[column]),
						row.id,
					),
			);
			seen.push(...page.rows.map((row: { id: string }) => row.id));
			if (!page.nextCursor) return seen;
			cursor = decodeCursor(page.nextCursor, spec);
		}
		throw new Error("paging did not finish");
	};

	it("visits every row exactly once across ties on a single column", async () => {
		const seen = await pageThrough(["a"], 4);
		expect(seen).toEqual(await expected(["a"]));
		expect(new Set(seen).size).toBe(30);
	});

	it("visits every row exactly once across ties on multiple columns", async () => {
		for (const limit of [1, 3, 7]) {
			const seen = await pageThrough(["a", "b"], limit);
			expect(seen, `limit ${limit}`).toEqual(await expected(["a", "b"]));
			expect(new Set(seen).size).toBe(30);
		}
	});

	it("handles a numeric sort key", async () => {
		const seen = await pageThrough(["seq"], 5);
		expect(seen).toEqual(await expected(["seq"]));
	});
});
