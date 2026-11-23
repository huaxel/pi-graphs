# Plan 004: Palette, caller rc, and saved specs follow one precedence

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a8b5b60..HEAD -- index.ts render.ts test/mpl.test.ts test/render.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> `index.ts` may already contain the CSV instruction wording from plan 003.
> Keep that wording. This plan does not edit `mplInstructions`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-csv-instruction-contract.md (same file `index.ts`; instruction text must survive)
- **Category**: bug
- **Planned at**: commit `a8b5b60`, 2026-11-23

## Why this matters

Three documented rules are one merge, and the code has two different merges:

1. Palette replaces the theme's series cycle. An explicit `rc["axes.prop_cycle"]` wins over the palette. `render.ts` says this in a comment, and `mplInstructions` says it.
2. Omitting `theme` paints with the active Pi theme. Passing `theme` or `rc` is how a caller opts out.
3. The JSON next to a chart is the spec as written, so `from` plus `theme: "pro-slate"` restyles it.

What happens today, through `toMplRenderToolDefinition` with a Pi theme context:

- `palette: "okabe-ito"` still draws the Pi accent `#58a6ff`. The tool copies the Pi cycle into `rc` before `renderChart` spreads that `rc` over the palette.
- `format: "ansi"` with no `theme` uses the Pi rc and drops the caller's `rc`. A requested `text.color` of `#ff00aa` renders as the theme text `#e6edf3` (`230;237;243`).
- The spec JSON stores the injected Pi keys (`figure.facecolor`, `axes.prop_cycle`, and the rest). `from` plus `theme: "pro-slate"` still draws `#58a6ff`, because those keys ride along as caller rc.

Pixels must use the merged rc. The file on disk must stay the caller's spec. Specs already saved with baked-in Pi keys are left alone; this plan does not migrate them.

## Current state

`index.ts` `execute`, inside `toMplRenderToolDefinition`:

```ts
const input = withSavedSpec(params as MplRenderParams);
if (input.format === "ansi") {
	const colors = ctx?.ui?.theme?.colors;
	const paletteCycle = input.palette && input.palette !== "theme" ? MPL_PALETTES[input.palette] : undefined;
	const rc = {
		...(paletteCycle && { "axes.prop_cycle": paletteCycle }),
		...(input.theme === undefined ? piThemeRc(colors) : (input.rc ?? {})),
	};
	const spec = expandDataRefs({ ...input, rc });
	const chart = renderAnsiChart({ calls: spec.calls, rc: spec.rc ?? {}, /* style, grid, cols */ });
	// returns text, no files
}
const piRc = input.theme === undefined ? piThemeRc(ctx?.ui?.theme?.colors) : {};
const themedInput: MplRenderInput =
	Object.keys(piRc).length > 0 ? { ...input, rc: { ...piRc, ...input.rc } } : input;
const out = renderChart(themedInput, outDir?.());
```

`piThemeRc` (same file) maps Pi colour tokens onto rc keys: transparent facecolors, text, muted labels, border, grid at `${borderMuted}8c`, and `axes.prop_cycle` from accent, success, warning, error, mdLink, and the syntax tokens. It returns `{}` when `colors` is missing. Keep `piThemeRc` as it is.

`render.ts` `renderChart` then merges palette under the rc it was given, and writes `input` to disk:

```ts
// Explicit rc wins over the palette cycle, which wins over the theme's own cycle.
const rc = paletteCycle ? { "axes.prop_cycle": paletteCycle, ...spec.rc } : spec.rc;
// ...
const stem = `${slugOf(spec.name)}-${specDigest(spec, theme, scale, format)}`;
// specDigest hashes spec.rc, along with calls, theme, scale, format, grid, palette, interactive
// ...
writeFileSync(specPath, `${JSON.stringify({ ...input, renderedAt: new Date().toISOString() }, null, 2)}\n`);
```

`specDigest` hashes `spec.rc`. If the saved document stops carrying the Pi rc but the hash still sees only the caller's rc, two Pi themes with the same calls share one PNG. The hash has to see the rc that was actually drawn. The JSON must not.

