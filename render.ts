/** Renders an mpl chart spec to PNG/SVG files. No pi imports, so tests drive it directly. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { availableStyles, registerColormapRgba, registerColormaps, registerFonts, registerSidecar } from "mpl";
import { sidecar } from "mpl/annotate";
import { allColormaps } from "mpl/colormaps/all";
import { allColormapRgba } from "mpl/colormaps/all.rgba";
import { allFonts } from "mpl/fonts/all";
import { buildFigure, type MplCall, type MplGrid } from "./replay.ts";
import { expandDataRefs, type DataRefOptions } from "./data.ts";

registerFonts(...allFonts);
// Enables fig.toSVG({ interactive: true }): each Axes carries a JSON sidecar of its artists.
registerSidecar(sidecar);
registerColormaps(...allColormaps);
registerColormapRgba(...allColormapRgba);

/** Themes this extension ships as .mplstyle files under styles/. */
const LOCAL_THEMES = ["catppuccin-macchiato"] as const;
export const MPL_DEFAULT_THEME = "catppuccin-macchiato";
/** Hi-dpi by default: 2x pixels, 1440x840 at the themes' 7.2x4.2 in figure size. */
export const MPL_DEFAULT_SCALE = 2;
/** Every accepted theme name: local ones first, then mpl's bundled styles (pro-slate, pro-dark, ggplot, ...). */
export const MPL_THEMES: readonly string[] = [...LOCAL_THEMES, ...availableStyles().filter((s) => s !== "default"), "default"];

const styleText = new Map<string, string>();
export function resolveThemeStyle(theme: string): unknown {
	if ((LOCAL_THEMES as readonly string[]).includes(theme)) {
		let text = styleText.get(theme);
		if (text === undefined) {
			text = readFileSync(new URL(`./styles/${theme}.mplstyle`, import.meta.url), "utf8");
			styleText.set(theme, text);
		}
		return text;
	}
	if (theme === "default") return [];
	if (!MPL_THEMES.includes(theme)) throw new Error(`unknown theme "${theme}"; use one of ${MPL_THEMES.join(", ")}`);
	return theme;
}

export interface MplRenderInput {
	readonly theme?: string;
	readonly rc?: Readonly<Record<string, unknown>>;
	readonly grid?: MplGrid;
	readonly calls: readonly MplCall[];
	readonly format?: "png" | "svg" | "both" | "html" | "ansi";
	/** PNG pixel multiplier (hi-dpi). Default MPL_DEFAULT_SCALE. */
	readonly scale?: number;
	/** File stem, such as "latency-by-region". */
	readonly name?: string;
	/** Run fig.tight_layout() after the calls. Default true unless the calls already lay out the figure. */
	readonly tight_layout?: boolean;
	/** Categorical palette for the series cycle; explicit rc["axes.prop_cycle"] wins. */
	readonly palette?: MplPalette;
	/** HTML only: inline the mpl/interactive client for hover readouts. Default true. */
	readonly interactive?: boolean;
	/** ANSI only: terminal columns, default 78. */
	readonly cols?: number;
}

export type MplPalette = "theme" | "okabe-ito" | "tableau";

/** Colour-blind-safe categorical cycles. Okabe-Ito swaps black for grey so it reads on dark surfaces. */
export const MPL_PALETTES: Readonly<Record<Exclude<MplPalette, "theme">, readonly string[]>> = {
	"okabe-ito": ["#56B4E9", "#E69F00", "#009E73", "#F0E442", "#CC79A7", "#0072B2", "#D55E00", "#999999"],
	tableau: ["#4E79A7", "#F28E2B", "#59A14F", "#E15759", "#76B7B2", "#EDC948", "#B07AA1", "#FF9DA7"],
};

/** Ceilings that keep one call from blocking the session. */
export const MPL_LIMITS = { calls: 250, points: 400_000 } as const;

