# Plan 005: Refuse oversized data before reading or drawing it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a8b5b60..HEAD -- data.ts replay.ts test/data.test.ts test/render.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Plan 002 may already have changed `readCsv`'s cache key. Keep that key.
> This plan adds a size check in `readDataFile`. It does not redesign the cache.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-csv-cache-freshness.md (both edit `data.ts` and `test/data.test.ts`)
- **Category**: bug
- **Planned at**: commit `a8b5b60`, 2026-11-23

## Why this matters

The README says files over 32 MB are refused, and that 400k data points is the ceiling that stops one spec from blocking the session. The size check runs after `readFileSync`, so a much larger file is already a string before it is refused. The check also uses `text.length`, which counts UTF-16 code units. The point counter walks arrays in positional args only. A `{$dates: [...]}` payload and a `yerr` kwarg of 400_001 numbers both pass `assertWithinBudget`. Date columns from CSV are `{$dates}` objects, so a large date series is under-counted the same way. This plan makes both caps match the README.

## Current state

`data.ts` `readDataFile`:

```ts
function readDataFile(path: string, options: DataRefOptions): string {
	const full = resolvePath(path, options);
	let text: string;
	try {
		text = (options.readFile ?? ((p: string) => readFileSync(p, "utf8")))(full);
	} catch (error) {
		throw new MplSpecError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (text.length > MAX_DATA_BYTES) throw new MplSpecError(`${full} is larger than ${MAX_DATA_BYTES} bytes`);
	return text;
}
```

`MAX_DATA_BYTES` is `32 * 1024 * 1024`. The error text is `` `${full} is larger than ${MAX_DATA_BYTES} bytes` ``. Keep that sentence; tests and the README describe it that way.

`options.readFile` is how tests supply CSV text without a real file. There is nothing to `stat` in that case. Still refuse when the returned text encodes to more than `MAX_DATA_BYTES` bytes.

If plan 002 has landed, `readCsv` stats the file for a cache key of `` `${path}|${mtimeMs}|${size}|${header}|${parse}` `` and skips the cache when `options.readFile` is set. Do not remove that. A second `statSync` inside `readDataFile` on a cache miss is fine.

`replay.ts` point budget:

```ts
export const MPL_LIMITS = { calls: 250, points: 400_000 } as const;

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
```

`assertWithinBudget` throws `` `${points} data points exceeds the ${MPL_LIMITS.points}-point limit` ``. `renderChart` calls it after `expandDataRefs`, so CSV numbers are already arrays. Date columns are still `{ $dates: string[] }` at that moment, because `decodeValue` runs later inside `buildFigure`. Kwargs are `call[2]`.

The walk already counts container arrays as well as their children (`[x, y]` adds 2 plus the lengths). Keep that. Do not raise or lower `400_000`. The existing test in `test/render.test.ts` builds one positional array of `MPL_LIMITS.points + 1` numbers and expects `/data points exceeds/`. It must still pass.

`render.ts` re-exports `assertWithinBudget` and `MPL_LIMITS`. Tests may import them from `render.ts`, as `test/render.test.ts` already imports `MPL_LIMITS`.

Repo conventions: tabs, `node:test`, `node:assert/strict`, `.ts` suffixes. Do not reformat surrounding code.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Data tests | `node --import tsx --test test/data.test.ts` | all pass, exit 0 |
| Render tests | `node --import tsx --test test/render.test.ts` | all pass, exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:

- `data.ts` — `readDataFile` only
- `replay.ts` — `countPoints` only
- `test/data.test.ts` — one size test
- `test/render.test.ts` — one budget test that calls `assertWithinBudget` directly

**Out of scope**:

- `MPL_LIMITS` values, the call-count check, and the scale check.
- Cache key design from plan 002.
- `index.ts`, `ansi.ts`, `render.ts` (the re-export already exposes `assertWithinBudget`).
- Trying to count points inside a CSV that has not been expanded. The budget runs after expansion.

## Git workflow

- Branch: `advisor/005-enforce-render-budgets`
- One commit. Message: `Refuse oversized chart data before it is loaded`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Stat the file before reading it

In `readDataFile`, when `options.readFile` is absent:

1. `statSync(full)`.
2. If `stat.size > MAX_DATA_BYTES`, throw `new MplSpecError(`${full} is larger than ${MAX_DATA_BYTES} bytes`)` and do not call `readFileSync`.
3. If `statSync` throws, throw the existing `cannot read ${full}: ...` error. Do not fall through to `readFileSync` on a stat failure.

When `options.readFile` is set, skip `statSync`. After the text is in hand (both paths), refuse when `Buffer.byteLength(text, "utf8") > MAX_DATA_BYTES`, with the same error sentence. Delete the `text.length` comparison so a multi-byte file is measured in bytes.

Add `statSync` to the `node:fs` import if it is not already there.

**Verify**: a file of `MAX_DATA_BYTES + 1` bytes is refused, and a normal CSV still parses. From the repo root:

```bash
node --import tsx -e '
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DATA_BYTES, readCsv } from "./data.ts";
const dir = mkdtempSync(join(tmpdir(), "pi-cap-"));
const huge = join(dir, "huge.csv");
writeFileSync(huge, Buffer.alloc(MAX_DATA_BYTES + 1, 0x61));
try { readCsv({ $csv: huge }); console.error("was read"); process.exit(1); }
catch (e) { if (!String(e.message).includes("larger than")) { console.error(e); process.exit(1); } }
const small = join(dir, "ok.csv");
writeFileSync(small, "n\n1\n");
if (readCsv({ $csv: small }).columns[0][0] !== 1) process.exit(1);
console.log("size cap ok");
rmSync(dir, { recursive: true, force: true });
'
```

