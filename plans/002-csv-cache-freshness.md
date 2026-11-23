# Plan 002: Re-read a CSV when the file changes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a8b5b60..HEAD -- data.ts test/data.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a8b5b60`, 2026-11-23

## Why this matters

The README promises that `$csv` references are re-read on every render, so a saved chart picks up the current file. `readCsv` caches the parsed table for the life of the process, keyed only by path, header flag, and parse mode. A second render with the same name therefore hashes the old rows and returns the old PNG. Pi sessions stay up, so the agent keeps publishing stale numbers after the file is updated. The cache itself should stay: one chart often reads the same CSV once per series, and a 70_000-row test requires the second `readCsv` of an unchanged file to return the same object.

## Current state

- `data.ts` — `$csv` / `$json` resolution. `readCsv` parses and caches. `expandDataRefs` is what `renderChart` calls before drawing. `MAX_DATA_BYTES` is `32 * 1024 * 1024`. The size check inside `readDataFile` runs only after `readFileSync`; leave that order alone in this plan.
- `test/data.test.ts` — parser tests. The cache test (currently the second test) writes `big.csv` with 70_000 data rows and asserts `readCsv({ $csv: big }) === table` on the immediate second call.
- `render.ts` `renderChart` expands data refs, then hashes the expanded calls into the filename. Stale rows produce the same hash and the same path. You do not need to change `render.ts` for the new hash to fall out of fresh rows.

Cache today (`data.ts:138-149`):

```ts
const tableCache = new Map<string, CsvTable>();

export function readCsv(ref: CsvRef, options: DataRefOptions = {}): CsvTable {
	const cacheKey = `${resolvePath(ref.$csv, options)}|${ref.header ?? true}|${ref.parse ?? "auto"}`;
	const cached = tableCache.get(cacheKey);
	if (cached) return cached;
	const text = readDataFile(ref.$csv, options).replace(/^\uFEFF/, "");
```

`readDataFile` (`data.ts:29-38`) uses `options.readFile` when the test injects one, otherwise `readFileSync`. Several tests call `readCsv({ $csv: "bad.csv" }, { readFile: () => "..." })` with different texts for the same fake path. A path-only cache would couple those tests to each other.

`DataRefOptions` is:

```ts
export interface DataRefOptions {
	readonly readFile?: (path: string) => string;
	readonly baseDir?: string;
}
```

Do not add fields to this interface.

Repo conventions: tabs, `node:test`, `node:assert/strict`, `.ts` import suffixes. `test/data.test.ts` already creates a temp directory and deletes it in `after`. Add tests there. Do not reformat the file.

Documented contract to keep (README, "Data references"): `$csv` and `$json` are re-read on every render. One series per call is a different plan; do not change `csvArgs`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| One file | `node --import tsx --test test/data.test.ts` | all pass, exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:

- `data.ts`
- `test/data.test.ts`

**Out of scope**:

- The 32 MB refusal. It still runs after the read. A later plan moves it. Do not stat-and-throw for size in this change.
- `$json`. It is not cached. Leave it uncached.
- `replay.ts` point counting, `index.ts` instructions, `render.ts` hashing.
- Multi-column `y`. The parser rejects it on purpose.

## Git workflow

