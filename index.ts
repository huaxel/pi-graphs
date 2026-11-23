/**
 * mpl_render: a codemode tool that draws matplotlib-style charts with mpl (github.com/ivarvong/mpl)
 * from a JSON call list, writes PNG/SVG files, and returns the PNG so a script can show it with image().
 */
import type { ExtensionAPI, ToolDefinition, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { Box, Color, colorToHex, Image, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type, type TSchema } from "typebox";
import { MPL_DEFAULT_THEME, MPL_THEMES, renderChart, resolveRc, resolveThemeStyle, type MplRenderInput } from "./render.ts";
import { renderAnsiChart } from "./ansi.ts";
import { CHART_ROOT, describeChart, listCharts, pruneCharts } from "./gallery.ts";
import { expandDataRefs } from "./data.ts";
import { MPL_FIGURE_METHODS } from "./replay.ts";

const MPL_RENDER_TOOL_NAME = "mpl_render";

export const mplInstructions = `Reference for mpl_render. mpl is a pixel-exact TypeScript port of matplotlib 3.11: calls follow matplotlib's object API (ax.<method>(*args, **kwargs)), kwargs and rc keys included.

Spec: { calls, theme?, rc?, grid?, format?, scale?, name?, tight_layout? }
- calls: [method, [positional args], {kwargs}], applied in order to the current Axes. ax.plot(x, y, 'o-', label='a') is ["plot", [x, y, "o-"], { label: "a" }].
- grid: { rows, cols, sharex?, sharey?, width_ratios?, height_ratios? }. Axes are numbered row-major from 0; ["sca", [i]] makes Axes i current; ["twinx", []] adds a twin and makes it current.
- Figure calls take a "fig." prefix: ${[...MPL_FIGURE_METHODS].map((m) => `fig.${m}`).join(", ")}. fig.colorbar maps the last imshow or colour-mapped scatter on the current Axes.
- Values: {"$float": "nan"} is NaN. Kwarg {"$transform": "axes"} is ax.transAxes.
- theme: omits to use active Pi theme colors on the "${MPL_DEFAULT_THEME}" layout (falling back to "${MPL_DEFAULT_THEME}"), or pass one of ${MPL_THEMES.length} styles: ${MPL_THEMES.join(", ")}. rc overrides keys, e.g. { "figure.figsize": [9, 4] }.
- scale: PNG pixel multiplier from 0.25 to 4, default 2 (1440x840 at the default size); 3 for print.
- format: "png" (default), "svg", "both", "html" (self-contained page with the chart inline, hover tooltips included), or "ansi" (a terminal chart: braille marks, real labels, no file; use it when the terminal cannot show images or the chart is pasted into text). "ansi" respects cols (default 78). Files land in ~/.pi/agent/work/charts/<date>/ and are named <slug>-<spec hash>, so an identical spec reuses its files. tight_layout runs unless the calls lay out the figure.
- interactive: html only, default true; inlines the mpl/interactive client so the page has a crosshair, nearest-point tooltips and legend toggles. false writes a static page.
- palette: "theme" (default) uses the theme's series colours; "okabe-ito" or "tableau" swaps in a colour-blind-safe cycle. rc["axes.prop_cycle"] still wins.
- from: path to a saved <stem>.json written next to every chart; re-renders that spec with any params you pass on top (theme, scale, format, name, rc, palette). Use it to restyle a chart for a document instead of rewriting the calls. Data references are re-read, so the chart picks up the current file contents.

Dates:
- {"$dates": ["2026-01-01", ...]} is Date[], {"$date": "..."} one Date; naive ISO strings are UTC. plot, bar, text, axvline and fill_between take them.
- Ticks: ["$concise_x", []] for ConciseDateFormatter, or ["$date_x", ["MonthLocator", { interval: 1 }, "%b %d" | "concise"]].
- annotate takes epoch days (ms / 86400000) as coordinates.

Data files (prefer these over pasting long arrays):
- {"$csv": "path", "x": "date", "y": "revenue"} expands to positional [x, y]. y is one column name or index. One series per call. A second series is a second plot call with its own y. y as a list of columns is rejected.
- {"$csv": "path", "column": "revenue"} is that column alone, for hist or a kwarg such as { yerr: {"$csv": ..., "column": "err"} }.
- Without x or y, a one-column file is that column, and a wider file is column 0 against column 1. Further columns are not plotted; name them with x and y.
- {"header": false} reads headerless files; {"parse": "number" | "date" | "string"} forces a column type; the default infers per column (numbers, ISO dates, else strings), and empty cells become NaN gaps.
- {"$json": "path"} is any JSON value from that file. Delimiters , ; tab and | are detected; quoted fields may contain them.
- Relative paths resolve against the working directory, ~ expands to home, and files over 32 MB are refused.

Colours (Macchiato): red #ed8796, peach #f5a97f, yellow #eed49f, green #a6da95, teal #8bd5ca, blue #8aadf4, mauve #c6a0f6, pink #f5bde6, muted text #a5adcb. Cycle C0..C7 = blue, mauve, green, peach, red, teal, yellow, pink.

Chart types: line, step, scatter, bar/barh (bottom/left for stacks), hist, boxplot, errorbar (errors go in kwargs: { yerr } / { xerr }), fill_between, imshow + fig.colorbar, axhline/axvline/axhspan/axvspan, text, annotate. For shares use barh; for distributions use hist or boxplot; for legend placement use loc and ncols.

Gotchas:
- Unknown kwargs and rc keys throw, as in matplotlib; the error names the call index and the offending key.
- Scatter legend: label a proxy ["plot", [[], [], "o"], { color: "C0", label: "name" }] rather than the scatter.
- Text: Latin, Greek, arrows and math symbols; use ASCII for tree labels and ~ for approximations.
- Keep each series under ~100k points.

Done when: the image you showed has no overlapping or clipped labels, no legend covering data, and readable ticks; otherwise adjust (figsize, ticks, legend loc, ylim headroom) and re-render.`;

export const mplToolNamespace: ToolNamespace = { name: "mpl", instructions: mplInstructions };

export const mplRenderParameters = Type.Object({
	calls: Type.Array(Type.Array(Type.Unknown(), { minItems: 1, maxItems: 3 }), {
		description: '[method, [positional args], {kwargs}], e.g. ["bar", [names, values], { color: "C1" }]',
	}),
	theme: Type.Optional(Type.String({ description: `default ${MPL_DEFAULT_THEME}` })),
	rc: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	grid: Type.Optional(
		Type.Object({
			rows: Type.Integer(),
			cols: Type.Integer(),
			sharex: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
			sharey: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
			width_ratios: Type.Optional(Type.Array(Type.Number())),
			height_ratios: Type.Optional(Type.Array(Type.Number())),
		}),
	),
	format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("svg"), Type.Literal("both"), Type.Literal("html"), Type.Literal("ansi")])),
	scale: Type.Optional(Type.Number()),
	name: Type.Optional(Type.String()),
	tight_layout: Type.Optional(Type.Boolean()),
	palette: Type.Optional(Type.Union([Type.Literal("theme"), Type.Literal("okabe-ito"), Type.Literal("tableau")])),
	interactive: Type.Optional(Type.Boolean()),
	cols: Type.Optional(Type.Number({ description: "ansi only: terminal columns, default 78" })),
	from: Type.Optional(Type.String()),
});