Expected: exit 0 and `size cap ok`. This writes a 32 MB file under the system temp dir once.

### Step 2: Count points inside objects and kwargs

Replace `countPoints` so `walk` does three things:

- Array, `Float64Array`, or `Uint32Array`: add `value.length`. If it is a plain array, `walk` each element (same nesting as today).
- Any other non-null object: `walk` each `Object.values` entry. This is what reaches `$dates` and other wrappers. Strings, numbers, and null add nothing.
- For each call, `walk(call[1])` and `walk(call[2])`.

Do not count object keys. Do not follow prototypes. Specs are JSON-shaped; there are no cycles. Do not try to count only leaf arrays — the existing positional test depends on the container length being included, and a leaf-only counter is a behaviour change this plan does not want.

A date payload and a kwarg payload must throw. Check before adding the test:

```bash
node --import tsx -e '
import { assertWithinBudget, MPL_LIMITS } from "./replay.ts";
const n = MPL_LIMITS.points + 1;
const dates = { $dates: Array.from({ length: n }, () => "2026-01-01") };
const yerr = Array.from({ length: n }, () => 1);
let datesHit = false;
let kwargHit = false;
try { assertWithinBudget([["plot", [dates, [1]]]]); } catch (e) { datesHit = /data points exceeds/.test(String(e)); }
try { assertWithinBudget([["plot", [[1, 2]], { yerr }]]); } catch (e) { kwargHit = /data points exceeds/.test(String(e)); }
if (!datesHit || !kwargHit) { console.error({ datesHit, kwargHit }); process.exit(1); }
console.log("point cap ok");
'
```

Expected: exit 0 and `point cap ok`. Building the 400_001-element arrays is in memory only; it does not render.

### Step 3: Add the two regressions

In `test/data.test.ts`, import `MAX_DATA_BYTES` if it is not already imported from `../data.ts`. Append:

```ts
test("readCsv refuses a file over 32MB without parsing it", () => {
	const path = join(dir, "huge.csv");
	writeFileSync(path, Buffer.alloc(MAX_DATA_BYTES + 1, 0x61));
	assert.throws(() => readCsv({ $csv: path }), new RegExp(`larger than ${MAX_DATA_BYTES} bytes`));
});
```

`join`, `writeFileSync`, `dir`, `readCsv`, and `assert` are already in that file. The file is 32 MB of `a`, which is not a valid tiny CSV; the assertion is on the size message, so a parser error is a failure.

In `test/render.test.ts`, import `assertWithinBudget` from `../render.ts` (add it to the existing `MPL_LIMITS` import). Append a test that calls `assertWithinBudget` directly, not `renderChart` (rendering 400k points is the cost this cap avoids):

- `{$dates: array of MPL_LIMITS.points + 1 ISO strings}` as a positional value throws `/data points exceeds/`.
- `{ yerr: array of MPL_LIMITS.points + 1 numbers }` on a two-point plot throws the same way.

Leave the existing "limits stop runaway specs before rendering" test unchanged.

**Verify**: `node --import tsx --test test/data.test.ts test/render.test.ts` → exit 0. Then `npm run check` → exit 0.

## Test plan

- `test/data.test.ts`: file larger than `MAX_DATA_BYTES` throws the size error. Pattern: the other `assert.throws` tests in that file.
- `test/render.test.ts`: `$dates` and `yerr` trip `assertWithinBudget`. Pattern: the existing limits test, but call `assertWithinBudget` so the suite does not draw the chart.
- The existing 250-call and positional-array tests keep passing.
- If plan 002's cache tests are present (`reparses when the file changes`, injected `readFile`, rewritten CSV PNG), they keep passing. The size test does not go through a cached small file.
- Verification: the two test files, then `npm run check`.

## Done criteria

ALL must hold:

- [ ] `node --import tsx --test test/data.test.ts test/render.test.ts` exits 0
- [ ] `npm run check` exits 0
- [ ] `grep -n "text.length > MAX_DATA_BYTES" data.ts` finds nothing
- [ ] `countPoints` walks `call[2]` and object values (`grep -n "call\[2\]" replay.ts` finds the new walk)
- [ ] `git status` shows modifications only under `data.ts`, `replay.ts`, `test/data.test.ts`, `test/render.test.ts`, and the status row in `plans/README.md`
- [ ] `plans/README.md` status row for 005 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- `readDataFile` or `countPoints` no longer matches the excerpts, and the difference is not plan 002's cache key.
- The only way to refuse a large file is to read it first. `statSync().size` is the disk check.
- Counting object values makes the existing three-point render tests throw the point limit. A small spec is nowhere near 400k; if it trips, the walk is counting the wrong thing (for example every character of every string). Stop.
- You feel you should change `400_000` or `32 * 1024 * 1024` to make a test fit.
- Plan 002's cache tests fail and the repair would mean deleting the mtime/size key. Keep the key. The size check belongs in `readDataFile`.

## Maintenance notes

- `assertWithinBudget` runs after `expandDataRefs` and before `decodeValue`. New wrappers that carry arrays inside objects are counted. New typed arrays need to be added next to `Float64Array` and `Uint32Array`.
- Container arrays still add their own length. A series of 200k y values plus 200k date strings is about 400k plus the small argument arrays, so it sits on the ceiling. That is the cap the README describes.
- Reviewers should check the disk path throws before `readFileSync`, and that the injected `readFile` path still has a `Buffer.byteLength` check.
- The cache from plan 002 can still return a previously parsed small file without stating it again. A file that grows past 32 MB changes size, misses the cache, and is refused in `readDataFile`.
