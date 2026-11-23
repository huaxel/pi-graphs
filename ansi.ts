/**
 * Terminal-native chart rendering: replays a spec with mpl, then encodes the figure's scene for a
 * character grid. Marks are braille (2x4 dots per cell), rules and labels use box drawing and real
 * text, so a chart stays readable in terminals that cannot show images and stays copyable.
 *
 * Trade-off, deliberately accepted: an 80x24 chart is a 160x96 dot canvas against 1440x840 pixels for
 * the PNG, so this is a fallback, not a replacement.
 */
import { assertWithinBudget, buildFigure, type MplCall, type MplGrid } from "./replay.ts";

export interface AnsiRenderInput {
	readonly calls: readonly MplCall[];
	readonly rc?: Readonly<Record<string, unknown>>;
	readonly grid?: MplGrid;
	readonly style?: string;
	/** Terminal columns, default 78. */
	readonly cols?: number;
	/** Emit colour escapes; false returns the same glyphs unstyled. Default true. */
	readonly color?: boolean;
}

export interface AnsiRenderOutput {
	readonly lines: readonly string[];
	readonly plain: readonly string[];
	readonly cols: number;
	readonly rows: number;
}

type Rgb = { hex: string; alpha?: number };
type Cell = { glyph: string; hex?: string; bg?: string; prio: number };

const BRAILLE = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
/** Braille dot order inside a cell: columns left/right, then the three upper rows, then the bottom row. */
const brailleBit = (dx: number, dy: number): number => BRAILLE[dy < 3 ? dx * 4 + dy : 6 + dx] as number;

const rgbOf = (hex: string): [number, number, number] => [
	parseInt(hex.slice(1, 3), 16),
	parseInt(hex.slice(3, 5), 16),
	parseInt(hex.slice(5, 7), 16),
];
const fg = (hex: string): string => `\x1b[38;2;${rgbOf(hex).join(";")}m`;
const bg = (hex: string): string => `\x1b[48;2;${rgbOf(hex).join(";")}m`;

interface Paint {
	readonly fg?: string;
	readonly bg?: string;
}

