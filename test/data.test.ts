import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { expandDataRefs, MAX_DATA_BYTES, readCsv } from "../data.ts";
import { renderChart } from "../render.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-mpl-data-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, text: string): string => {
	const path = join(dir, name);
	writeFileSync(path, text);
	return path;
};

const csv = write(
	"sales.csv",
	[
		"date,revenue,cost,note",
		"2026-01-01,10,4,\"a, quoted\"",
		"2026-01-02,12,5,plain",
		"2026-01-03,,7,\"quote \"\"inside\"\"\"",
	].join("\r\n"),
);
const semi = write("semi.csv", "bucket;count\na;3\nb;5\n");
const headless = write("headless.csv", "1,2\n3,4\n");
const named = write("series.json", JSON.stringify({ series: [1, 2, 3] }));

test("readCsv infers numbers and dates, keeps quoted delimiters, and leaves gaps as NaN", () => {
	const table = readCsv({ $csv: csv });
	assert.deepEqual(table.names, ["date", "revenue", "cost", "note"]);
	const dates = table.columns[0] as unknown as { $dates: string[] };
	assert.deepEqual(dates.$dates, ["2026-01-01", "2026-01-02", "2026-01-03"]);
	const revenue = table.columns[1] as number[];
	assert.deepEqual(revenue.slice(0, 2), [10, 12]);
	assert.ok(Number.isNaN(revenue[2] as number));
	assert.deepEqual(table.columns[3], ["a, quoted", "plain", 'quote "inside"']);
});

test("readCsv handles files with more rows than a spread can carry, and caches the parse", () => {
	const rows = ["n,v", ...Array.from({ length: 70_000 }, (_, i) => `${i},${i * 2}`)].join("\n");
	const big = write("big.csv", rows);
	const table = readCsv({ $csv: big });
	assert.equal((table.columns[0] as unknown[]).length, 70_000);
	assert.deepEqual((table.columns[1] as number[]).slice(-2), [139_996, 139_998]);
	assert.equal(readCsv({ $csv: big }), table, "the parsed table is reused");
});

test("readCsv detects semicolon files and reads headerless data", () => {
	const table = readCsv({ $csv: semi });
	assert.deepEqual(table.names, ["bucket", "count"]);
	assert.deepEqual(table.columns[1], [3, 5]);
	const raw = readCsv({ $csv: headless, header: false });
	assert.deepEqual(raw.names, []);
	assert.deepEqual(raw.columns, [
		[1, 3],
		[2, 4],
	]);
});

test("expandDataRefs turns a csv argument into x and y", () => {
	const spec = expandDataRefs({ calls: [["plot", [{ $csv: csv, x: "date", y: "revenue" }], { label: "s" }]] });
	const [fn, args] = spec.calls[0] as [string, unknown[]];
	assert.equal(fn, "plot");
	assert.equal(args.length, 2);
	assert.deepEqual((args[0] as unknown as { $dates: string[] }).$dates[0], "2026-01-01");
	assert.deepEqual((args[1] as number[]).slice(0, 2), [10, 12]);
});

test("one column per series: a multi-column y asks for separate calls", () => {
	assert.throws(
		() => expandDataRefs({ calls: [["plot", [{ $csv: csv, x: "date", y: ["revenue", "cost"] }]]] }),
		/\{\$csv\} y takes one column, got 2; make one call per series/,
	);
	const spec = expandDataRefs({
		calls: [
			["plot", [{ $csv: csv, x: "date", y: "revenue" }]],
			["plot", [{ $csv: csv, x: "date", y: "cost" }]],
		],
	});
	const second = (spec.calls[1] as [string, unknown[]])[1][1] as number[];
	assert.deepEqual(second.slice(0, 2), [4, 5]);
});

test("expandDataRefs reads a single column into kwargs and a JSON file into a value", () => {
	const spec = expandDataRefs({
		calls: [
			["plot", [[1, 2, 3], [3, 1, 2]], { yerr: { $csv: semi, column: "count" } }],
			["plot", [{ $json: named }]],
		],
	});
	const kwargs = (spec.calls[0] as [string, unknown[], Record<string, unknown>])[2];
	assert.deepEqual(kwargs.yerr, [3, 5]);
	const third = (spec.calls[1] as [string, unknown[]])[1][0] as { series: number[] };
	assert.deepEqual(third.series, [1, 2, 3]);
});

test("expandDataRefs reports unknown columns with the available names", () => {
	assert.throws(
		() => expandDataRefs({ calls: [["plot", [{ $csv: csv, x: "date", y: ["nope"] }]]] }),
		/\"nope\" is not in .*columns: date, revenue, cost, note/,
	);
	assert.throws(() => expandDataRefs({ calls: [["plot", [{ $csv: join(dir, "missing.csv") }]]] }), /cannot read/);
	assert.throws(
		() => expandDataRefs({ calls: [["plot", [[1, 2]], { label: { $csv: csv, x: "date", y: "revenue" } }]] }),
		/expands to 2 arrays, so it must be a positional argument/,
	);
});

test("renderChart draws from a CSV without pasting the numbers", () => {
	const out = renderChart({ name: "csv", calls: [["plot", [{ $csv: semi, x: "bucket", y: "count" }], { label: "s" }]] as never }, dir);
	assert.ok(out.pngPath);
	const png = out.png as Uint8Array;
	assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("readCsv rejects malformed quoted fields rather than silently changing data", () => {
	assert.throws(() => readCsv({ $csv: "bad.csv" }, { readFile: () => 'a,b\n"unfinished,2\n' }), /unterminated quoted field/);
	assert.throws(() => readCsv({ $csv: "bad.csv" }, { readFile: () => 'a,b\n"closed"oops,2\n' }), /unexpected character after closing quote/);
});

test("readCsv reparses when the file changes", () => {
	const path = write("fresh.csv", "x,y\n1,10\n");
	const first = readCsv({ $csv: path });
	assert.deepEqual(first.columns[1], [10]);
	writeFileSync(path, "x,y\n1,999\n");
	const second = readCsv({ $csv: path });
	assert.notEqual(second, first);
	assert.deepEqual(second.columns[1], [999]);
});

test("an injected readFile is not reused for a later call", () => {
	const first = readCsv({ $csv: "mem.csv" }, { readFile: () => "n\n1\n" });
	const second = readCsv({ $csv: "mem.csv" }, { readFile: () => "n\n2\n" });
	assert.deepEqual(first.columns[0], [1]);
	assert.deepEqual(second.columns[0], [2]);
});

test("renderChart picks up a rewritten csv instead of reusing the png", () => {
	const path = write("live.csv", "x,y\n1,10\n2,20\n");
	const calls = [["plot", [{ $csv: path, x: "x", y: "y" }]]] as never;
	const first = renderChart({ name: "live", calls }, dir);
	writeFileSync(path, "x,y\n1,1000\n2,2000\n");
	const second = renderChart({ name: "live", calls }, dir);
	assert.notEqual(first.pngPath, second.pngPath);
});

test("readCsv refuses a file over 32MB without parsing it", () => {
	const path = join(dir, "huge.csv");
	writeFileSync(path, Buffer.alloc(MAX_DATA_BYTES + 1, 0x61));
	assert.throws(() => readCsv({ $csv: path }), new RegExp(`larger than ${MAX_DATA_BYTES} bytes`));
});