export const mplRenderOutput = Type.Object({
	image: Type.Optional(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })),
	pngPath: Type.Optional(Type.String()),
	svgPath: Type.Optional(Type.String()),
	htmlPath: Type.Optional(Type.String()),
	specPath: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

function piThemeRc(colors: Readonly<Record<string, Color>> | undefined): Record<string, unknown> {
	if (!colors) return {};
	const hex = (key: string): string | undefined => {
		const color = colors[key];
		return color ? colorToHex(color) : undefined;
	};
	const text = hex("text");
	const muted = hex("muted");
	const borderMuted = hex("borderMuted");
	const cycle = [
		"accent",
		"success",
		"warning",
		"error",
		"mdLink",
		"syntaxFunction",
		"syntaxNumber",
		"syntaxKeyword",
	]
		.map(hex)
		.filter((c): c is string => c !== undefined);

	return {
		// No painted surface: the PNG stays transparent, so the chart sits on the terminal's own
		// background, which Pi does not expose as a theme token. Callers can pass rc to opt out.
		"figure.facecolor": "none",
		"axes.facecolor": "none",
		"savefig.facecolor": "none",
		...(text && {
			"text.color": text,
			"axes.titlecolor": text,
			"legend.labelcolor": text,
		}),
		...(muted && {
			"axes.labelcolor": muted,
			"xtick.labelcolor": muted,
			"ytick.labelcolor": muted,
		}),
		...(borderMuted && {
			"axes.edgecolor": borderMuted,
			// Grid rules recede behind the marks: the theme's border token at ~55% alpha.
			"grid.color": `${borderMuted}8c`,
			"xtick.color": borderMuted,
			"ytick.color": borderMuted,
		}),
		...(cycle.length > 0 && { "axes.prop_cycle": cycle }),
	};
}

/** `from` reloads a saved spec and applies the given params on top of it. */
export type MplRenderParams = Partial<MplRenderInput> & { from?: string };

