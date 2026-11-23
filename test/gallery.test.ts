import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { describeChart, listCharts, pruneCharts, staleDays } from "../gallery.ts";

const root = mkdtempSync(join(tmpdir(), "pi-charts-gallery-"));
after(() => rmSync(root, { recursive: true, force: true }));

const day = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const touch = (dayName: string, name: string, text = "x"): string => {
	const dir = join(root, dayName);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, text);
	return path;
};

touch(day(0), "latency-aaaa.png");
touch(day(0), "latency-aaaa.json", "{}");
touch(day(0), "latency-aaaa.html", "<html></html>");
touch(day(2), "bars-bbbb.png");
touch(day(30), "ancient-cccc.png");
touch("not-a-day", "ignore.png");

test("listCharts groups stems, newest first, and honours the window", () => {
	const recent = listCharts(root, { days: 7 });
	const stems = recent.map((e) => e.stem);
	assert.deepEqual(stems.sort(), ["bars-bbbb", "latency-aaaa"]);
	assert.ok(recent[0]!.png && recent[0]!.spec && recent[0]!.html);
	assert.equal(listCharts(root, { limit: 1 }).length, 1);
	assert.deepEqual(
		listCharts(root, { days: 3650 }).map((e) => e.stem).includes("ancient-cccc"),
		true,
	);
	assert.ok(!listCharts(root, { days: 3650 }).some((e) => e.stem === "ignore"), "non-day folders are skipped");
});

test("describeChart names the day, time, stem, and formats", () => {
	const entry = listCharts(root, { days: 1 }).find((e) => e.stem === "latency-aaaa");
	assert.ok(entry);
	const label = describeChart(entry);
	assert.match(label, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}latency-aaaa {2}\[png\/svg|png\/html|png\]/);
});

test("pruneCharts removes old day folders only and keeps the current day", () => {
	const before = listCharts(root, { days: 3650 }).length;
	const result = pruneCharts(root, { days: 14 });
	assert.deepEqual(result.days, [day(30)]);
	assert.ok(result.files >= 1);
	const afterPrune = listCharts(root, { days: 3650 }).map((e) => e.stem);
	assert.ok(!afterPrune.includes("ancient-cccc"));
	assert.ok(afterPrune.includes("latency-aaaa"));
	assert.ok(before > afterPrune.length);
});

test("staleDays names exactly the folders pruneCharts deletes", () => {
	// Two charts in one old folder are one folder, not two.
	touch(day(40), "one-dddd.png");
	touch(day(40), "two-eeee.png");
	touch(day(50), "three-ffff.png");
	const stale = staleDays(root, { days: 14 });
	assert.deepEqual(stale, [day(50), day(40)]);
	assert.ok(!stale.includes(day(0)), "the current day is kept");
	assert.ok(!stale.includes("not-a-day"), "non-day folders are skipped");
	assert.deepEqual(staleDays(join(root, "missing")), []);
	const result = pruneCharts(root, { days: 14 });
	assert.deepEqual([...result.days].sort(), [day(50), day(40)]);
	assert.ok(!existsSync(join(root, day(40))), "the preview set is the deleted set");
});

test("pruning a missing root is a no-op", () => {
	assert.deepEqual(pruneCharts(join(root, "missing")), { days: [], files: 0 });
	assert.deepEqual(listCharts(join(root, "missing")), []);
});
