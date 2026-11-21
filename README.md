# pi-graphs

A Pi extension that draws matplotlib-style charts with [mpl](https://github.com/ivarvong/mpl), a
pixel-exact TypeScript port of matplotlib, and shows the PNG inline in the Pi transcript.

No Python, no headless browser, no native modules: the chart is rendered in-process from a JSON call
list.

```
["plot", [x, y, "o-"], { label: "throughput" }]   →   ~/.pi/agent/work/charts/2026-11-21/throughput-093012211.png
```

## Install

```sh
pi install npm:@juanbenjumea/pi-graphs
# or from a checkout
pi install /path/to/pi-graphs
```

Requires Node 24 and Pi 1.6 or newer. Run `/reload` after installing or after editing the extension:
Pi loads extension modules at startup.

## What it gives the agent

One codemode tool, `mpl_render`, in the `mpl` namespace. The agent reads `describeNamespace("mpl")`
once, then calls it with a spec:

```js
const r = await tools.mpl_render({
  name: "latency",
  calls: [
    ["plot", [dates, p95, "o-"], { label: "p95" }],
    ["plot", [dates, p50, "s--"], { label: "p50" }],
    ["$concise_x", []],
    ["set_ylabel", ["ms"]],
    ["legend", [], { loc: "upper left" }],
  ],
});
image(r.image);
```

## Commands

| Command | Effect |
| --- | --- |
| `/charts` | Pick from charts rendered in the last 7 days; the choice is shown in the transcript with its paths |
| `/charts 30` | Same, over the last 30 days |
| `/charts prune` | Delete chart folders older than 14 days, after a confirmation |
| `/charts prune 7` | Same, keeping a week |

The picker appends a TUI-only entry, so browsing charts adds nothing to the model's context. Pruning
never touches the current day.

## The spec

| Field | Meaning |
| --- | --- |
| `calls` | `[method, [positional args], { kwargs }]`, applied in order to the current Axes |
| `grid` | `{ rows, cols, sharex, sharey, width_ratios, height_ratios }`, row-major numbering |
| `theme` | omitted uses the active Pi theme's colors over the `catppuccin-macchiato` layout; or a style name such as `pro-slate`, `pro-dark`, `default` |
| `rc` | matplotlib rc keys, merged over the theme |
| `format` | `png` (default), `svg`, `both`, `html` (self-contained page with hover tooltips), or `ansi` (terminal chart, no file) |
| `scale` | PNG pixel multiplier, 0.25 to 4, default 2 (1440x840) |
| `name` | file stem, slugged |
| `palette` | `theme` (default), `okabe-ito`, or `tableau`; an explicit `rc["axes.prop_cycle"]` wins |
| `from` | path to a saved `<stem>.json`; re-renders that spec with the params you pass on top |

Pseudo-calls: `["sca", [i]]` picks an Axes, `["twinx", []]` adds a twin axis, `["$concise_x", []]`
uses `ConciseDateFormatter`, `["$date_x", [locator, kwargs, format]]` picks a locator, and
`fig.<method>` reaches the figure (`fig.suptitle`, `fig.colorbar`, ...).

Values: `{"$float": "nan|inf|-inf"}` is a float constant, `{"$date": "2026-01-01"}` and
`{"$dates": [...]}` are dates (naive ISO strings are read as UTC), and `{"$transform": "axes"}` is
`ax.transAxes`.

### Data references

Long series do not need to be pasted into the call:

```js
["plot", [{ $csv: "reports/latency.csv", x: "date", y: "p95" }], { label: "p95" }]
["plot", [{ $csv: "reports/latency.csv", x: "date", y: "p50" }], { label: "p50" }]
["hist", [{ $csv: "reports/latency.csv", column: "p95" }]]
["plot", [[1, 2, 3], [3, 1, 2]], { yerr: { $csv: "reports/latency.csv", column: "err" } }]
["plot", [{ $json: "reports/series.json" }]]
```

- `{$csv, x, y}` expands to one positional argument list of `[x, y]`; one series per call, as in
  matplotlib.
- `{$csv, column}` is a single column, for `hist` or a kwarg such as `yerr`.
- Column selection is by header name or index. Without `x` or `y`, the first column is x and the
  next two are y candidates.
- `header: false` reads headerless files, `parse: "number" | "date" | "string"` forces a type, and
  otherwise each column is inferred: numbers, ISO dates, else strings. Empty cells become `NaN` gaps.
- Comma, semicolon, tab, and pipe delimiters are detected; quoted fields may contain delimiters,
  newlines, and doubled quotes.
- Relative paths resolve against the working directory, `~` expands to the home directory, and files
  over 32 MB are refused.

### Files

Every render writes `<slug>-<spec hash>.png` and, next to it, `<slug>-<spec hash>.json` holding the
spec as written. The hash covers calls, theme, rc, grid, scale, format, and palette, so rendering the
same chart twice reuses the existing files instead of piling up duplicates, and any change gets a new
name.

Re-rendering is a one-liner, which is what makes charts durable artifacts:

```js
await tools.mpl_render({ from: "~/.pi/agent/work/charts/2026-11-21/latency-4e1cbb8cb9.json", theme: "pro-slate", name: "latency-for-doc" });
```

`$csv` and `$json` references are re-read on every render, so a re-rendered chart reflects the current
file contents. Pass `calls` directly to pin the numbers.

Limits: 250 calls and 400k data points per chart, and `scale` between 0.25 and 4. These stop a runaway
spec from blocking the session.

### Terminal charts

`format: "ansi"` skips files and returns the chart as terminal rows: braille marks (2x4 dots per
cell), box-drawing rules, and the labels as real text. Bars fill with a background colour, so they
read as solid blocks, and `cols` sets the width (default 78).

It exists because Pi cannot show images under tmux, screen, Alacritty, VS Code, Zed, Windows
Terminal, or JetBrains terminals, and because a text chart can be pasted into an issue or a commit
message. It is a fallback, not a replacement: 78 columns is a 156x96 dot canvas against 1440x840
pixels for the PNG, so dense scatter plots and heatmaps stay images.

## Theming

The tool reads `ctx.ui.theme.colors` at call time and maps Pi theme tokens onto matplotlib rc keys:

| Pi token | rc keys |
| --- | --- |
| `text` | `text.color`, `axes.titlecolor`, `legend.labelcolor` |
| `muted` | `axes.labelcolor`, `xtick.labelcolor`, `ytick.labelcolor` |
| `borderMuted` | `axes.edgecolor`, `xtick.color`, `ytick.color`, and `grid.color` at 55% alpha |
| `accent`, `success`, `warning`, `error`, `mdLink`, `syntax*` | `axes.prop_cycle` |

No surface is painted (`figure.facecolor`, `axes.facecolor`, and `savefig.facecolor` are `none`), so
the PNG keeps its alpha and the chart sits on the terminal's own background. Pi does not expose that
background as a theme token, so transparency is the only way to match it. Pass `theme` explicitly, or
`rc` with a facecolor, to get an opaque chart for a document or a light background.

## Limitations

- mpl reproduces matplotlib's output, not its whole API. Unknown methods, kwargs, and rc keys throw;
  the error names the call index and the key.
- `errorbar` takes errors as kwargs (`{ yerr }`, `{ xerr }`), not as matplotlib's third positional
  argument.
- Text is limited to Latin, Greek, arrows, and math symbols.
- Images need a Kitty or iTerm2 graphics terminal. Under tmux, Alacritty, VS Code, Zed, Windows
  Terminal, or JetBrains terminals, Pi shows the file path instead.
- `mpl` is pinned to a git commit because this extension depends on internals (`toScene`, rc key
  names, `Figure`/`Axes` prototypes).

## Development

```sh
npm install
npm run check     # tsc --noEmit, then node --test
```

Layout:

| File | Role |
| --- | --- |
| `index.ts` | Pi tool definition, theme mapping, output encoding |
| `render.ts` | figure build, layout, PNG/SVG encoding, file naming |
| `replay.ts` | allow-listed spec interpreter over the mpl API |
| `data.ts` | `$csv` / `$json` resolution and CSV parsing |
| `ansi.ts` | scene-to-terminal-grid renderer for `format: "ansi"` |
| `gallery.ts` | chart folder listing and pruning behind `/charts` |
| `styles/` | bundled `.mplstyle` themes |

## License

MIT.