export interface MplRenderOutput {
	readonly png?: Uint8Array;
	readonly pngPath?: string;
	readonly svgPath?: string;
	readonly htmlPath?: string;
	/** The spec that produced these files, for re-rendering later. */
	readonly specPath?: string;
	readonly width?: number;
	readonly height?: number;
	readonly theme: string;
}

/** Default output directory: ~/.pi/agent/work/charts/<YYYY-MM-DD>. */
export function defaultChartDir(now = new Date()): string {
	return join(homedir(), ".pi", "agent", "work", "charts", now.toISOString().slice(0, 10));
}

function slugOf(name: string | undefined): string {
	return (name ?? "chart").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 60) || "chart";
}

/** Stable digest of everything that changes pixels, so identical specs reuse one file. */
function specDigest(spec: MplRenderInput, theme: string, scale: number, format: string): string {
	const canonical = JSON.stringify({ calls: spec.calls, theme, scale, format, rc: spec.rc ?? {}, grid: spec.grid ?? null, tight: spec.tight_layout ?? null, palette: spec.palette ?? null, interactive: spec.interactive ?? null });
	return createHash("sha256").update(canonical).digest("hex").slice(0, 10);
}

function countPoints(calls: readonly unknown[]): number {
	let total = 0;
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			total += value.length;
			for (const item of value) if (Array.isArray(item)) walk(item);
		} else if (value instanceof Float64Array || value instanceof Uint32Array) total += value.length;
	};
	for (const call of calls) if (Array.isArray(call)) walk(call[1]);
	return total;
}

function assertWithinBudget(calls: readonly unknown[]): void {
	if (calls.length > MPL_LIMITS.calls) throw new Error(`${calls.length} calls exceeds the ${MPL_LIMITS.calls}-call limit`);
	const points = countPoints(calls);
	if (points > MPL_LIMITS.points) throw new Error(`${points} data points exceeds the ${MPL_LIMITS.points}-point limit`);
}

