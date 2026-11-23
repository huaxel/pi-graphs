# Plan 001: Terminal line charts use the series colour

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a8b5b60..HEAD -- ansi.ts test/ansi.test.ts`
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

`format: "ansi"` is the chart the agent gets in terminals that cannot show images. Line series are drawn as braille, and today every one of those marks is white (`38;2;255;255;255`), so two series cannot be told apart. mpl already puts the series colour on the polyline. The reader looks up a field that polylines do not have and falls through to `#ffffff`. Spines, grid, labels, and bar fills take other paths and already keep their colours. After this change, a line chart's braille uses `axes.prop_cycle`.

## Current state

- `ansi.ts` — scene-to-terminal renderer. `sceneToCells` walks mpl scene nodes. `renderAnsiChart` turns cells into ANSI lines.
- `test/ansi.test.ts` — structural tests (braille, spines, bar blocks, budget). The `lines` helper already passes `axes.prop_cycle: ["#d6a6ff", "#9fe3b1"]`. No test checks that colour.

A line scene node looks like this (confirmed against mpl at the pinned commit):

```json
{ "kind": "polyline", "stroke": { "color": { "hex": "#58a6ff", "alpha": 1 }, "width": 2.22 } }
```

There is no `ink` on that node, and `stroke.hex` is absent. The colour is `stroke.color.hex`.

A scatter marker node is different and already works: `{ "kind": "markers", "ink": { "fill": { "hex": "#d6a6ff" } } }`. The current expression reaches `ink.fill.hex`. Leave that path in place.

The reader today (`ansi.ts:186-191`):

```ts
// Path inks nest the colour as ink.stroke.color.hex; fills use ink.fill.hex.
const ink = node.ink as { stroke?: { color?: Rgb; width?: number }; fill?: Rgb } | undefined;
const paint = (node.stroke as Rgb | undefined)?.hex ?? ink?.stroke?.color?.hex ?? ink?.fill?.hex ?? "#ffffff";
const hex = paint.slice(0, 7).toLowerCase();
// Hairlines are rules (grid, spines, ticks) whatever the theme; series strokes are heavier.
const strokeWidth = (node.stroke as { width?: number } | undefined)?.width ?? ink?.stroke?.width ?? 0;
```

`strokeWidth` already reads `stroke.width`, which polylines have. Only the colour lookup is wrong. `#d6a6ff` is rgb `214,166,255`, so a correct line emits `38;2;214;166;255`.

Repo conventions: indent with tabs, as `ansi.ts` does. Tests use `node:test` and `node:assert/strict`. Imports use the `.ts` suffix. Match the comment voice already in `ansi.ts` (one sentence on why). Do not add a formatter or reindent the file.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `npm install` | exit 0, only if `node_modules` is missing |
| One file | `node --import tsx --test test/ansi.test.ts` | all pass, exit 0 |
| Full gate | `npm run check` | `tsc --noEmit` then the whole `test/*.test.ts` suite, exit 0 |

`npm test` ignores extra path arguments. Use the `node --import tsx --test <file>` form to run one file.

## Scope

**In scope** (the only files you should modify):

