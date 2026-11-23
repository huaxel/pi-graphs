import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { withSavedSpec } from "../index.ts";
import { assertWithinBudget, MPL_LIMITS, MPL_PALETTES, renderChart } from "../render.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-mpl-render-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const calls = [["plot", [[1, 2, 3], [3, 1, 2]], { label: "a" }], ["set_title", ["t"]]] as never;

test("an identical spec reuses its files and keeps the spec beside them", () => {
	const first = renderChart({ name: "same", calls }, dir);
	const second = renderChart({ name: "same", calls }, dir);
	assert.equal(first.pngPath, second.pngPath);
	assert.ok(first.pngPath?.endsWith(".png"));
	assert.ok(first.specPath && readFileSync(first.specPath, "utf8").includes('"set_title"'));
	assert.match(first.pngPath ?? "", /same-[0-9a-f]{10}\.png$/);
});

test("a different spec, theme, scale, or palette gets its own file", () => {
	const base = renderChart({ name: "v", calls }, dir);
	const themed = renderChart({ name: "v", calls, theme: "pro-slate" }, dir);
	const scaled = renderChart({ name: "v", calls, scale: 1 }, dir);
	const paletted = renderChart({ name: "v", calls, palette: "okabe-ito" }, dir);
	const paths = new Set([base.pngPath, themed.pngPath, scaled.pngPath, paletted.pngPath]);
	assert.equal(paths.size, 4);
});

test("palettes replace the series cycle and reject unknown names", () => {
	const out = renderChart({ name: "pal", calls, format: "svg", palette: "okabe-ito" }, dir);
	const svg = readFileSync(out.svgPath ?? "", "utf8");
	assert.ok(svg.toLowerCase().includes(MPL_PALETTES["okabe-ito"][0]!.toLowerCase()));
	assert.throws(() => renderChart({ name: "pal", calls, palette: "nope" as never }, dir), /unknown palette "nope"/);
});

test("format html writes a self-contained page with a matching background", () => {
	const dark = renderChart({ name: "page", calls, format: "html", rc: { "figure.facecolor": "none", "axes.facecolor": "none", "savefig.facecolor": "none", "text.color": "#f4f6fa" } }, dir);
	const page = readFileSync(dark.htmlPath ?? "", "utf8");
	assert.ok(page.includes("<svg"));
	assert.ok(page.includes("background: #1a1b25"), "light text on a transparent chart expects a dark page");
	const light = renderChart({ name: "page", calls, format: "html", theme: "pro-slate" }, dir);
	const lightPage = readFileSync(light.htmlPath ?? "", "utf8");
	assert.match(lightPage, /background: #f[0-9a-f]{5}/i, "a light style keeps a light page");
});

test("html pages ship the interactive client unless it is turned off", () => {
	const page = renderChart({ name: "hover", calls, format: "html" }, dir);
	const html = readFileSync(page.htmlPath ?? "", "utf8");
	assert.ok(html.includes("attach(document)"), "the client is inlined");
	assert.ok(html.includes("--mpl-dot-fill"));
	const plain = renderChart({ name: "static", calls, format: "html", interactive: false }, dir);
	const plainHtml = readFileSync(plain.htmlPath ?? "", "utf8");
	assert.ok(!plainHtml.includes("attach(document)"));
	assert.ok(plainHtml.includes("<svg"));
});

test("limits stop runaway specs before rendering", () => {
	const many = Array.from({ length: MPL_LIMITS.calls + 1 }, () => ["set_title", ["x"]]) as never;
	assert.throws(() => renderChart({ calls: many }, dir), /exceeds the 250-call limit/);
	const wide = [["plot", [Array.from({ length: 100 }, (_, i) => i), Array.from({ length: MPL_LIMITS.points + 1 }, (_, i) => i)]]] as never;
	assert.throws(() => renderChart({ calls: wide }, dir), /data points exceeds/);
});

test("withSavedSpec reloads a saved chart and applies overrides", () => {
	const saved = renderChart({ name: "saved", calls, theme: "pro-dark" }, dir);
	const restored = withSavedSpec({ from: saved.specPath!, theme: "pro-slate", name: "restyled" });
	assert.equal(restored.theme, "pro-slate");
	assert.equal(restored.name, "restyled");
	assert.deepEqual(restored.calls, JSON.parse(JSON.stringify(calls)));
	const out = renderChart(restored, dir);
	assert.match(out.pngPath ?? "", /restyled-/);
	assert.throws(() => withSavedSpec({ from: join(dir, "missing.json") }), /from: cannot read/);
});

test("withSavedSpec passes specs through untouched when from is absent", () => {
	const spec = { name: "x", calls } as never;
	assert.equal(withSavedSpec(spec), spec);
	assert.throws(() => withSavedSpec({}), /calls is required/);
});

test("point budget counts dates and error-bar arrays", () => {
	const n = MPL_LIMITS.points + 1;
	const dates = { $dates: Array.from({ length: n }, () => "2026-01-01") };
	assert.throws(() => assertWithinBudget([["plot", [dates, [1]]]]), /data points exceeds/);
	const yerr = Array.from({ length: n }, () => 1);
	assert.throws(() => assertWithinBudget([["plot", [[1, 2]], { yerr }]]), /data points exceeds/);
});

test("an unsupported format is refused instead of writing only a spec", () => {
	assert.throws(() => renderChart({ format: "jpeg" as never, calls }, dir), /unknown format "jpeg"/);
	assert.throws(() => renderChart({ format: "ansi", calls }, dir), /terminal rows/);
});
