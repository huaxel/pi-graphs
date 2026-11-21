/**
 * Contract test for the mpl internals this extension depends on. mpl is pinned to a git commit; if a
 * bump drops one of these, this test fails instead of a runtime error in the tool.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Axes, availableStyles, Figure, parseTheme, registerColormaps, registerFonts, subplots } from "mpl";
import { renderRGBA, tracer } from "mpl/core";
import { allColormaps } from "mpl/colormaps/all";
import { allFonts } from "mpl/fonts/all";
import { MPL_AXES_METHODS, MPL_FIGURE_METHODS, MPL_SPECIAL_CALLS } from "../replay.ts";

registerFonts(...allFonts);
registerColormaps(...allColormaps);

test("the mpl entry points the extension imports still exist", () => {
	for (const fn of [subplots, availableStyles, parseTheme, registerFonts, registerColormaps, renderRGBA]) {
		assert.equal(typeof fn, "function");
	}
	assert.equal(typeof tracer.startTrace, "function");
	assert.ok(availableStyles().length > 0);
});

test("the Axes methods the spec relies on are on the prototype", () => {
	for (const name of ["plot", "bar", "barh", "scatter", "hist", "boxplot", "errorbar", "fill_between", "imshow", "text", "annotate", "twinx"]) {
		assert.equal(typeof (Axes.prototype as unknown as Record<string, unknown>)[name], "function", name);
	}
	for (const name of ["text", "suptitle", "subplots_adjust", "tight_layout", "colorbar"]) {
		assert.equal(typeof (Figure.prototype as unknown as Record<string, unknown>)[name], "function", name);
	}
});

test("the allow-lists still cover the documented surface", () => {
	for (const name of ["plot", "barh", "imshow", "annotate"]) assert.ok(MPL_AXES_METHODS.has(name), name);
	for (const name of ["suptitle", "colorbar", "subplots_adjust"]) assert.ok(MPL_FIGURE_METHODS.has(name), name);
	assert.deepEqual([...MPL_SPECIAL_CALLS], ["sca", "twinx", "$concise_x", "$date_x"]);
});

test("a figure still exposes the scene and serialisers render.ts uses", () => {
	const [fig] = subplots({} as never) as [Figure, unknown];
	assert.equal(typeof fig.toScene, "function");
	assert.equal(typeof fig.toSVG, "function");
	assert.equal(typeof fig.toPNGSync, "function");
	const scene = fig.toScene();
	assert.equal(typeof scene.width, "number");
	assert.ok(Array.isArray(scene.nodes));
});