`renderChart(input, outDir = defaultChartDir(), dataOptions = {})` is called from tests with `(input, dir)` and from the tool with `(themedInput, outDir?.())`. A new trailing argument with a default keeps those calls compiling.

Existing tests that must stay green without edited assertions:

- `test/render.test.ts` "palettes replace the series cycle" calls `renderChart` directly (no Pi rc) and expects the Okabe-Ito hex in the SVG.
- `test/render.test.ts` "withSavedSpec reloads a saved chart" calls `renderChart` directly with `theme: "pro-dark"`.
- `test/mpl.test.ts` "the tool applies Pi UI Theme Color objects and honors explicit theme overrides" expects `#e6edf3`, `#58a6ff`, grid `#30363d` at about half opacity, PNG corner alpha 0, and a `pro-slate` SVG that does not contain `#11131a`. The mock accent is `#58a6ff`.

Okabe-Ito's first colour is `#56B4E9` (`MPL_PALETTES["okabe-ito"][0]`).

Repo conventions: tabs, strict TypeScript, `.ts` import suffixes, `node:test` + `node:assert/strict`. Do not reformat. Do not edit `mplInstructions` in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Tool tests | `node --import tsx --test test/mpl.test.ts` | all pass, exit 0 |
| Render tests | `node --import tsx --test test/render.test.ts` | all pass, exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:

- `render.ts` — one rc resolver; `renderChart` takes injected rc separately from the saved spec; the digest uses the resolved rc
- `index.ts` — `execute` only (both the ansi branch and the file branch). Not `mplInstructions`, not `piThemeRc`, not `/charts`
- `test/mpl.test.ts` — new tests
- `test/render.test.ts` — only if a direct `renderChart` assertion needs a new case for "caller rc beats palette". Prefer `test/mpl.test.ts` for tool behaviour

**Out of scope**:

- `ansi.ts` colour lookup. Terminal series marks can stay white until that plan lands. This plan's ANSI assertion is about `axes.titlecolor` on the title text node, not a polyline stroke.
- Stripping Pi keys out of JSON files already on disk.
- `withSavedSpec`'s merge rules. Overrides already replace saved fields.
- Changing `piThemeRc`'s key list or the transparent-facecolor behaviour.

## Git workflow

- Branch: `advisor/004-theme-rc-and-saved-spec`
- One commit, or two if the resolver lands before the tool is switched onto it. Messages in the repo's style, for example: `Keep saved chart specs free of the Pi theme`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `resolveRc` and use it for pixels and the hash

Export this from `render.ts`. Unknown palette must throw the same error string `renderChart` throws today (`unknown palette "<name>"; use theme, okabe-ito, tableau`).

```ts
export function resolveRc(
	input: Pick<MplRenderInput, "theme" | "rc" | "palette">,
	injectedRc: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	const paletteCycle = input.palette && input.palette !== "theme" ? MPL_PALETTES[input.palette] : undefined;
	if (input.palette && input.palette !== "theme" && !paletteCycle) {
		throw new Error(`unknown palette "${input.palette}"; use ${["theme", ...Object.keys(MPL_PALETTES)].join(", ")}`);
	}
	const themeRc = input.theme === undefined ? injectedRc : {};
	return {
		...themeRc,
		...(paletteCycle ? { "axes.prop_cycle": [...paletteCycle] } : {}),
		...input.rc,
	};
}
```

Precedence, top wins: caller `rc`, then palette `axes.prop_cycle`, then `injectedRc`, and only when `theme` is omitted. An explicit `theme` ignores `injectedRc`. Spreading a missing `input.rc` is a no-op; do not special-case it.

`renderChart` gains an optional fourth parameter `injectedRc: Readonly<Record<string, unknown>> = {}`. Replace the inline palette block with `const rc = resolveRc(input, injectedRc)`. Pass that `rc` into `buildFigure`, `pageBackground`, and the object `specDigest` hashes. Hash the resolved rc, not `input.rc`:

```ts
const rc = resolveRc(input, injectedRc);
const stem = `${slugOf(spec.name)}-${specDigest({ ...spec, rc }, theme, scale, format)}`;
```

