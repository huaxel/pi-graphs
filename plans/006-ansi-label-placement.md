# Plan 006: Terminal charts keep their axis labels and grid panels

> **Status**: implemented in the working tree, not committed. Verified with `npm run check` (56 tests).
>
> Written after the five merged plans, while re-checking them against `main`. The other plans do not
> touch `ansi.ts` text placement; plan 001 changed stroke colours only.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: nothing (001 touched `ansi.ts` series colours, a different block)
- **Category**: bug
- **Planned at**: commit `4a2212e`, 2026-11-23

## Why this matters

Three defects in `sceneToCells` (`ansi.ts`) were reachable with plain `format: "ansi"` calls:

1. **The x axis label was always dropped.** A text baseline near the scene bottom maps to row `rows`
   with `Math.round`, and `setCell` discards rows past the grid. `["set_xlabel", ["quarter"]]` never
   appeared at 60, 78, 100, or 200 columns; the tick labels owned the last row.
2. **A rotated y label read top to bottom and ran into the ticks.** Vertical text was drawn
   `row + i` (downward), so the letters came out reversed, and the label column landed flush against
   the tick labels (`r`, then `1.75` in the next column).
3. **Every Axes in a grid painted its facecolour.** The patch test was "rect area > 30% of the
   scene". One Axes is 78% and was treated as the box, but a two-panel grid is 27% per panel, so both
   panels took the fill branch: the chart came out as a field of `█` (so did `plain` output) and the
   spines disappeared under it.

All three are invisible in the PNG/SVG/HTML paths, which is why the earlier plans missed them.

## What changed

`ansi.ts` `sceneToCells`:

- **Row budget**: `rows = Math.max(8, Math.ceil(cols * height / width / 2) + 1)`. `ceil` keeps the
  partial bottom row and the spare row gives the label band below the axis its own line, so the
  bottom spine, the tick labels, and the x axis label stop sharing two rows.
- **Row mapping**: `Math.floor((y - 0.45 * sizePx) / rowPx)` instead of `Math.round`, clamped into
  `[0, rows - 1]`. Columns are clamped into `[0, cols - width]` the same way.
- **Crowded rows**: horizontal text is placed largest first (titles, then axis labels, then tick
  labels) and a label is dropped when its span would overwrite one already placed on that row, so a
  narrow grid shows fewer ticks instead of splicing words.
- **Rotated labels**: drawn upward from the anchor (`start - i`), clamped so the run starts inside the
  grid, and placed one column left of the leftmost horizontal label to keep a blank separator when
  the grid leaves room.
- **Axes patch**: detected by depth, not area — every artist sits inside a `group`/`collection`, so a
  rect at depth 0 is an Axes patch at any grid size. The patch sets `box` (spine and clamp reference)
  and is no longer painted: the terminal background shows through, matching the transparent PNG path.
  The old `findBox` pre-pass is gone; the walk finds the patch before the spines it draws.

`test/ansi.test.ts` gained three regressions: the x label owns a row below the ticks, the rotated
label reads bottom to top one column clear of the ticks, and a grid panel paints no background.

`README.md` "Terminal charts" mentions the label rows and the transparent surface.

## Verification

- `node --import tsx --test test/ansi.test.ts` → 10 pass
- `npm run check` → 56 tests pass, typecheck clean
- Manual checks: `cols` 40/60/70/78/200, a 1x2 and 2x2 grid, `bar`, `barh`, `hist`, `imshow`,
  `axhspan` (the band still paints; only depth-0 patches are skipped)

## Known limits

- At 40 columns the tick row and the x label can share a row; the label wins and the ticks under it
  are dropped. Below ~40 columns there is no room for both bands.
- A title longer than `cols` is still truncated at the grid edge. That matches what the figure itself
  would clip, and the fix would be to wrap, not to shrink.
- With several Axes, `box` is the last patch walked, so label clamping and spine detection use the
  last panel's rectangle. Enough for grids that share a label band; a per-Axes box would be the
  follow-up if per-panel labels start crowding.

## Maintenance notes

- `depth === 0` for an Axes patch depends on mpl nesting artists under a group. Check that assumption
  before upgrading `mpl` (the pin is `github:ivarvong/mpl#117503c`).
- Text priority is by `sizePx`; a new label style that must outrank an axis label needs a bigger
  size or an explicit ordering rule.
- `sceneToCells` is still the only place that maps scene pixels to rows and columns; keep the
  clamps there rather than in `renderAnsiChart`.
