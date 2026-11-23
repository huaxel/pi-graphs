/** Data references in a chart spec: {$csv} and {$json}, resolved before the figure is built. */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { MplSpecError } from "./replay.ts";

/** Refuse to slurp files past this size; a chart never needs more. */
export const MAX_DATA_BYTES = 32 * 1024 * 1024;

export interface DataRefOptions {
	/** Injected for tests; defaults to readFileSync on the resolved path. */
	readonly readFile?: (path: string) => string;
	/** Base for relative paths; defaults to the working directory. */
	readonly baseDir?: string;
}

type Json = Record<string, unknown>;
type ColumnKind = "number" | "date" | "string";

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

function resolvePath(path: string, options: DataRefOptions): string {
	if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(options.baseDir ?? process.cwd(), path);
}

function readDataFile(path: string, options: DataRefOptions): string {
	const full = resolvePath(path, options);
	let text: string;
	if (options.readFile) {
		try {
			text = options.readFile(full);
		} catch (error) {
			throw new MplSpecError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		let size: number;
		try {
			size = statSync(full).size;
		} catch (error) {
			throw new MplSpecError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (size > MAX_DATA_BYTES) throw new MplSpecError(`${full} is larger than ${MAX_DATA_BYTES} bytes`);
		try {
			text = readFileSync(full, "utf8");
		} catch (error) {
			throw new MplSpecError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Buffer.byteLength(text, "utf8") > MAX_DATA_BYTES) throw new MplSpecError(`${full} is larger than ${MAX_DATA_BYTES} bytes`);
	return text;
}

/** RFC 4180 field scanning: quoted fields may hold the delimiter, newlines, and doubled quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let started = false;
	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		if (started || field !== "") endField();
		if (row.length > 0) rows.push(row);
		row = [];
		started = false;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (quoted) {
			if (ch !== '"') field += ch;
			else if (text[i + 1] === '"') {
				field += '"';
				i++;
			} else {
				quoted = false;
				if (text[i + 1] !== undefined && text[i + 1] !== delimiter && text[i + 1] !== "\r" && text[i + 1] !== "\n") {
					throw new MplSpecError("invalid CSV: unexpected character after closing quote");
				}
			}
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
			started = true;
		} else if (ch === delimiter) {
			endField();
			started = true;
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			endRow();
		} else {
			field += ch;
			started = true;
		}
	}
	if (quoted) throw new MplSpecError("invalid CSV: unterminated quoted field");
	endRow();
	return rows;
}

/** The delimiter that splits the header into the most fields. */
function detectDelimiter(firstLine: string): string {
	let best = ",";
	let bestCount = 1;
	for (const candidate of [",", ";", "\t", "|"]) {
		let count = 1;
		let quoted = false;
		for (const ch of firstLine) {
			if (ch === '"') quoted = !quoted;
			else if (ch === candidate && !quoted) count++;
		}
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best;
}

function inferKind(values: readonly string[]): ColumnKind {
	const present = values.filter((v) => v.trim() !== "");
	if (present.length === 0) return "number";
	if (present.every((v) => NUMBER.test(v.trim()))) return "number";
	if (present.every((v) => ISO_DATE.test(v.trim()))) return "date";
	return "string";
}

/** A column value: numbers/strings array, or {$dates} for date columns (decoded later by replay). */
const coerce = (values: readonly string[], kind: ColumnKind): unknown => {
	if (kind === "number") return values.map((v) => (v.trim() === "" ? Number.NaN : Number(v)));
	if (kind === "date") return { $dates: values.map((v) => v.trim()) };
	return [...values];
};

interface CsvRef extends Json {
	readonly $csv: string;
	readonly column?: string | number;
	readonly x?: string | number;
	readonly y?: readonly (string | number)[] | string | number;
	readonly parse?: ColumnKind | "auto";
	readonly header?: boolean;
}

const isCsvRef = (v: unknown): v is CsvRef => isObject(v) && typeof v.$csv === "string";
const isJsonRef = (v: unknown): v is Json & { $json: string } => isObject(v) && typeof v.$json === "string";

/** Parsed tables are large, so the cache stays small: a long session does not keep every file it read. */
const TABLE_CACHE_LIMIT = 8;
const tableCache = new Map<string, CsvTable>();

function cachedTable(key: string): CsvTable | undefined {
	const hit = tableCache.get(key);
	if (hit === undefined) return undefined;
	// Map iterates in insertion order; re-inserting makes this entry the most recent.
	tableCache.delete(key);
	tableCache.set(key, hit);
	return hit;
}

function cacheTable(key: string, table: CsvTable): void {
	tableCache.set(key, table);
	while (tableCache.size > TABLE_CACHE_LIMIT) tableCache.delete(tableCache.keys().next().value as string);
}

export interface CsvTable {
	readonly names: readonly string[];
	readonly columns: readonly unknown[];
}

/** Parses a CSV once: header names (empty when header: false) and coerced column arrays. */
export function readCsv(ref: CsvRef, options: DataRefOptions = {}): CsvTable {
	const fullPath = resolvePath(ref.$csv, options);
	let cacheKey: string | undefined;
	if (!options.readFile) {
		try {
			const stat = statSync(fullPath);
			cacheKey = `${fullPath}|${stat.mtimeMs}|${stat.size}|${ref.header ?? true}|${ref.parse ?? "auto"}`;
			const cached = cachedTable(cacheKey);
			if (cached) return cached;
		} catch {
			// Stat failed: readDataFile throws "cannot read <path>".
		}
	}
	const text = readDataFile(ref.$csv, options).replace(/^\uFEFF/, "");
	const newline = text.search(/\r?\n/);
	const rows = parseDelimited(text, detectDelimiter(newline === -1 ? text : text.slice(0, newline)));
	if (rows.length === 0) throw new MplSpecError(`${ref.$csv} has no rows`);
	const header = ref.header ?? true;
	const names = header ? (rows[0] as string[]).map((n) => n.trim()) : [];
	const body = header ? rows.slice(1) : rows;
	let width = 0;
	for (const row of rows) if (row.length > width) width = row.length;
	const columns: unknown[] = Array.from({ length: width }, (_, c) => {
		const raw = body.map((r) => r[c] ?? "");
		return coerce(raw, ref.parse && ref.parse !== "auto" ? ref.parse : inferKind(raw));
	});
	const table = { names, columns };
	if (cacheKey) cacheTable(cacheKey, table);
	return table;
}

function columnOf(ref: CsvRef, table: CsvTable, spec: string | number, role: string): unknown {
	const index = typeof spec === "number" ? spec : table.names.indexOf(spec);
	if (index >= 0 && index < table.columns.length) return table.columns[index];
	const available = table.names.length > 0 ? table.names.join(", ") : `${table.columns.length} unnamed column(s)`;
	throw new MplSpecError(`${role} ${JSON.stringify(spec)} is not in ${ref.$csv} (columns: ${available})`);
}

/** A CSV argument expands to [x, y] for one series, or to a single column when `column` is given. */
function csvArgs(ref: CsvRef, options: DataRefOptions): unknown[] {
	const table = readCsv(ref, options);
	if (ref.column !== undefined) return [columnOf(ref, table, ref.column, "$csv column")];
	const y = ref.y === undefined ? undefined : [ref.y].flat();
	if (y !== undefined && y.length > 1) {
		throw new MplSpecError(
			`{$csv} y takes one column, got ${y.length}; make one call per series, e.g. ["plot", [{"$csv": "${ref.$csv}", "x": ${JSON.stringify(ref.x ?? 0)}, "y": ${JSON.stringify(y[0])}}]]`,
		);
	}
	if (ref.x === undefined && y === undefined) {
		return table.columns.length === 1 ? [table.columns[0]] : [table.columns[0], table.columns[1]];
	}
	const x = ref.x === undefined ? table.columns[0] : columnOf(ref, table, ref.x, "$csv x");
	if (y === undefined) return [x, table.columns[table.columns.length - 1]];
	return [x, columnOf(ref, table, y[0] as string | number, "$csv y")];
}

function expandValue(value: unknown, options: DataRefOptions): unknown {
	if (Array.isArray(value)) return value.map((v) => expandValue(v, options));
	if (isCsvRef(value)) {
		const args = csvArgs(value, options);
		if (args.length !== 1) {
			throw new MplSpecError(
				`{$csv} with x/y expands to ${args.length} arrays, so it must be a positional argument; use {"$csv": ..., "column": name} for a single value`,
			);
		}
		return args[0];
	}
	if (isJsonRef(value)) return JSON.parse(readDataFile(value.$json, options));
	if (!isObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = expandValue(v, options);
	return out;
}

function expandCall(call: unknown, options: DataRefOptions): unknown {
	if (!Array.isArray(call) || typeof call[0] !== "string") return call;
	const [fn, rawArgs, rawKwargs] = call;
	// Args that are not an array are replay's error to report, with its own wording.
	const args = Array.isArray(rawArgs)
		? rawArgs.flatMap((arg) => (isCsvRef(arg) && arg.column === undefined ? csvArgs(arg, options) : [expandValue(arg, options)]))
		: rawArgs;
	const expanded: unknown[] = [fn, args];
	if (rawKwargs !== undefined) expanded.push(expandValue(rawKwargs, options));
	return expanded;
}

/** Resolves every {$csv} and {$json} in a spec's calls, leaving the rest untouched. */
export function expandDataRefs<T extends { calls: readonly unknown[] }>(spec: T, options: DataRefOptions = {}): T {
	return { ...spec, calls: spec.calls.map((call) => expandCall(call, options)) } as T;
}