/** PNG width and height from the IHDR chunk. */
function pngSize(png: Uint8Array): { width: number; height: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The mpl/interactive browser client, inlined so the page stays self-contained. */
let clientSource: string | undefined;
export function interactiveClient(): string | undefined {
	if (clientSource !== undefined) return clientSource || undefined;
	try {
		const url = import.meta.resolve("mpl/interactive");
		const source = readFileSync(fileURLToPath(url), "utf8").replace(/^export /gm, "");
		clientSource = `${source}\nattach(document);\n`;
	} catch {
		clientSource = "";
	}
	return clientSource || undefined;
}

/**
 * Page background for an HTML chart: the SVG's own figure rectangle when it paints one, otherwise a
 * dark or light surface chosen from the rc text colour (light text means the chart expects a dark page).
 */
export function pageBackground(svg: string, rc: Readonly<Record<string, unknown>> = {}): string {
	const painted = /^<svg[^>]*>\s*<rect[^>]*fill="(#[0-9a-fA-F]{3,8})"/.exec(svg.trim());
	if (painted?.[1] && !/00$/.test(painted[1])) return painted[1];
	const text = typeof rc["text.color"] === "string" ? rc["text.color"] : undefined;
	const hex = text && /^#[0-9a-fA-F]{6}$/.test(text) ? text.slice(1) : undefined;
	if (!hex) return "#ffffff";
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "#1a1b25" : "#ffffff";
}

/** Self-contained page around a chart SVG: shareable, opens in any browser, no network. */
export function htmlPage(svg: string, title: string, background: string, script?: string): string {
	const safeTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
	return `<!doctype html>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
	:root { color-scheme: dark light; --mpl-dot-fill: ${background}; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${background}; }
	figure { margin: 0; padding: 24px; }
	svg { max-width: min(96vw, 1200px); height: auto; display: block; }
</style>
<figure>
${svg}
</figure>
${script ? `<script type="module">\n${script}</script>` : ""}
`;
}

export function renderChart(input: MplRenderInput, outDir = defaultChartDir(), dataOptions: DataRefOptions = {}): MplRenderOutput {
	const spec = expandDataRefs(input, dataOptions);
	assertWithinBudget(spec.calls);
	const theme = spec.theme ?? MPL_DEFAULT_THEME;
	const scale = spec.scale ?? MPL_DEFAULT_SCALE;
	if (!(scale >= 0.25 && scale <= 4)) throw new Error(`scale must be between 0.25 and 4, got ${scale}`);
	const format = spec.format ?? "png";
	const paletteCycle = spec.palette && spec.palette !== "theme" ? MPL_PALETTES[spec.palette] : undefined;
	if (spec.palette && spec.palette !== "theme" && !paletteCycle) {
		throw new Error(`unknown palette "${spec.palette}"; use ${["theme", ...Object.keys(MPL_PALETTES)].join(", ")}`);
	}
	// Explicit rc wins over the palette cycle, which wins over the theme's own cycle.
	const rc = paletteCycle ? { "axes.prop_cycle": paletteCycle, ...spec.rc } : spec.rc;

	const stem = `${slugOf(spec.name)}-${specDigest(spec, theme, scale, format)}`;
	mkdirSync(outDir, { recursive: true });
	const wantsPng = format === "png" || format === "both";
	const wantsSvg = format === "svg" || format === "both";
	const pngPath = wantsPng ? join(outDir, `${stem}.png`) : undefined;
	const svgPath = wantsSvg ? join(outDir, `${stem}.svg`) : undefined;
	const htmlPath = format === "html" ? join(outDir, `${stem}.html`) : undefined;
	const specPath = join(outDir, `${stem}.json`);

	// Same spec, same pixels: reuse the files already on disk instead of rendering again.
	const present = (path: string | undefined) => path !== undefined && existsSync(path);
	if (present(pngPath) && (svgPath === undefined || present(svgPath)) && (htmlPath === undefined || present(htmlPath))) {
		const png = new Uint8Array(readFileSync(pngPath as string));
		return {
			png,
			pngPath,
			...(present(svgPath) && { svgPath }),
			...(present(htmlPath) && { htmlPath }),
			specPath: existsSync(specPath) ? specPath : undefined,
			theme,
			...pngSize(png),
		};
	}
	if (present(htmlPath) && pngPath === undefined && svgPath === undefined) {
		return { htmlPath, specPath: existsSync(specPath) ? specPath : undefined, theme };
	}
	if (present(svgPath) && svgPath) {
		const svg = readFileSync(svgPath, "utf8");
		const page = htmlPath ? readFileSync(htmlPath as string, "utf8") : undefined;
		return { svgPath, ...(page ? { htmlPath } : {}), specPath: existsSync(specPath) ? specPath : undefined, theme };
	}

	const fig = buildFigure({ style: resolveThemeStyle(theme), rc, grid: spec.grid, calls: spec.calls });
	const laidOut = spec.calls.some((c) => c[0] === "fig.tight_layout" || c[0] === "fig.subplots_adjust");
	if (spec.tight_layout ?? !laidOut) fig.tight_layout();

	const png = pngPath ? fig.toPNGSync({ scale }) : undefined;
	if (png && pngPath) writeFileSync(pngPath, png);
	const svg = svgPath ? fig.toSVG() : undefined;
	if (svg && svgPath) writeFileSync(svgPath, svg);
	if (htmlPath) {
		const interactive = spec.interactive ?? true;
		const pageSvg = fig.toSVG({ interactive });
		writeFileSync(htmlPath, htmlPage(pageSvg, spec.name ?? "chart", pageBackground(pageSvg, rc), interactive ? interactiveClient() : undefined));
	}
	// The spec as written (data references and all) so a later render can reproduce or restyle it.
	writeFileSync(specPath, `${JSON.stringify({ ...input, renderedAt: new Date().toISOString() }, null, 2)}\n`);
	return { png, pngPath, svgPath, htmlPath, specPath, theme, ...(png ? pngSize(png) : {}) };
}