/** Draws a scene into a character grid. Exported for tests; most callers want renderAnsiChart. */
export function sceneToCells(
	scene: { width: number; height: number; nodes: readonly unknown[] },
	options: { cols: number },
): { cells: Cell[][]; cols: number; rows: number; rowPx: number; colPx: number } {
	const cols = options.cols;
	const rows = Math.max(8, Math.round((cols * scene.height) / scene.width / 2));
	const colPx = scene.width / cols;
	const rowPx = scene.height / rows;
	const dotW = colPx / 2;
	const dotH = rowPx / 4;
	const subW = cols * 2;
	const subH = rows * 4;
	const dots = new Int32Array(subW * subH).fill(-1);
	const colors: string[] = [];
	const colorIndex = (hex: string): number => {
		const i = colors.indexOf(hex);
		if (i >= 0) return i;
		colors.push(hex);
		return colors.length - 1;
	};

	const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ glyph: " ", prio: -1 })));
	const setCell = (row: number, col: number, cell: Cell): void => {
		if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || row >= rows || col < 0 || col >= cols) return;
		const current = cells[row]?.[col];
		if (current && cell.prio >= current.prio) cells[row]![col] = cell;
	};

	const plotDot = (px: number, py: number, color: number): void => {
		const sx = Math.round(px / dotW - 0.5);
		const sy = Math.round(py / dotH - 0.5);
		if (sx < 0 || sy < 0 || sx >= subW || sy >= subH) return;
		dots[sy * subW + sx] = color;
	};
	const line = (x0: number, y0: number, x1: number, y1: number, color: number): void => {
		if (![x0, y0, x1, y1].every(Number.isFinite)) return;
		let sx = Math.round(x0 / dotW - 0.5);
		let sy = Math.round(y0 / dotH - 0.5);
		const ex = Math.round(x1 / dotW - 0.5);
		const ey = Math.round(y1 / dotH - 0.5);
		const dx = Math.abs(ex - sx);
		const dy = Math.abs(ey - sy);
		const stepX = sx < ex ? 1 : -1;
		const stepY = sy < ey ? 1 : -1;
		let err = dx - dy;
		for (let guard = 0; guard < 40_000; guard++) {
			plotDot(sx * dotW, sy * dotH, color);
			plotDot(sx * dotW, (sy + 1) * dotH, color); // two dots of weight: solid runs, smoother diagonals
			if (sx === ex && sy === ey) break;
			const e2 = 2 * err;
			if (e2 > -dy) {
				err -= dy;
				sx += stepX;
			}
			if (e2 < dx) {
				err += dx;
				sy += stepY;
			}
		}
	};

	// The Axes box, found before the walk: it separates spines from grid rules and clamps labels.
	let box = { x0: 0, y0: 0, x1: scene.width, y1: scene.height };
	const findBox = (nodes: readonly unknown[]): void => {
		for (const raw of nodes) {
			const node = raw as Record<string, unknown> & { kind: string };
			if (node.kind === "group" || node.kind === "collection") {
				findBox((node.nodes as readonly unknown[]) ?? []);
				continue;
			}
			if (node.kind !== "rect") continue;
			const area = Number(node.w) * Number(node.h);
			if (area > (box.x1 - box.x0) * (box.y1 - box.y0) * 0.3) continue;
			if (area > (box.x1 - box.x0) * (box.y1 - box.y0) * 0.25 || box.x1 === scene.width) {
				box = { x0: Number(node.x), y0: Number(node.y), x1: Number(node.x) + Number(node.w), y1: Number(node.y) + Number(node.h) };
			}
		}
	};

	const flatten = (segs: readonly unknown[]): [number, number][][] => {
		const out: [number, number][][] = [];
		let cur: [number, number][] = [];
		let px = 0;
		let py = 0;
		for (const raw of segs) {
			const s = raw as (readonly [string, number, number, number?, number?, number?, number?]) & readonly unknown[];
			const kind = s[0];
			if (kind === "M") {
				if (cur.length > 0) out.push(cur);
				cur = [[s[1] as number, s[2] as number]];
				px = s[1] as number;
				py = s[2] as number;
			} else if (kind === "L") {
				cur.push([s[1] as number, s[2] as number]);
				px = s[1] as number;
				py = s[2] as number;
			} else if (kind === "Z") {
				if (cur.length > 0 && cur[0]) cur.push([cur[0][0], cur[0][1]]);
			} else if (kind === "Q" || kind === "C") {
				const steps = 12;
				const start: [number, number] = [px, py];
				for (let i = 1; i <= steps; i++) {
					const t = i / steps;
					const u = 1 - t;
					if (kind === "Q") {
						const [cx, cy, ex2, ey2] = [s[1] as number, s[2] as number, s[3] as number, s[4] as number];
						cur.push([u * u * start[0] + 2 * u * t * cx + t * t * ex2, u * u * start[1] + 2 * u * t * cy + t * t * ey2]);
					} else {
						const [c1x, c1y, c2x, c2y, ex2, ey2] = [s[1], s[2], s[3], s[4], s[5], s[6]].map(Number) as [number, number, number, number, number, number];
						cur.push([
							u ** 3 * start[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * ex2,
							u ** 3 * start[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * ey2,
						]);
					}
				}
				const last = cur.at(-1);
				if (last) {
					px = last[0];
					py = last[1];
				}
			}
		}
		if (cur.length > 0) out.push(cur);
		return out;
	};

	const texts: { text: string; x: number; y: number; sizePx: number; rotation: unknown; hex: string }[] = [];

	const walk = (nodes: readonly unknown[]): void => {
		for (const raw of nodes) {
			const node = raw as Record<string, unknown> & { kind: string };
			if (node.kind === "group" || node.kind === "collection") {
				walk((node.nodes as readonly unknown[]) ?? []);
				continue;
			}
			if (node.kind === "image") continue; // rasters stay for the PNG
			// Polyline colour is stroke.color.hex; path inks nest the colour as ink.stroke.color.hex; fills use ink.fill.hex.
			const ink = node.ink as { stroke?: { color?: Rgb; width?: number }; fill?: Rgb } | undefined;
			const stroke = node.stroke as { hex?: string; color?: Rgb; width?: number } | undefined;
			const paint = stroke?.color?.hex ?? stroke?.hex ?? ink?.stroke?.color?.hex ?? ink?.fill?.hex ?? "#ffffff";
			const hex = paint.slice(0, 7).toLowerCase();
			// Hairlines are rules (grid, spines, ticks) whatever the theme; series strokes are heavier.
			const strokeWidth = stroke?.width ?? ink?.stroke?.width ?? 0;
			const thin = strokeWidth > 0 && strokeWidth < 1.5;
			if (node.kind === "text") {
				texts.push({
					text: String(node.text ?? ""),
					x: Number(node.x),
					y: Number(node.y),
					sizePx: Number(node.sizePx ?? 12),
					rotation: node.rotation,
					hex: ((node.color as Rgb | undefined)?.hex ?? "#ffffff").toLowerCase(),
				});
				continue;
			}
			if (node.kind === "rect") {
				const ink = node.ink as { kind: string; fill?: Rgb } | undefined;
				const r = { x: Number(node.x), y: Number(node.y), w: Number(node.w), h: Number(node.h) };
				if (r.w * r.h > scene.width * scene.height * 0.3) {
					box = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
					continue;
				}
				const fillHex = ((node.ink as { fill?: Rgb } | undefined)?.fill?.hex ?? "").slice(0, 7).toLowerCase();
				if (!fillHex) continue;
				const row0 = Math.round(r.y / rowPx);
				const row1 = Math.round((r.y + r.h) / rowPx);
				const col0 = Math.round(r.x / colPx);
				const col1 = Math.round((r.x + r.w) / colPx);
				for (let row = row0; row < row1; row++) {
					for (let col = col0; col < col1; col++) setCell(row, col, { glyph: " ", bg: fillHex, prio: 2 });
				}
				continue;
			}
			const color = colorIndex(hex);
			const paths: [number, number][][] =
				node.kind === "polyline"
					? (() => {
							const out: [number, number][][] = [];
							let cur: [number, number][] = [];
							const xs = node.xs as Float64Array;
							const ys = node.ys as Float64Array;
							for (let i = 0; i < xs.length; i++) {
								const x = xs[i] as number;
								const y = ys[i] as number;
								if (Number.isNaN(x) || Number.isNaN(y)) {
									if (cur.length > 0) out.push(cur);
									cur = [];
									continue;
								}
								cur.push([x, y]);
							}
							if (cur.length > 0) out.push(cur);
							return out;
						})()
					: node.kind === "markers"
						? []
						: flatten((node.segs as readonly unknown[]) ?? []);
			for (const points of paths) {
				for (let i = 0; i < points.length - 1; i++) {
					const [x0, y0] = points[i] as [number, number];
					const [x1, y1] = points[i + 1] as [number, number];
					const horizontal = Math.abs(y1 - y0) < 0.75;
					const vertical = Math.abs(x1 - x0) < 0.75;
					if (thin && (horizontal || vertical)) {
						// A rule on the box edge is a spine; a short one is a tick mark.
						if (Math.hypot(x1 - x0, y1 - y0) < 6) continue;
						const onSpine = horizontal
							? Math.abs(y0 - box.y0) < 1.5 || Math.abs(y0 - box.y1) < 1.5
							: Math.abs(x0 - box.x0) < 1.5 || Math.abs(x0 - box.x1) < 1.5;
						if (onSpine) {
							if (horizontal) {
								const row = Math.round(y0 / rowPx - 0.5);
								for (let col = Math.round(Math.min(x0, x1) / colPx); col <= Math.round(Math.max(x0, x1) / colPx); col++) {
									setCell(row, col, { glyph: "─", hex, prio: 1 });
								}
							} else {
								const col = Math.round(x0 / colPx - 0.5);
								for (let row = Math.round(Math.min(y0, y1) / rowPx); row <= Math.round(Math.max(y0, y1) / rowPx); row++) {
									setCell(row, col, { glyph: "│", hex, prio: 1 });
								}
							}
							continue;
						}
						if (horizontal) {
							const row = Math.round(y0 / rowPx - 0.5);
							for (let col = Math.round(Math.min(x0, x1) / colPx); col <= Math.round(Math.max(x0, x1) / colPx); col++) {
								setCell(row, col, { glyph: "·", hex, prio: 0 });
							}
						} else {
							const col = Math.round(x0 / colPx - 0.5);
							for (let row = Math.round(Math.min(y0, y1) / rowPx); row <= Math.round(Math.max(y0, y1) / rowPx); row++) {
								setCell(row, col, { glyph: "·", hex, prio: 0 });
							}
						}
						continue;
					}
					line(x0, y0, x1, y1, color);
				}
			}
			if (node.kind === "markers") {
				const xs = node.xs as Float64Array;
				const ys = node.ys as Float64Array;
				for (let i = 0; i < xs.length; i++) plotDot(xs[i] as number, ys[i] as number, color);
			}
		}
	};
	findBox(scene.nodes);
	walk(scene.nodes);

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			let bits = 0;
			let color = -1;
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const value = dots[(row * 4 + dy) * subW + col * 2 + dx] as number;
					if (value < 0) continue;
					bits |= brailleBit(dx, dy);
					if (color < 0) color = value;
				}
			}
			if (bits > 0) setCell(row, col, { glyph: String.fromCharCode(0x2800 + bits), hex: colors[color] as string, prio: 3 });
		}
	}

	for (const text of texts) {
		const glyphs = [...text.text];
		if (glyphs.length === 0) continue;
		const vertical = text.rotation === "vertical";
		const width = vertical ? 1 : glyphs.length;
		let col = vertical ? Math.round(text.x / colPx - 0.5) : Math.round(text.x / colPx);
		let row = Math.round((text.y - text.sizePx * 0.45) / rowPx);
		// A title sits above the frame: never let it land on the top spine row.
		if (!vertical && text.y <= box.y0 + 1) row = Math.min(row, Math.round(box.y0 / rowPx - 0.5) - 1);
		if (row < 0) row = 0;
		// Labels anchored at their right edge would otherwise run into the plot; keep them outside the box.
		const startCol = Math.round(box.x0 / colPx);
		if (!vertical && col < startCol && col + width > startCol) col = startCol - width;
		glyphs.forEach((glyph, i) => {
			if (vertical) setCell(row + i, col, { glyph, hex: text.hex, prio: 4 });
			else setCell(row, col + i, { glyph, hex: text.hex, prio: 4 });
		});
	}

	return { cells, cols, rows, rowPx, colPx };
}