- `ansi.ts`
- `test/ansi.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `index.ts` — theme / palette / `rc` merging is a separate plan. This plan only fixes colour lookup inside the scene walker.
- `replay.ts`, `render.ts` — the scene mpl produces is already correct.
- Bar-fill handling (`node.kind === "rect"`) and the thin-rule / spine logic. Those colours already come from path ink.

## Git workflow

- Branch: `advisor/001-ansi-series-color`
- One commit once the done criteria pass. Message style from this repo: an imperative sentence, no conventional-commit prefix. Example: `Reject malformed quoted CSV fields`. A fitting message: `Use polyline stroke colours in terminal charts`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read series colour from `stroke.color.hex`

In `sceneToCells`, replace the colour lookup so a stroke object of either shape works. Keep `stroke.width` as the width source.

Target shape:

```ts
const ink = node.ink as { stroke?: { color?: Rgb; width?: number }; fill?: Rgb } | undefined;
const stroke = node.stroke as { hex?: string; color?: Rgb; width?: number } | undefined;
const paint = stroke?.color?.hex ?? stroke?.hex ?? ink?.stroke?.color?.hex ?? ink?.fill?.hex ?? "#ffffff";
const hex = paint.slice(0, 7).toLowerCase();
const strokeWidth = stroke?.width ?? ink?.stroke?.width ?? 0;
```

Lookup order is load-bearing: polyline colour lives on `stroke.color.hex`; some nodes may carry `stroke.hex`; path rules use `ink.stroke.color.hex`; marker fills use `ink.fill.hex`. Update the comment above the lookup so it names polylines (`stroke.color.hex`) as well as path ink.

**Verify** from the repo root:

```bash
node --import tsx -e '
import { renderAnsiChart } from "./ansi.ts";
const chart = renderAnsiChart({
  cols: 70,
  rc: { "axes.prop_cycle": ["#d6a6ff"] },
  calls: [["plot", [[1, 2, 3, 4], [10, 30, 20, 40]]]],
});
const text = chart.lines.join("\n");
const hit = text.split(/\x1b\[0m/).some((part) => /38;2;214;166;255m/.test(part) && /[⠀-⣿]/.test(part));
if (!hit) { console.error("series colour missing from braille"); process.exit(1); }
console.log("series colour ok");
'
```

Expected: exit 0 and the line `series colour ok`.

### Step 2: Lock the colour in with tests

Add two tests to `test/ansi.test.ts`, using the existing `lines` helper. `#d6a6ff` is the first entry of that helper's `axes.prop_cycle`.

1. Line chart: a plot of four points emits `38;2;214;166;255` on a chunk that also contains a braille glyph (`[⠀-⣿]`). Split `chart.lines.join("\n")` on `\x1b[0m` the same way as the step 1 script.
2. Scatter regression: `["scatter", [[1, 2, 3, 4], [10, 30, 20, 40]]]` still emits `38;2;214;166;255`. Markers were already coloured via `ink.fill`; this fails if the new lookup skips that fallback.

Model the assertions on the bar test in the same file (`chart.lines.join("\n")` and `assert.match`).

**Verify**: `node --import tsx --test test/ansi.test.ts` → all tests pass, including the two new ones. The existing spine, label, bar, budget, and width tests still pass.

## Test plan

- New tests live in `test/ansi.test.ts`.
- Pattern: the `lines` helper and `assert.match` calls already in that file.
- Cases: polyline series colour reaches a braille cell; scatter markers still use the cycle colour.
- Verification: `node --import tsx --test test/ansi.test.ts` then `npm run check`.

## Done criteria

ALL must hold:

- [ ] `node --import tsx --test test/ansi.test.ts` exits 0
- [ ] `npm run check` exits 0
- [ ] A line chart rendered with `axes.prop_cycle: ["#d6a6ff"]` contains `38;2;214;166;255` on braille output
- [ ] `git status` shows modifications only under `ansi.ts`, `test/ansi.test.ts`, and the status row in `plans/README.md`
- [ ] `plans/README.md` status row for 001 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- The lookup at `ansi.ts` no longer matches the excerpt (drift).
- A polyline from `fig.toScene()` does not carry `stroke.color.hex`. Dump one node and stop; do not invent a second scene format.
- Step 1's script exits 1 after the lookup change. Do not recolour by drawing over the braille in a later pass.
- The bar-fill test or the spine glyphs break. That means the rect or thin-rule path was changed; revert that part.
- The fix appears to require editing `index.ts` or mpl.

## Maintenance notes

- mpl scene shapes differ by kind. Polylines use `stroke.color`. Paths use `ink.stroke.color`. Markers use `ink.fill`. A new kind needs its colour added to this same lookup, not a one-off in the marker loop.
- Reviewers should look at the lookup order and at the new test's escape (`214;166;255` is `#d6a6ff`, the fixture cycle, not a colour picked from a screenshot).
- Theme, palette, and caller `rc` precedence is a different change. This plan assumes the `rc` object that reaches `renderAnsiChart` is already the one that should be drawn.
