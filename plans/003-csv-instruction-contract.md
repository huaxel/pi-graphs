# Plan 003: Tool instructions match the one-series CSV parser

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a8b5b60..HEAD -- index.ts README.md test/instructions.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. `test/instructions.test.ts` is
> absent at the planned commit; that part of the diff being empty is expected.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `a8b5b60`, 2026-11-23

## Why this matters

The agent reads `mplInstructions` from `describeNamespace("mpl")` and builds the chart spec from that text. The text says a CSV `y` array expands to every series, and that omitting `x` and `y` plots the rest of the columns. The parser does neither. A multi-column `y` throws. A wide file with no `x` or `y` plots column 0 against column 1 and drops the rest, with no error. The model then thinks the chart contains series that were never drawn. The README's "next two are y candidates" describes a third behaviour. The parser and its test are the contract. This plan makes both documents say what the parser does.

## Current state

The contract, implemented in `data.ts` `csvArgs` and locked by `test/data.test.ts` ("one column per series"):

- `{ $csv, x, y }` with a single `y` column becomes positional `[x, y]`. One series per call. A second series is a second call.
- `y` as an array of two or more columns throws `{$csv} y takes one column, got N; make one call per series`.
- `{ $csv, column }` is one column, including when it sits in a kwarg such as `yerr`.
- With neither `x` nor `y`: a one-column file is that column; a wider file is `[column 0, column 1]`. Later columns are not read.

Do not change that behaviour.

What the model actually reads (`index.ts`, the `mplInstructions` template, data-files bullets):

```text
- {"$csv": "path", "x": "date", "y": ["revenue", "cost"]} is one positional argument that expands to [x, y1, y2]; columns are read by header name (or index).
- {"$csv": "path", "column": "revenue"} is that column alone, for hist or a kwarg such as { yerr: {"$csv": ..., "column": "err"} }.
- Without x or y the first column is x and the rest are series. {"header": false} reads headerless files; ...
```

README.md, "Data references", the third bullet:

```text
- Column selection is by header name or index. Without `x` or `y`, the first column is x and the
  next two are y candidates.
```

The bullets above that one already say one series per call. Leave them.

`mplInstructions` is `export const mplInstructions` in `index.ts`. The rest of that string (themes, dates, limits, gotchas) is accurate enough. Do not rewrite it.

Repo conventions: tabs in `index.ts`. README prose is wrapped near 100 characters. Tests use `node:test` and `node:assert/strict`. A new test file is loaded automatically because `package.json` runs `node --import tsx --test test/*.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Instruction test | `node --import tsx --test test/instructions.test.ts` | all pass, exit 0 |
| Full gate | `npm run check` | exit 0 |
| Stale phrases | `grep -n -E 'y1, y2|the rest are series|y candidates' index.ts README.md` | exit 1, no matches |

## Scope

**In scope**:

- `index.ts` — only the CSV bullets inside `mplInstructions`
- `README.md` — only the "next two are y candidates" bullet
- `test/instructions.test.ts` — create

**Out of scope**:

- `data.ts` and `test/data.test.ts`. The parser is the source of truth.
- Any other sentence in `mplInstructions` (palette, `from`, `$float`, limits).
- The tool's `execute` function, theme rc, and output schema.

## Git workflow

- Branch: `advisor/003-csv-instruction-contract`
- One commit. Message: `Describe CSV charts as one series per call`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rewrite the two instruction bullets and the README bullet

Replace the `y: ["revenue", "cost"]` bullet and the "rest are series" clause. Keep the `column` bullet. Keep the header / parse / NaN sentence that currently shares a line with "the rest are series"; move it so it stays.

`mplInstructions` must state all of the following in the data-files section, in words a model can follow:

- `{"$csv": "path", "x": "date", "y": "revenue"}` expands to positional `[x, y]`. `y` is one column name or index. One series per call. A second series is a second `plot` call with its own `y`.
- `y` as a list of columns is rejected. Do not show `y: ["revenue", "cost"]` as a working example.
- `{"$csv": "path", "column": "revenue"}` is that column alone, for `hist` or a kwarg such as `yerr`.
- Without `x` or `y`, a one-column file is that column, and a wider file is column 0 against column 1. Further columns are not plotted; name them with `x` and `y`.

README, replace the "y candidates" bullet with the same default: without `x` or `y`, a one-column file is that column, and a wider file is the first column against the second. Further columns are not plotted.

**Verify**: `grep -n -E 'y1, y2|the rest are series|y candidates' index.ts README.md` → no output, exit 1.

### Step 2: Test the string the model reads

Create `test/instructions.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mplInstructions } from "../index.ts";

test("mpl instructions match the one-series csv parser", () => {
	assert.match(mplInstructions, /one series per call/i);
	assert.match(mplInstructions, /column 0 against column 1|first column against the second/i);
	assert.doesNotMatch(mplInstructions, /y1, y2/);
	assert.doesNotMatch(mplInstructions, /the rest are series/);
	assert.doesNotMatch(mplInstructions, /"revenue", "cost"/);
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.doesNotMatch(readme, /y candidates/);
	assert.match(readme, /first column against the second/);
});
```

If the wording you chose in step 1 does not match these patterns, change the wording to match the patterns. Do not weaken the assertions.

**Verify**: `node --import tsx --test test/instructions.test.ts` → pass. Then `npm run check` → exit 0.

## Test plan

- New file `test/instructions.test.ts`, as in step 2.
- It imports `mplInstructions` and reads `README.md` from disk. No chart rendering.
- Verification: `node --import tsx --test test/instructions.test.ts` and `npm run check`.

## Done criteria

ALL must hold:

- [ ] `grep -n -E 'y1, y2|the rest are series|y candidates' index.ts README.md` finds nothing
- [ ] `node --import tsx --test test/instructions.test.ts` exits 0
- [ ] `npm run check` exits 0
- [ ] `data.ts` is unmodified (`git diff --stat -- data.ts` is empty)
- [ ] `git status` shows modifications only under `index.ts`, `README.md`, `test/instructions.test.ts`, and the status row in `plans/README.md`
- [ ] `plans/README.md` status row for 003 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- `csvArgs` no longer rejects a multi-column `y`, or no longer returns only the first two columns when `x` and `y` are omitted. The documents would be describing a different parser. Stop and report the new behaviour.
- Matching the test patterns seems to require editing `data.ts`.
- `mplInstructions` is no longer a single exported template string.

## Maintenance notes

- The model trusts `mplInstructions` over the README. When `csvArgs` changes, update this string in the same commit. The new test is what fails if the forbidden examples come back.
- Reviewers should check the data-files bullets against `csvArgs` in `data.ts`, not against matplotlib's own multi-series `plot(x, y1, y2)` form. This extension deliberately does not do that.
- Parser behaviour was not changed. Charts that already use one `y` column are unaffected.