Keep writing the caller's `input` to the spec JSON, including the caller's own `rc` when they passed one. Do not write `injectedRc` into that JSON. Do not write the resolved rc into that JSON.

Direct `renderChart` callers pass no fourth argument, so `injectedRc` is `{}`. Palette-only behaviour for those callers stays.

**Verify**: `node --import tsx --test test/render.test.ts` → exit 0. The palette test, the unknown-palette throw, and the saved-spec round trip still pass.

### Step 2: Use `resolveRc` from the tool, and stop baking Pi rc into the spec

In `execute`:

- Compute `const injected = piThemeRc(ctx?.ui?.theme?.colors);` once.
- ANSI: `expandDataRefs(input)` on the original input. Pass `rc: resolveRc(input, injected)` into `renderAnsiChart`. Do not spread `injected` or the palette into `input.rc`. Do not pass `input.theme === undefined ? piThemeRc : input.rc`.
- Files: `renderChart(input, outDir?.(), {}, injected)`. The third argument stays the default data options. The fourth is the Pi rc.

Delete the local palette/`rc` objects in `execute`. `MPL_PALETTES` can stay imported if something else in `index.ts` still uses it; if the import becomes unused, remove it. `resolveRc` is imported from `./render.ts`.

**Verify** with a temp directory (this script is the behaviour the permanent test must encode). It must print `rc merge ok` and exit 0:

```bash
node --import tsx -e '
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseColor } from "@earendil-works/pi-tui";
import { toMplRenderToolDefinition } from "./index.ts";
import { MPL_PALETTES } from "./render.ts";
const dir = mkdtempSync(join(tmpdir(), "pi-rc-"));
const tool = toMplRenderToolDefinition(() => dir);
const ctx = { ui: { theme: { colors: {
  text: parseColor("#e6edf3"), muted: parseColor("#8b949e"), borderMuted: parseColor("#30363d"),
  accent: parseColor("#58a6ff"), success: parseColor("#3fb950"), warning: parseColor("#d29922"),
  error: parseColor("#f85149"), mdLink: parseColor("#a371f7"), syntaxFunction: parseColor("#79c0ff"),
  syntaxNumber: parseColor("#ffa657"), syntaxKeyword: parseColor("#ff7b72"),
}}}};
const calls = [["plot", [[1, 2, 3], [3, 1, 2]], { label: "s" }], ["set_title", ["T"]]];
const fail = (m) => { console.error(m); process.exit(1); };
const pal = await tool.execute("1", { name: "pal", format: "svg", palette: "okabe-ito", calls }, undefined, undefined, ctx);
const palSvg = readFileSync(pal.structuredContent.svgPath, "utf8").toLowerCase();
if (!palSvg.includes(MPL_PALETTES["okabe-ito"][0].toLowerCase())) fail("palette missing");
if (palSvg.includes("#58a6ff")) fail("palette lost to pi accent");
const spec = JSON.parse(readFileSync(pal.structuredContent.specPath, "utf8"));
if (spec.rc) fail("injected rc was saved: " + Object.keys(spec.rc).join(","));
const custom = await tool.execute("2", { name: "custom", format: "svg", palette: "okabe-ito", rc: { "axes.prop_cycle": ["#ff00aa"] }, calls }, undefined, undefined, ctx);
const customSvg = readFileSync(custom.structuredContent.svgPath, "utf8").toLowerCase();
if (!customSvg.includes("#ff00aa")) fail("caller rc lost");
const saved = JSON.parse(readFileSync(custom.structuredContent.specPath, "utf8"));
if (saved.rc?.["axes.prop_cycle"]?.[0] !== "#ff00aa") fail("caller rc was not saved");
if (saved.rc?.["figure.facecolor"]) fail("pi facecolor was saved");
const again = await tool.execute("3", { from: pal.structuredContent.specPath, theme: "pro-slate", name: "restyle", format: "svg" }, undefined, undefined, ctx);
const restyle = readFileSync(again.structuredContent.svgPath, "utf8").toLowerCase();
if (restyle.includes("#58a6ff")) fail("restyle kept pi accent");
const ansi = await tool.execute("4", { format: "ansi", cols: 60, rc: { "axes.titlecolor": "#ff00aa" }, calls }, undefined, undefined, ctx);
if (!ansi.content[0].text.includes("255;0;170")) fail("ansi dropped caller axes.titlecolor");
console.log("rc merge ok");
rmSync(dir, { recursive: true, force: true });
'
```

