/**
 * End-to-end: load index.ts through Pi's own extension loader, then drive the registered
 * tool and command the way the harness does. Catches registration, schema, and wiring bugs
 * that unit tests over renderChart cannot see.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";

const root = mkdtempSync(join(tmpdir(), "pi-mpl-load-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-mpl-agent-"));
process.env.PI_CHART_DIR = root;
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const entry = join(repoRoot, "index.ts");
after(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

/** Load index.ts through Pi's loader with a throwaway agent dir, so nothing else is picked up. */
const load = () => discoverAndLoadExtensions([entry], repoRoot, agentDir);

const theme = {
	colors: {
		toolPendingBg: parseColor("#202733"),
		text: parseColor("#f4f6fa"),
		muted: parseColor("#d0d7e2"),
		borderMuted: parseColor("#748197"),
		accent: parseColor("#d6a6ff"),
		success: parseColor("#9fe3b1"),
		warning: parseColor("#ffe08a"),
		error: parseColor("#ff9a9a"),
		mdLink: parseColor("#91c7ff"),
		syntaxFunction: parseColor("#91c7ff"),
		syntaxNumber: parseColor("#ffe08a"),
		syntaxKeyword: parseColor("#d6a6ff"),
	},
};
const ctx = { ui: { theme }, mode: "tui" };

test("the extension loads without errors and registers its tool and command", async () => {
	const loaded = await load();
	assert.deepEqual(loaded.errors, [], `load errors: ${JSON.stringify(loaded.errors)}`);
	const ext = loaded.extensions[0];
	assert.ok(ext, "extension loaded");
	assert.ok(ext.tools.get("mpl_render"), "mpl_render is registered");
	assert.ok(ext.commands.get("charts"), "/charts is registered");
	assert.ok(ext.entryRenderers?.get("mpl-chart"), "the chart entry renderer is registered");
});

test("the registered tool renders from a spec and injects the theme", async () => {
	const loaded = await load();
	const definition = loaded.extensions[0]?.tools.get("mpl_render")?.definition;
	assert.ok(definition?.execute);
	const result = await definition.execute(
		"call-1",
		{ name: "load-test", calls: [["plot", [[1, 2, 3], [3, 1, 2]], { label: "s" }], ["set_title", ["Loaded"]]] } as never,
		undefined,
		undefined,
		ctx as never,
	);
	assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
	const structured = result.structuredContent as { image?: { type: string }; pngPath?: string; specPath?: string };
	assert.equal(structured.image?.type, "image");
	assert.ok(structured.pngPath && existsSync(structured.pngPath), "png written under PI_CHART_DIR");
	assert.ok(structured.pngPath?.startsWith(root));
	assert.ok(structured.specPath && existsSync(structured.specPath));
	// The theme reached the figure: the SVG keeps the theme's text colour.
});

test("the registered tool answers format ansi with rows instead of a file", async () => {
	const loaded = await load();
	const definition = loaded.extensions[0]?.tools.get("mpl_render")?.definition;
	const result = await definition!.execute(
		"call-2",
		{ format: "ansi", cols: 60, calls: [["bar", [["a", "b"], [3, 7]]], ["set_title", ["Text"]]] } as never,
		undefined,
		undefined,
		ctx as never,
	);
	assert.notEqual(result.isError, true, String(result.content[0]?.type === "text" ? result.content[0].text : ""));
	const structured = result.structuredContent as { text?: string; rows?: number };
	assert.ok(structured.text?.includes("Text"));
	assert.ok((structured.rows ?? 0) > 5);
});

test("a bad spec surfaces as a tool error, not a crash", async () => {
	const loaded = await load();
	const definition = loaded.extensions[0]?.tools.get("mpl_render")?.definition;
	const result = await definition!.execute("call-3", { calls: [["nope", []]] } as never, undefined, undefined, ctx as never);
	assert.equal(result.isError, true);
	const structured = result.structuredContent as { error?: string };
	assert.match(structured.error ?? "", /unknown call/);
});

test("/charts prune confirms the day folders it will delete", async () => {
	const command = (await load()).extensions[0]?.commands.get("charts");
	assert.ok(command, "/charts is registered");
	const oldDay = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
	const dir = join(root, oldDay);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "one-aaaa.png"), "x");
	writeFileSync(join(dir, "two-bbbb.png"), "x");
	const notes: string[] = [];
	let confirmMessage = "";
	const commandCtx = {
		mode: "tui",
		ui: {
			notify: (message: string) => notes.push(message),
			confirm: async (_title: string, message: string) => {
				confirmMessage = message;
				return false;
			},
			select: async () => undefined,
		},
	};
	await command.handler("prune 14", commandCtx as never);
	assert.match(confirmMessage, /1 day folder/, "one folder, not one per chart");
	assert.doesNotMatch(confirmMessage, /2 day folder/);
	assert.deepEqual(notes, [], "declining deletes nothing");
	assert.ok(existsSync(dir), "the folder survives a declined prune");
});