const style = (want: Paint): string => `${want.bg ? bg(want.bg) : ""}${want.fg ? fg(want.fg) : ""}`;

/** Renders a chart spec for a terminal grid. */
export function renderAnsiChart(input: AnsiRenderInput): AnsiRenderOutput {
	const cols = Math.max(40, Math.min(200, input.cols ?? 78));
	assertWithinBudget(input.calls);
	const fig = buildFigure({ style: input.style, rc: input.rc, grid: input.grid, calls: input.calls });
	const scene = fig.toScene() as unknown as { width: number; height: number; nodes: readonly unknown[] };
	const { cells, rows } = sceneToCells(scene, { cols });

	const lines: string[] = [];
	const plain: string[] = [];
	for (let row = 0; row < rows; row++) {
		let out = "";
		let last = "";
		let bare = "";
		for (const cell of cells[row]!) {
			bare += cell.bg && cell.glyph === " " ? "█" : cell.glyph;
			if (input.color === false) {
				out += cell.glyph;
				continue;
			}
			const wanted = style({ fg: cell.hex, bg: cell.bg });
			if (wanted !== last) {
				out += `\x1b[0m${wanted}`;
				last = wanted;
			}
			out += cell.glyph;
		}
		lines.push(input.color === false ? out : `${out}\x1b[0m`);
		plain.push(bare);
	}
	return { lines, plain, cols, rows };
}
