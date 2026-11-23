import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAnsiChart } from "../ansi.ts";

const rc = {
	"text.color": "#f4f6fa",
	"axes.labelcolor": "#d0d7e2",
	"xtick.labelcolor": "#d0d7e2",
	"ytick.labelcolor": "#d0d7e2",
	"axes.edgecolor": "#748197",
	"grid.color": "#7481978c",
	"xtick.color": "#748197",
	"ytick.color": "#748197",
	"axes.prop_cycle": ["#d6a6ff", "#9fe3b1"],
};

const lines = (calls: unknown, cols = 70) => renderAnsiChart({ rc, cols, calls: calls as never });

test("a line chart renders braille marks with a framed plot area and real labels", () => {
	const chart = lines([
		["plot", [[1, 2, 3, 4], [10, 30, 20, 40]], { label: "v" }],
		["set_title", ["Trend"]],
	]);
	const text = chart.plain.join("\n");
	assert.match(text, /Trend/);
	assert.match(text, /[⠀-⣿]/, "braille marks");
	assert.match(text, /│/, "left spine");
	assert.match(text, /─/, "bottom spine");
	assert.equal(chart.rows, chart.plain.length);
	for (const line of chart.plain) assert.equal([...line].length, chart.cols, "every row is the full width");
});

test("a line chart paints braille in the series colour", () => {
	const chart = lines([["plot", [[1, 2, 3, 4], [10, 30, 20, 40]]]]);
	const hit = chart.lines
		.join("\n")
		.split(/\x1b\[0m/)
		.some((part) => /38;2;214;166;255m/.test(part) && /[⠀-⣿]/.test(part));
	assert.ok(hit, "series colour on a braille glyph");
});

test("scatter markers keep the series colour", () => {
	const colored = lines([["scatter", [[1, 2, 3, 4], [10, 30, 20, 40]]]]).lines.join("\n");
	assert.match(colored, /38;2;214;166;255/, "scatter uses the cycle colour");
});

test("bars fill with a background colour and still read as blocks without colour", () => {
	const chart = lines([["bar", [["auth", "api", "worker"], [14, 38, 27]]], ["set_title", ["Share"]]]);
	const colored = chart.lines.join("\n");
	assert.match(colored, /\x1b\[48;2;\d+;\d+;\d+m/, "bar fill uses a background escape");
	assert.match(chart.plain.join("\n"), /█/, "blocks appear when colour is off");
});

test("labels that would overlap the plot are pushed back outside it", () => {
	const vertical = lines([["barh", [["auth", "api"], [14, 38]]]]);
	const rows = vertical.plain.filter((row) => row.includes("worker") || row.includes("api") || row.includes("auth"));
	assert.ok(rows.length > 0);
	for (const row of rows) {
		const label = /(auth|api)/.exec(row)?.[0] ?? "";
		assert.ok(row.includes(label));
	}
});

test("the same budget as the PNG path applies before any drawing", () => {
	assert.throws(
		() => renderAnsiChart({ calls: [["plot", [Array.from({ length: 500 }, (_, i) => i), Array.from({ length: 400_001 }, (_, i) => i)]]] as never, cols: 60 }),
		/data points exceeds/,
	);
});

test("colour can be turned off and width is honoured", () => {
	const plain = renderAnsiChart({ rc, cols: 50, color: false, calls: [["plot", [[1, 2, 3], [3, 1, 2]]]] as never });
	assert.ok(!plain.lines.join("").includes("\x1b["));
	assert.equal(plain.cols, 50);
});

test("the x axis label gets a row below the tick labels", () => {
	const chart = lines([["plot", [[1, 2, 3], [3, 1, 2]]], ["set_xlabel", ["quarter"]]]);
	const label = chart.plain.findIndex((row) => row.includes("quarter"));
	assert.ok(label > 0, "the label is drawn");
	assert.doesNotMatch(chart.plain[label] as string, /\d/, "no tick label shares its row");
	const tickRow = chart.plain.reduce((found, row, index) => (row.includes("1.00") && row.includes("3.00") ? index : found), -1);
	assert.ok(tickRow >= 0 && tickRow < label, "ticks sit above the label");
});

test("a rotated y label reads bottom to top, one column, clear of the ticks", () => {
	const chart = lines([["plot", [[1, 2, 3], [3, 1, 2]]], ["set_ylabel", ["revenue"]]]);
	const rows = chart.plain.map((row) => [...row]);
	const columnOf = (text: string): number | undefined => {
		for (let col = 0; col < chart.cols; col++) {
			const column = rows.map((cells) => cells[col] ?? " ").reverse().join("");
			if (column.includes(text)) return col;
		}
		return undefined;
	};
	const col = columnOf("revenue");
	assert.notEqual(col, undefined, "the label is drawn bottom to top");
	const letterRows = rows.map((cells, row) => ({ row, cell: cells[col as number] })).filter(({ cell }) => cell?.trim());
	assert.equal(letterRows.length, "revenue".length, "one row per letter");
	for (const { row } of letterRows) {
		const next = rows[row]?.[(col as number) + 1];
		assert.ok(next === " " || col === 0, "a blank column separates the label from the ticks");
	}
});

test("grid panels stay transparent instead of painting the Axes facecolour", () => {
	const chart = renderAnsiChart({
		rc,
		cols: 70,
		grid: { rows: 1, cols: 2 },
		calls: [["plot", [[1, 2, 3], [3, 1, 2]]]] as never,
	});
	assert.ok(!chart.plain.join("").includes("█"), "no background fill across the panels");
	assert.match(chart.plain.join("\n"), /[⠀-⣿]/, "the series still draws");
});
