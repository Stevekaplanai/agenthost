// The parked-for-a-human digest (P1-AWAITING-HUMAN-INVISIBLE, 2026-08-09).
//
// A card the gate parks for Steve renders as `ready` on the board, and hermes'
// diagnostics call it "stranded_in_ready … no worker". Neither says the true
// thing. autonomy_review_noverdict fires ONCE at park time and then nothing, so
// t_a50459c9 sat invisible for 1.2h and was found only by reading chains.json.
//
// These tests run the digest's decision logic against real inputs. They do NOT
// grep gate.js for the presence of code -- that style of test is why three
// separate defects shipped green tonight.
//
// The persistence shape IS asserted against the real gate.js source, because a
// digest whose timestamp is not persisted re-announces on every restart, and
// that is a property of the file rather than of the algorithm.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import gate from "../container/gate.js";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gateSrc = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

// The PRODUCTION function, imported -- not a copy of it. An earlier version of
// this file re-implemented the rule locally, which Kimi correctly flagged: a test
// that mirrors the logic passes while the logic drifts, and that is the exact
// defect this repo has been chasing. boardTick and these tests now call the same
// code.
const digestFn = gate.parkedDigestDecision;

function digest({ parked, onBoard, now, lastAt, cadenceMs }) {
  // Shape the fixture the way boardTick does: humanReview is an object keyed by
  // task id, and onBoard is the live set of ids from the board.
  const humanReview = Object.fromEntries(parked.map((p) => [p.id, { at: p.at, title: p.title }]));
  return digestFn(humanReview, onBoard, now, lastAt, cadenceMs);
}

const HOUR = 3600000;
const CADENCE = 6 * HOUR;

test("a parked card announces, and reports how long it has waited", () => {
  const now = 10 * HOUR;
  const r = digest({
    parked: [{ id: "t_a50459c9", at: now - 1.2 * HOUR }],
    onBoard: new Set(["t_a50459c9"]), now, lastAt: 0, cadenceMs: CADENCE,
  });
  assert.equal(r.announce, true);
  assert.equal(r.count, 1);
  assert.equal(r.waitedH, 1, "1.2h rounds to 1h, not to zero — a sub-2h wait must still report a number");
});

test("it stays quiet between announcements instead of firing every tick", () => {
  const now = 10 * HOUR;
  const r = digest({
    parked: [{ id: "a", at: now - 5 * HOUR }],
    onBoard: new Set(["a"]), now, lastAt: now - HOUR, cadenceMs: CADENCE,
  });
  assert.equal(r.announce, false, "one hour into a six hour cadence");
});

test("it announces again once the cadence elapses — parked is a state, not an event", () => {
  const now = 100 * HOUR;
  const r = digest({
    parked: [{ id: "a", at: now - 20 * HOUR }],
    onBoard: new Set(["a"]), now, lastAt: now - 7 * HOUR, cadenceMs: CADENCE,
  });
  assert.equal(r.announce, true, "this is the whole point: announced once then silent forever was the bug");
  assert.equal(r.waitedH, 20);
});

test("nothing parked resets to silent, so a cleared board never nags", () => {
  const r = digest({ parked: [], onBoard: new Set(), now: HOUR, lastAt: 5000, cadenceMs: CADENCE });
  assert.equal(r.announce, false);
  assert.equal(r.reset, true);
});

test("a parked id that is no longer on the board is not announced", () => {
  const now = 10 * HOUR;
  const r = digest({
    parked: [{ id: "vanished", at: now - 9 * HOUR }],
    onBoard: new Set(["something-else"]), now, lastAt: 0, cadenceMs: CADENCE,
  });
  assert.equal(r.announce, false, "never nag about a card Steve cannot open");
});

test("with several parked, it reports the count and the OLDEST wait", () => {
  const now = 50 * HOUR;
  const r = digest({
    parked: [{ id: "a", at: now - 2 * HOUR }, { id: "b", at: now - 30 * HOUR }, { id: "c", at: now - 9 * HOUR }],
    onBoard: new Set(["a", "b", "c"]), now, lastAt: 0, cadenceMs: CADENCE,
  });
  assert.equal(r.count, 3);
  assert.equal(r.waitedH, 30, "oldest, not newest and not an average");
});

// ---- properties of the source, not of the algorithm ------------------------

test("the cadence has a hard floor, so an env override cannot make it per-tick", () => {
  assert.match(gateSrc, /const PARKED_DIGEST_MS = Math\.max\(\s*15 \* 60 \* 1000,/,
    "without a floor, AGENTHOST_PARKED_DIGEST_MS=1 turns a reminder into a flood, and a flooded channel gets muted");
});

test("the digest timestamp is persisted through read, fallback, and save", () => {
  // All three, or a restart re-announces everything outstanding. The fallback
  // matters most: it is the first-boot and corrupt-file path.
  assert.match(gateSrc, /parkedDigestAt: Number\.isFinite\(parsed\.parkedDigestAt\)/, "read");
  assert.match(gateSrc, /gatedDigestAt: 0, parkedDigestAt: 0 \}/, "fallback");
  assert.match(gateSrc, /gatedDigestAt,\s*\r?\n\s*parkedDigestAt,/, "save");
});

test("the announcement names what actually clears the park", () => {
  // The remedy people reach for is `kanban unblock`, which does not touch
  // humanReview -- it appears to work and changes nothing. Saying so in the
  // message is the difference between a 1.2h investigation and a five-second one.
  assert.match(gateSrc, /clears when the card reaches done or running, or leaves the board; kanban unblock does not clear it/);
});
