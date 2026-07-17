// agenthost fleet: listAppStates over a fixture state dir + formatFleet output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAppStates } from "../src/state.js";
import { formatFleet } from "../src/commands/fleet.js";

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-fleet-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("listAppStates: reads per-app files, skips config.json and junk, newest first", (t) => {
  const dir = fixtureDir(t);
  fs.writeFileSync(path.join(dir, "box-a.json"), JSON.stringify({ app: "box-a", region: "iad", updatedAt: "2026-07-10T10:00:00Z" }));
  fs.writeFileSync(path.join(dir, "box-b.json"), JSON.stringify({ app: "box-b", region: "sjc", updatedAt: "2026-07-11T09:00:00Z", repos: ["me/repo"] }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ lastApp: "box-b" }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");

  const states = listAppStates(dir);
  assert.deepEqual(states.map((s) => s.app), ["box-b", "box-a"], "newest first, junk skipped");
});

test("listAppStates: missing dir -> empty list, never throws", () => {
  assert.deepEqual(listAppStates("/nonexistent/agenthost-fleet-test"), []);
});

test("formatFleet: marks the default box, shows url/region/repos", () => {
  const lines = formatFleet(
    [
      { app: "box-b", region: "sjc", updatedAt: "2026-07-11T09:00:00Z", repos: ["me/repo"] },
      { app: "box-a", region: "iad", updatedAt: "2026-07-10T10:00:00Z" },
    ],
    "box-b"
  );
  assert.match(lines[0], /^\* box-b {2}https:\/\/box-b\.fly\.dev {2}sjc {2}2026-07-11 09:00 {2}repos: me\/repo$/);
  assert.match(lines[1], /^ {2}box-a {2}https:\/\/box-a\.fly\.dev {2}iad/);
  assert.ok(lines.some((l) => l.includes("* = default")));
});

test("formatFleet: empty fleet points at deploy", () => {
  const lines = formatFleet([], null);
  assert.match(lines[0], /No boxes deployed/);
  assert.match(lines[1], /agenthost deploy/);
});

test("formatFleet: tolerates corrupt state fields (numeric updatedAt, non-array repos)", () => {
  const lines = formatFleet([{ app: "odd-box", updatedAt: 1720000000, repos: "not-an-array" }], null);
  assert.match(lines[0], /odd-box {2}https:\/\/odd-box\.fly\.dev/, "renders without throwing");
});