- Branch: `advisor/002-csv-cache-freshness`
- One commit. Message style: `Re-read CSV charts when the file changes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Key the disk cache by mtime and size

In `readCsv`, cache only real disk reads, and include `mtimeMs` and `size` from `statSync` in the key.

Required behaviour:

- `options.readFile` is set → do not touch the cache and do not `statSync`. Parse whatever the injected reader returns. Tests pass fake paths such as `"bad.csv"`.
- `options.readFile` is absent → `statSync(resolvePath(...))`. On failure, do not throw from the cache helper; fall through to `readDataFile`, which already reports `cannot read <path>`.
- Key: `` `${fullPath}|${stat.mtimeMs}|${stat.size}|${ref.header ?? true}|${ref.parse ?? "auto"}` ``
- Store the table only when that key exists. An unchanged file returns the same object. A rewrite changes size or mtime, misses, and parses again.

Do not hash the file body. The cache exists so several series in one render parse the CSV once. Do not clear the map on every `expandDataRefs` call: the 70_000-row test calls `readCsv` twice directly and requires object identity.

`node:fs` currently imports only `readFileSync`. Add `statSync` to that import.

**Verify**: `node --import tsx --test test/data.test.ts` → the existing suite still passes, including `the parsed table is reused`.

### Step 2: Test a rewrite and an injected reader

Append tests to `test/data.test.ts`.

1. Disk rewrite. Use the existing `write` helper. Contents must differ in byte length so the test does not depend on timestamp resolution:

```ts
test("readCsv reparses when the file changes", () => {
	const path = write("fresh.csv", "x,y\n1,10\n");
	const first = readCsv({ $csv: path });
	assert.deepEqual(first.columns[1], [10]);
	writeFileSync(path, "x,y\n1,999\n");
	const second = readCsv({ $csv: path });
	assert.notEqual(second, first);
	assert.deepEqual(second.columns[1], [999]);
});
```

`writeFileSync` is already imported in that file.

2. Injected reader, same fake path, two bodies. The second call must see the second body:

```ts
test("an injected readFile is not reused for a later call", () => {
	const first = readCsv({ $csv: "mem.csv" }, { readFile: () => "n\n1\n" });
	const second = readCsv({ $csv: "mem.csv" }, { readFile: () => "n\n2\n" });
	assert.deepEqual(first.columns[0], [1]);
	assert.deepEqual(second.columns[0], [2]);
});
```

3. Render reuse. `renderChart` is already imported. Same `name`, same `$csv` call, file rewritten to a different length. The PNG paths must differ (the filename hash covers the expanded numbers):

```ts
test("renderChart picks up a rewritten csv instead of reusing the png", () => {
	const path = write("live.csv", "x,y\n1,10\n2,20\n");
	const calls = [["plot", [{ $csv: path, x: "x", y: "y" }]]] as never;
	const first = renderChart({ name: "live", calls }, dir);
	writeFileSync(path, "x,y\n1,1000\n2,2000\n");
	const second = renderChart({ name: "live", calls }, dir);
	assert.notEqual(first.pngPath, second.pngPath);
});
```

**Verify**: `node --import tsx --test test/data.test.ts` → all pass, including the previous cache-identity test and these three.

## Test plan

- File: `test/data.test.ts`. Pattern: the existing `readCsv` tests and the `renderChart` CSV test at the bottom of that file.
- Cases: unchanged file keeps object identity (already there); rewritten file returns new rows; injected `readFile` is not cached; `renderChart` with the same name writes a new PNG after the CSV changes.
- Verification: `node --import tsx --test test/data.test.ts`, then `npm run check`.

## Done criteria

ALL must hold:

- [ ] `node --import tsx --test test/data.test.ts` exits 0
- [ ] `npm run check` exits 0
- [ ] The 70_000-row test still asserts object identity and still passes
- [ ] `git status` shows modifications only under `data.ts`, `test/data.test.ts`, and the status row in `plans/README.md`
- [ ] `plans/README.md` status row for 002 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- `readCsv` or `DataRefOptions` no longer matches the excerpts.
- Keeping object identity for an unchanged file requires re-reading and re-hashing the body. Do not do that.
- `statSync` on a missing path is the only way you can see to satisfy `cannot read`. `readDataFile` already throws that error; let it.
- The size check or `$json` seems like it must change for these tests to pass.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A same-size rewrite inside one filesystem timestamp tick can still hit the cache. The tests use a different byte length on purpose. If renders ever need stronger freshness, add a content hash only as a miss-path check, not as a read on every series.
- Reviewers should check that `options.readFile` neither stats nor caches, and that the cache key includes `mtimeMs` and `size`.
- The 32 MB cap is intentionally still after the read. Do not "fix" it here.
