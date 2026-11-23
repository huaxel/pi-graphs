import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { inflateSync } from "node:zlib";
import { parseColor } from "@earendil-works/pi-tui";
import { toMplRenderToolDefinition } from "../index.ts";
import { MPL_PALETTES, MPL_THEMES, renderChart } from "../render.ts";
import { decodeValue, MPL_AXES_METHODS } from "../replay.ts";

const outDir = mkdtempSync(join(tmpdir(), "pi-mpl-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Alpha of the top-left pixel: 0 means the PNG leaves that area to the terminal. */
function cornerAlpha(path: string): number {
	const buf = readFileSync(path);
	const width = buf.readUInt32BE(16);
	const bpp = buf[25] === 6 ? 4 : 3;
	let off = 8;
	const idat: Buffer[] = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		if (buf.toString("ascii", off + 4, off + 8) === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
		off += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const filter = raw[0];
	const px: number[] = [];
	for (let i = 0; i < stride; i++) {
		const a = i >= bpp ? px[i - bpp]! : 0;
		const x = raw[1 + i]!;
		// No prior row, so Up and Paeth reduce to None and Sub.
		px.push(filter === 1 || filter === 3 || filter === 4 ? (x + a) & 255 : x);
	}
	return bpp === 4 ? px[3]! : 255;
}

test("the themes include macchiato, pro-slate and pro-dark", () => {
	for (const t of ["catppuccin-macchiato", "pro-slate", "pro-dark"]) assert.ok(MPL_THEMES.includes(t), t);
});

test("Axes allow-list has drawing methods and no private names", () => {
	for (const m of ["plot", "bar", "scatter", "hist", "set_title", "legend", "imshow"]) assert.ok(MPL_AXES_METHODS.has(m), m);
	assert.ok(![...MPL_AXES_METHODS].some((m) => m.startsWith("_") || m === "constructor"));
});

test("decodeValue turns $dates, $date and $float into values, including nested objects", () => {
	const [d] = decodeValue({ $dates: ["2026-01-02"] }) as Date[];
	assert.equal(d?.toISOString(), "2026-01-02T00:00:00.000Z");
	assert.equal((decodeValue({ $date: "2026-01-02T03:04:05+01:00" }) as Date).toISOString(), "2026-01-02T02:04:05.000Z");
	assert.ok(Number.isNaN(decodeValue({ $float: "nan" })));
	const nested = decodeValue({ a: { x: { $float: "inf" } } }) as { a: { x: number } };
	assert.equal(nested.a.x, Infinity);
	assert.throws(() => decodeValue({ $date: Number.NaN }), /invalid date/);
});

for (const theme of ["catppuccin-macchiato", "pro-slate", "pro-dark"]) {
	test(`renders a grid with dates in ${theme}`, () => {
		const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
		const out = renderChart(
			{
				theme,
				name: theme,
				format: "both",
				grid: { rows: 1, cols: 2, width_ratios: [2, 1] },
				calls: [
					["plot", [{ $dates: days }, [1, 3, 2]], { label: "a" }],
					["$concise_x", []],
					["legend", []],
					["sca", [1]],
					["bar", [["x", "y"], [2, 1]]],
					["fig.suptitle", ["t"]],
				],
			},
			outDir,
		);
		assert.deepEqual([...(out.png ?? []).slice(0, 4)], PNG_MAGIC);
		assert.equal(out.width, 1440);
		assert.equal(out.height, 840);
		assert.ok(out.pngPath && existsSync(out.pngPath));
		assert.ok(out.svgPath && readFileSync(out.svgPath, "utf8").includes("<svg"));
	});
}

test("unknown methods and kwargs are reported with the call index", () => {
	assert.throws(() => renderChart({ calls: [["plot", [[1], [1]]], ["pie", [[1]]]] }, outDir), /calls\[1\] pie: unknown call/);
	assert.throws(() => renderChart({ calls: [["plot", [[1], [1]], { colour: "red" }]] }, outDir), /calls\[0\] plot: .*colour/);
	assert.throws(() => renderChart({ theme: "nope", calls: [] }, outDir), /unknown theme/);
	assert.throws(() => renderChart({ scale: 10, calls: [] }, outDir), /scale must be between/);
	const unwrapped = ["bar", ["a", "b"], [3, 7]] as never;
	assert.throws(() => renderChart({ calls: [unwrapped] }, outDir), /wrap all positional args in one array/);
	assert.throws(() => renderChart({ calls: [["$date_x", ["constructor"]]] }, outDir), /unknown locator constructor/);
});

test("the tool returns the PNG as an image block in structuredContent", async () => {
	const tool = toMplRenderToolDefinition(() => outDir);
	const result = await tool.execute("id", { calls: [["plot", [[1, 2, 3], [3, 1, 2]]]] } as never, undefined, undefined, undefined as never);
	const sc = result.structuredContent as { image?: { type: string; data: string }; pngPath?: string };
	assert.equal(sc.image?.type, "image");
	assert.deepEqual([...Buffer.from(sc.image?.data ?? "", "base64").subarray(0, 4)], PNG_MAGIC);
	assert.ok(sc.pngPath?.startsWith(outDir));

	const failed = await tool.execute("id", { calls: [["nope", []]] } as never, undefined, undefined, undefined as never);
	assert.equal(failed.isError, true);
	assert.match((failed.structuredContent as { error: string }).error, /unknown call/);
});

test("the tool applies Pi UI Theme Color objects and honors explicit theme overrides", async () => {	const tool = toMplRenderToolDefinition(() => outDir);
	const mockCtx = {
		ui: {
			theme: {
				colors: {
					toolPendingBg: parseColor("#11131a"),
					text: parseColor("#e6edf3"),
					muted: parseColor("#8b949e"),
					borderMuted: parseColor("#30363d"),
					accent: parseColor("#58a6ff"),
					success: parseColor("#3fb950"),
					warning: parseColor("#d29922"),
					error: parseColor("#f85149"),
					mdLink: parseColor("#a371f7"),
					syntaxFunction: parseColor("#79c0ff"),
					syntaxNumber: parseColor("#ffa657"),
					syntaxKeyword: parseColor("#ff7b72"),
				},
			},
		},
	};

	const themed = await tool.execute(
		"id",
		{ name: "pi-themed", format: "both", calls: [["plot", [[1, 2, 3], [3, 1, 2]], { label: "s" }], ["legend", []]] } as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(themed.isError, true);
	const themedSc = themed.structuredContent as { svgPath?: string; pngPath?: string };
	const themedSvg = themedSc.svgPath ? readFileSync(themedSc.svgPath, "utf8") : "";
	// Theme text and series colors come through, and no surface is painted over the terminal background.
	assert.ok(themedSvg.includes("#e6edf3"));
	assert.ok(themedSvg.includes("#58a6ff"));
	assert.ok(!themedSvg.includes("#11131a"));
	// Grid rules carry the theme border colour at reduced alpha so they sit behind the marks.
	assert.match(themedSvg, /stroke="#30363d"[^>]*stroke-opacity="0\.5[0-9]*"/);
	assert.equal(cornerAlpha(themedSc.pngPath ?? ""), 0);

	const explicit = await tool.execute(
		"id",
		{
			name: "explicit-light",
			theme: "pro-slate",
			format: "svg",
			calls: [["plot", [[1, 2], [2, 1]]]],
		} as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(explicit.isError, true);
	const explicitSc = explicit.structuredContent as { svgPath?: string };
	assert.ok(explicitSc.svgPath && !readFileSync(explicitSc.svgPath, "utf8").includes("#11131a"));
	assert.ok(explicitSc.svgPath && /facecolor|fill="#f/i.test(readFileSync(explicitSc.svgPath, "utf8")));
});

test("palette and caller rc beat the Pi theme, and the saved spec stays the caller's", async () => {
	const tool = toMplRenderToolDefinition(() => outDir);
	const mockCtx = {
		ui: {
			theme: {
				colors: {
					text: parseColor("#e6edf3"),
					muted: parseColor("#8b949e"),
					borderMuted: parseColor("#30363d"),
					accent: parseColor("#58a6ff"),
					success: parseColor("#3fb950"),
					warning: parseColor("#d29922"),
					error: parseColor("#f85149"),
					mdLink: parseColor("#a371f7"),
					syntaxFunction: parseColor("#79c0ff"),
					syntaxNumber: parseColor("#ffa657"),
					syntaxKeyword: parseColor("#ff7b72"),
				},
			},
		},
	};
	const calls = [["plot", [[1, 2, 3], [3, 1, 2]], { label: "s" }], ["set_title", ["T"]]];

	const pal = await tool.execute(
		"id",
		{ name: "pal-rc", format: "svg", palette: "okabe-ito", calls } as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(pal.isError, true);
	const palSc = pal.structuredContent as { svgPath?: string; specPath?: string };
	const palSvg = readFileSync(palSc.svgPath ?? "", "utf8");
	assert.ok(palSvg.toLowerCase().includes(MPL_PALETTES["okabe-ito"][0]!.toLowerCase()));
	assert.ok(!palSvg.toLowerCase().includes("#58a6ff"));
	const spec = JSON.parse(readFileSync(palSc.specPath ?? "", "utf8")) as { rc?: unknown };
	assert.equal(spec.rc, undefined);

	const custom = await tool.execute(
		"id",
		{
			name: "custom-rc",
			format: "svg",
			palette: "okabe-ito",
			rc: { "axes.prop_cycle": ["#ff00aa"] },
			calls,
		} as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(custom.isError, true);
	const customSc = custom.structuredContent as { svgPath?: string; specPath?: string };
	assert.ok(readFileSync(customSc.svgPath ?? "", "utf8").toLowerCase().includes("#ff00aa"));
	const saved = JSON.parse(readFileSync(customSc.specPath ?? "", "utf8")) as {
		rc?: { "axes.prop_cycle"?: string[]; "figure.facecolor"?: unknown };
	};
	assert.equal(saved.rc?.["axes.prop_cycle"]?.[0], "#ff00aa");
	assert.equal(saved.rc?.["figure.facecolor"], undefined);

	const again = await tool.execute(
		"id",
		{ from: palSc.specPath, theme: "pro-slate", name: "restyle-rc", format: "svg" } as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(again.isError, true);
	const againSc = again.structuredContent as { svgPath?: string };
	assert.ok(!readFileSync(againSc.svgPath ?? "", "utf8").toLowerCase().includes("#58a6ff"));

	const ansi = await tool.execute(
		"id",
		{ format: "ansi", cols: 60, rc: { "axes.titlecolor": "#ff00aa" }, calls } as never,
		undefined,
		undefined,
		mockCtx as never,
	);
	assert.notEqual(ansi.isError, true);
	assert.ok((ansi.content[0] as { text: string }).text.includes("255;0;170"));
});

test("rapid renders with the same name do not overwrite each other", () => {
	const a = renderChart({ name: ".dup", calls: [["plot", [[1, 2], [1, 2]]]] }, outDir);
	const b = renderChart({ name: ".dup", calls: [["plot", [[1, 2], [2, 1]]]] }, outDir);
	assert.notEqual(a.pngPath, b.pngPath);
	assert.ok(a.pngPath && !a.pngPath.split("/").pop()?.startsWith("."));
});
