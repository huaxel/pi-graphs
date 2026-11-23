# Changelog

## 0.1.0 — 2026-11-23

First release. `mpl_render` draws matplotlib-style charts from a JSON call list through
[mpl](https://github.com/ivarvong/mpl), as a Pi codemode tool or a plain function.

**Rendering**
- PNG (hi-dpi, scale 0.25–4), SVG, self-contained HTML with a crosshair/tooltip client, and terminal
  charts (`format: "ansi"`) as braille cells with box-drawing rules and real labels.
- Charts land in `~/.pi/agent/work/charts/<date>/` as `<slug>-<spec hash>`; an identical spec reuses
  its files, and the spec is saved beside them.
- `from: <saved spec>` re-renders a chart with overrides — restyle for a document without rewriting
  the calls; data references are re-read.
- Grids (sharex/sharey, ratios), twin axes, `sca`, figure-level calls, `fig.colorbar`.

**Styling**
- Themes: the bundled `catppuccin-macchiato` layout, plus mpl's bundled styles and `default`.
- Precedence, last wins: injected Pi theme rc → palette (`okabe-ito`, `tableau`) → caller `rc`.
- Saved specs never bake in the Pi theme, so a later `from` + `theme` restyles cleanly.

**Data**
- `{"$csv": path}` expands to positional `[x, y]`, one series per call; `{"column": name}` for a
  single column in `hist` or a kwarg such as `{ yerr }`. Delimiters `, ; \t |`, RFC 4180 quoting,
  headerless files, per-column type inference (numbers, ISO dates, strings).
- `{"$json": path}` for any JSON value; `{"$dates": [...]}`, `{"$date": "..."}`, `{"$float": "nan"}`.
- CSV parses are cached on path, mtime, size, and options — a rewritten file is re-read.

**Limits**
- 250 calls and 400k data points per chart, refused before any drawing.
- Data files over 32 MB are refused before they are read, by stat when the file is on disk.

**Commands**
- `/charts` lists the last week's charts and renders the picked one; `/charts prune [days]` deletes
  day folders after a confirmation that counts the folders it will remove.

**Earlier fixes folded into this release**
- Terminal charts use each series' stroke colour, not white.
- CSV charts pick up a rewritten file instead of reusing the old PNG.
- Tool instructions describe the one-series CSV parser, including the rejected multi-column `y`.
- Palette, caller `rc`, and saved specs follow one precedence, with no Pi theme baked into the JSON.
- Oversized data refused before it is loaded; the point budget counts date columns and kwargs.
- Terminal charts keep axis labels (x label on its own row, rotated y labels reading bottom to top)
  and grid panels stay transparent.
- CSV column specs must be whole indices and cannot combine `column` with `x`/`y`.
- Unsupported `format` values throw instead of writing only a spec file.
