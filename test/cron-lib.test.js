// Unit tests for container/cron-lib.js (the gate scheduler's cron engine).
// The container subtree is CommonJS while test/ inherits the root's ESM type,
// hence createRequire instead of a bare import.
// Run: node --test test/cron-lib.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseCron, cronMatches, nextRun } = require("../container/cron-lib.js");

const utc = (s) => new Date(s + ":00Z");

// Calendar anchors (verified UTC weekdays): 2026-02-06 is a Friday,
// 2026-04-13 is a Monday, 2026-04-14 a Tuesday, 2026-07-12 a Sunday.
const matchCases = [
  { name: "exact minute match", expr: "30 14 * * *", date: "2026-07-11T14:30", want: true },
  { name: "exact minute, off by one", expr: "30 14 * * *", date: "2026-07-11T14:31", want: false },
  { name: "all-wildcard matches anything", expr: "* * * * *", date: "2026-07-11T03:07", want: true },
  { name: "*/15 step hits :45", expr: "*/15 * * * *", date: "2026-07-11T09:45", want: true },
  { name: "*/15 step misses :20", expr: "*/15 * * * *", date: "2026-07-11T09:20", want: false },
  { name: "hour range includes edge", expr: "0 9-17 * * *", date: "2026-07-11T17:00", want: true },
  { name: "hour range excludes outside", expr: "0 9-17 * * *", date: "2026-07-11T08:00", want: false },
  { name: "comma list, second element", expr: "0 0 1,15 * *", date: "2026-07-15T00:00", want: true },
  { name: "comma list, non-member", expr: "0 0 1,15 * *", date: "2026-07-14T00:00", want: false },
  { name: "a-b/n stepped range hits", expr: "10-40/10 * * * *", date: "2026-07-11T09:30", want: true },
  { name: "a-b/n stepped range misses off-step", expr: "10-40/10 * * * *", date: "2026-07-11T09:15", want: false },
  // dom AND dow restricted -> standard cron OR semantics
  { name: "dom|dow OR: Friday the 6th (dow side)", expr: "0 0 13 * 5", date: "2026-02-06T00:00", want: true },
  { name: "dom|dow OR: Monday the 13th (dom side)", expr: "0 0 13 * 5", date: "2026-04-13T00:00", want: true },
  { name: "dom|dow OR: Tuesday the 14th matches neither", expr: "0 0 13 * 5", date: "2026-04-14T00:00", want: false },
  // dom restricted, dow "*" -> plain AND, no OR escape hatch
  { name: "dom-only: the 13th matches", expr: "0 0 13 * *", date: "2026-04-13T00:00", want: true },
  { name: "dom-only: a Friday that is not the 13th", expr: "0 0 13 * *", date: "2026-02-06T00:00", want: false },
  { name: "dow 7 is Sunday", expr: "0 0 * * 7", date: "2026-07-12T00:00", want: true },
  { name: "dow 0 is the same Sunday", expr: "0 0 * * 0", date: "2026-07-12T00:00", want: true },
  { name: "dow 7 does not match Monday", expr: "0 0 * * 7", date: "2026-04-13T00:00", want: false },
];

for (const c of matchCases) {
  test(`cronMatches: ${c.name}`, () => {
    assert.equal(cronMatches(c.expr, utc(c.date)), c.want);
  });
}

test("nextRun is strictly after 'from', even when 'from' itself matches", () => {
  const got = nextRun("*/5 * * * *", utc("2026-01-01T00:05"));
  assert.equal(got.toISOString(), "2026-01-01T00:10:00.000Z");
});

test("nextRun rolls over a month boundary", () => {
  const got = nextRun("5 0 * * *", utc("2026-01-31T23:59"));
  assert.equal(got.toISOString(), "2026-02-01T00:05:00.000Z");
});

test("nextRun skips short months to reach the 31st", () => {
  const got = nextRun("0 12 31 * *", utc("2026-02-01T00:00"));
  assert.equal(got.toISOString(), "2026-03-31T12:00:00.000Z");
});

test("nextRun returns null when no date can ever match", () => {
  assert.equal(nextRun("0 0 31 2 *", utc("2026-01-01T00:00")), null);
});

const badExprs = [
  { name: "six fields", expr: "0 0 * * * *" },
  { name: "minute out of range", expr: "60 * * * *" },
  { name: "garbage token", expr: "* * * * banana" },
  { name: "not a cron at all", expr: "every day at noon" },
  { name: "reversed range", expr: "0 17-9 * * *" },
  { name: "zero step", expr: "*/0 * * * *" },
  { name: "empty string", expr: "" },
];

for (const c of badExprs) {
  test(`parseCron throws: ${c.name}`, () => {
    assert.throws(() => parseCron(c.expr), Error);
  });
}

test("*/n dom is UNrestricted for the dom/dow rule (Vixie star-flag), so dow still gates", () => {
  // 2026-04-15 is a Wednesday with an odd... 15th; dom */2 covers 1,3,..31; dow=1 (Monday).
  // Star-flag semantics: */2 is unrestricted -> AND applies -> Wednesday must NOT match.
  assert.equal(cronMatches("0 0 */2 * 1", new Date(Date.UTC(2026, 3, 15, 0, 0))), false);
  // A real Monday that is NOT an odd dom: 2026-04-06 (Monday, 6th, not in 1,3,5..) -> no match either (AND).
  assert.equal(cronMatches("0 0 */2 * 1", new Date(Date.UTC(2026, 3, 6, 0, 0))), false);
  // Monday the 13th: dom in */2 set (odd) AND Monday -> match.
  assert.equal(cronMatches("0 0 */2 * 1", new Date(Date.UTC(2026, 3, 13, 0, 0))), true);
});

test("nextRun finds leap-day jobs years out instead of reporting never", () => {
  const n = nextRun("0 0 29 2 *", new Date(Date.UTC(2026, 6, 11)));
  assert.ok(n, "leap-day job has a next run");
  assert.equal(n.toISOString(), "2028-02-29T00:00:00.000Z");
  // Genuinely impossible date still reports null.
  assert.equal(nextRun("0 0 31 2 *", new Date(Date.UTC(2026, 6, 11))), null);
});