export function withSavedSpec(params: MplRenderParams): MplRenderInput {
	const { from, ...overrides } = params;
	if (!from) {
		if (!params.calls) throw new Error("calls is required unless from points at a saved spec");
		return params as MplRenderInput;
	}
	const path = from === "~" || from.startsWith("~/") ? join(homedir(), from.slice(2)) : resolve(from);
	let saved: Record<string, unknown>;
	try {
		saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`from: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const { renderedAt: _renderedAt, from: _from, ...spec } = saved;
	const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
	const merged = { ...spec, ...defined } as unknown as MplRenderInput;
	if (!Array.isArray(merged.calls)) throw new Error(`from: ${path} has no calls`);
	return merged;
}

export function toMplRenderToolDefinition(outDir?: () => string): ToolDefinition<TSchema, undefined> {
	return {
		name: MPL_RENDER_TOOL_NAME,
		label: "mpl render",
		description:
			'Chart data as PNG/SVG through the matplotlib API. Read describeNamespace("mpl") before the first chart; show the result with image(r.image).',
		parameters: mplRenderParameters as unknown as TSchema,
		outputSchema: mplRenderOutput as unknown as TSchema,
		exposure: "codemode",
		namespace: mplToolNamespace,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const input = withSavedSpec(params as MplRenderParams);
				const injected = piThemeRc(ctx?.ui?.theme?.colors);
				if (input.format === "ansi") {
					const spec = expandDataRefs(input);
					const chart = renderAnsiChart({ calls: spec.calls, rc: resolveRc(input, injected), grid: spec.grid, style: resolveThemeStyle(input.theme ?? MPL_DEFAULT_THEME) as string, cols: input.cols });
					return {
						content: [{ type: "text" as const, text: chart.lines.join("\n") }],
						structuredContent: { text: chart.plain.join("\n"), cols: chart.cols, rows: chart.rows } as never,
						details: undefined,
					};
				}
				const out = renderChart(input, outDir?.(), {}, injected);
				const image = out.png
					? { type: "image" as const, data: Buffer.from(out.png).toString("base64"), mimeType: "image/png" as const }
					: undefined;
				const structured = {
					...(image && { image }),
					...(out.pngPath && { pngPath: out.pngPath }),
					...(out.svgPath && { svgPath: out.svgPath }),
					...(out.htmlPath && { htmlPath: out.htmlPath }),
					...(out.specPath && { specPath: out.specPath }),
				};
				const paths = [out.pngPath, out.svgPath, out.htmlPath].filter(Boolean).join("\n");
				return {
					content: [...(image ? [image] : []), { type: "text" as const, text: paths }],
					structuredContent: structured as never,
					details: undefined,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `mpl_render failed: ${message}` }],
					structuredContent: { error: message } as never,
					details: undefined,
					isError: true,
				};
			}
		},
	};
}

/** `/charts` shows the rendered charts of the last week; `/charts prune [days]` deletes old day folders. */
export function registerChartsCommand(pi: ExtensionAPI, root = CHART_ROOT): void {
	pi.registerEntryRenderer("mpl-chart", (entry, _options, theme) => {
		const data = entry.data as { pngPath?: string; svgPath?: string; htmlPath?: string; specPath?: string; label?: string };
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", data.label ?? "chart")));
		if (data.pngPath && existsSync(data.pngPath)) {
			box.addChild(new Image(readFileSync(data.pngPath).toString("base64"), "image/png", { fallbackColor: (text: string) => theme.fg("dim", text) }, { filename: data.pngPath }));
		}
		const paths = [data.pngPath, data.svgPath, data.htmlPath, data.specPath].filter(Boolean).join("\n");
		if (paths) box.addChild(new Text(theme.fg("dim", paths)));
		return box;
	});

	pi.registerCommand("charts", {
		description: "Show or prune rendered charts",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "prune") {
				const days = Number(rest[0] ?? 14);
				if (!Number.isFinite(days) || days < 1) {
					ctx.ui.notify("usage: /charts prune [days]", "error");
					return;
				}
				const preview = listCharts(root, { days: 3650 });
				const old = preview.filter((e) => e.day < new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
				if (old.length === 0) {
					ctx.ui.notify(`No chart folders older than ${days} days`, "info");
					return;
				}
				const ok = await ctx.ui.confirm("Prune charts?", `Delete ${old.length} chart folder(s) older than ${days} days?`);
				if (!ok) return;
				const result = pruneCharts(root, { days });
				ctx.ui.notify(`Removed ${result.files} file(s) from ${result.days.length} folder(s)`, "info");
				return;
			}
			const entries = listCharts(root, { days: Number(sub) > 0 ? Number(sub) : 7, limit: 40 });
			if (entries.length === 0) {
				ctx.ui.notify("No charts yet. Ask the agent for one.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(entries.map(describeChart).join("\n"), "info");
				return;
			}
			const labels = entries.map(describeChart);
			const choice = await ctx.ui.select("Charts:", labels);
			if (!choice) return;
			const picked = entries[labels.indexOf(choice)];
			if (!picked) return;
			pi.appendEntry("mpl-chart", {
				label: picked.stem,
				pngPath: picked.png,
				svgPath: picked.svg,
				htmlPath: picked.html,
				specPath: picked.spec,
			});
		},
	});
}

export default function mplExtension(pi: ExtensionAPI): void {
	pi.registerTool(toMplRenderToolDefinition());
	registerChartsCommand(pi);
}