Expected: exit 0 and `rc merge ok`.

### Step 3: Make the script's checks permanent

Add one test to `test/mpl.test.ts`, next to the existing theme test. Reuse that test's `parseColor` mock (accent `#58a6ff`, text `#e6edf3`). Cover all four cases from the script: palette beats the Pi cycle, caller `axes.prop_cycle` beats the palette and is what the JSON stores, the JSON from a palette render has no `rc`, `from` + `theme: "pro-slate"` does not contain `#58a6ff`, and ANSI `axes.titlecolor: "#ff00aa"` emits `255;0;170`.

Use `axes.titlecolor`, not `text.color`, for the ANSI case. `piThemeRc` sets both keys, and mpl resolves a title from `axes.titlecolor` even when the style already sets one, so only the title-specific key proves the caller's rc survived. `text.color` alone leaves the title on the injected colour.

Use `toMplRenderToolDefinition(() => outDir)` and the file's existing `outDir`. Do not weaken the existing theme test. If it fails because `#58a6ff` disappeared from a default-theme SVG, the injected rc is no longer reaching the figure. Fix `resolveRc` / the tool call. Do not edit that test's colour assertions.

**Verify**: `node --import tsx --test test/mpl.test.ts test/render.test.ts` → exit 0. Then `npm run check` → exit 0.

## Test plan

- New tool-level test in `test/mpl.test.ts`, patterned on "the tool applies Pi UI Theme Color objects".
- Direct `renderChart` palette and `withSavedSpec` tests stay as they are.
- Cases: palette over Pi cycle; caller `rc` over palette; saved JSON omits injected keys and keeps caller keys; `from` + explicit theme drops the Pi accent; ANSI honours caller `axes.titlecolor` when `theme` is omitted; unknown palette still throws (existing test).
- Verification: `node --import tsx --test test/mpl.test.ts test/render.test.ts`, then `npm run check`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] The step 2 script prints `rc merge ok`
- [ ] `test/mpl.test.ts` contains assertions for `MPL_PALETTES["okabe-ito"][0]` (`#56B4E9`), absence of saved `figure.facecolor` on a theme-less render, and ANSI `255;0;170`
- [ ] `git diff --stat -- index.ts` does not show a rewrite of `mplInstructions` (a few import lines are expected)
- [ ] `git status` shows modifications only under `index.ts`, `render.ts`, `test/mpl.test.ts`, `test/render.test.ts` (only if you had to add a direct-call test), and the status row in `plans/README.md`
- [ ] `plans/README.md` status row for 004 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- The `execute` merge or the `renderChart` save no longer matches the excerpts, and plan 003's instruction edits do not explain the difference.
- The existing Pi-theme test loses `#58a6ff` or a transparent PNG corner. Do not update that test to match a regression.
- Restyle only works if you delete keys from JSON that a previous render already wrote. Old files keep their baked rc. Do not add a strip list.
- `specDigest` would ignore the resolved rc. File reuse would then hand back the wrong pixels.
- ANSI series braille is white and that tempts you to edit `ansi.ts`. Text colour is the assertion for this plan. Leave the scene walker alone.
- You need to change `piThemeRc` or `withSavedSpec` to make the script pass.

## Maintenance notes

- Any new layer (a user stylesheet, a high-contrast override) has to enter `resolveRc` in one place. The tool should not pre-merge rc before `renderChart`, or the saved spec will start baking it again.
- The filename hash includes the resolved rc, so a Pi theme change produces a new file even though the JSON does not store that theme. That is intentional.
- Reviewers should open one spec JSON from the new test and confirm the Pi keys are absent, then confirm the SVG from that same render still contains the Pi accent when no palette was requested.
- Charts saved before this change still have Pi keys in their JSON. `from` plus a new theme will not fully restyle those files. Re-render from the original calls to get a clean spec. No migration in this plan.
