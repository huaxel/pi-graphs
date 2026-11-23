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
