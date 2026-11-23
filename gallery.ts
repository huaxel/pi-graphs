/** The chart folder: listing rendered charts and pruning old day directories. No Pi imports, so tests drive it. */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const CHART_ROOT = process.env.PI_CHART_DIR || join(homedir(), ".pi", "agent", "work", "charts");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILES = [".png", ".svg", ".html", ".json"] as const;

export interface ChartEntry {
	readonly day: string;
	readonly stem: string;
	readonly png?: string;
	readonly svg?: string;
	readonly html?: string;
	readonly spec?: string;
	readonly mtimeMs: number;
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10);
const daysAgo = (days: number): string => dayString(new Date(Date.now() - days * 86_400_000));

/** Charts from the last `days` day folders, newest first, grouped by file stem. */
export function listCharts(root = CHART_ROOT, options: { days?: number; limit?: number } = {}): ChartEntry[] {
	if (!existsSync(root)) return [];
	const cutoff = daysAgo(options.days ?? 7);
	const entries: ChartEntry[] = [];
	for (const day of readdirSync(root).filter((name) => DAY.test(name) && name >= cutoff).sort().reverse()) {
		const dir = join(root, day);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		const byStem = new Map<string, ChartEntry & { mtimeMs: number }>();
		for (const name of names) {
			const ext = name.slice(name.lastIndexOf("."));
			if (!(FILES as readonly string[]).includes(ext)) continue;
			const stem = basename(name, ext);
			const path = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch {
				continue;
			}
			const current = byStem.get(stem) ?? { day, stem, mtimeMs: 0 };
			byStem.set(stem, {
				...current,
				mtimeMs: Math.max(current.mtimeMs, mtimeMs),
				...(ext === ".png" ? { png: path } : ext === ".svg" ? { svg: path } : ext === ".html" ? { html: path } : { spec: path }),
			});
		}
		entries.push(...byStem.values());
	}
	const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return options.limit ? sorted.slice(0, options.limit) : sorted;
}

/** One-line description for a picker. */
export function describeChart(entry: ChartEntry): string {
	const kinds = [entry.png && "png", entry.svg && "svg", entry.html && "html"].filter(Boolean).join("/");
	const when = new Date(entry.mtimeMs).toISOString().slice(11, 16);
	return `${entry.day} ${when}  ${entry.stem}${kinds ? `  [${kinds}]` : ""}`;
}

export interface PruneResult {
	readonly days: readonly string[];
	readonly files: number;
}

const isDay = (name: string): boolean => DAY.test(name);

/** Day folders that `pruneCharts` would delete, so a confirmation can name the same set. */
export function staleDays(root = CHART_ROOT, options: { days?: number; keepDay?: string } = {}): string[] {
	if (!existsSync(root)) return [];
	const cutoff = daysAgo(options.days ?? 14);
	const keep = options.keepDay ?? dayString(new Date());
	return readdirSync(root)
		.filter((day) => isDay(day) && day < cutoff && day !== keep)
		.sort();
}

/** Deletes day folders older than `days`, keeping the current day. Refuses paths outside the root. */
export function pruneCharts(root = CHART_ROOT, options: { days?: number; keepDay?: string } = {}): PruneResult {
	if (!existsSync(root)) return { days: [], files: 0 };
	let rootPath = resolve(root);
	try {
		rootPath = realpathSync(rootPath);
	} catch {
		// keep the resolved path when the root is not readable
	}
	const removed: string[] = [];
	let files = 0;
	for (const day of staleDays(root, options)) {
		let dir = resolve(join(root, day));
		try {
			dir = realpathSync(dir);
		} catch {
			continue;
		}
		// Separator-safe containment: `${rootPath}/` never prefixes a Windows path.
		// relative() returns an absolute path for another drive, which isAbsolute catches.
		const inside = relative(rootPath, dir);
		if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
		try {
			files += readdirSync(dir).length;
			rmSync(dir, { recursive: true, force: true });
			removed.push(day);
		} catch {
			// A folder that cannot be removed stays; the next run retries.
		}
	}
	return { days: removed, files };
}
