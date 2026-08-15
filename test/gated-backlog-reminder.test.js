// ADR-2302 item 2: a consequence gate must actually reach a human.
//
// Measured on the box 2026-08-08: autonomy_consequence_gated fired 130 times,
// board_override_granted fired 4, most recently 2026-08-03. The per-card push
// already existed and worked — the defect was that it fires ONCE PER CARD, EVER
// (announcedGated is persisted by saveAlertSeen, so it survives reboots by
// design). Miss that one notification and the card is silent forever. The
// operator was not ignoring a nag; there was no nag.
//
// These pins hold the backlog reminder's PROPERTIES, not its wording:
//   - it counts every gated card, not just the first
//   - it goes quiet when the backlog clears
//   - it cannot fire more often than the digest interval
//   - the interval has a floor, so an env override cannot turn it into a spammer
//
// Source-reading, like its neighbours: boardTick is not exported and has no
// injection seam. This shows the code says the right thing, not that it does it.
// Recorded as a known limit rather than dressed up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

test("every gated card is counted, not just the first", () => {
  assert.match(gate, /const gatedAll = tasks\.filter\(/,
    "the gated set is a filter — a .find() announced one card per tick and hid the rest");
  assert.match(gate, /const gated = gatedAll\[0\]/,
    "the existing per-card announce still uses the head of that set");
});

test("the reminder goes quiet when nothing is waiting", () => {
  assert.match(gate, /if \(!gatedAll\.length\) \{[\s\S]{0,160}gatedDigestAt = 0;[\s\S]{0,80}saveAlertSeen\(\);/,
    "an empty backlog resets the timer and persists it — a cleared board never nags");
});

test("the reminder is rate-limited and cannot fire every tick", () => {
  assert.match(gate, /Date\.now\(\) - gatedDigestAt >= GATED_DIGEST_MS/,
    "fires only once per digest interval while the backlog stands");
  assert.match(gate, /gatedDigestAt = Date\.now\(\);\s*saveAlertSeen\(\);/,
    "the timestamp is advanced and persisted, so a restart does not restart the nagging");
});

test("the digest interval has a hard floor", () => {
  // An env override is useful for testing; it must not be able to turn a
  // 6-hourly reminder into a per-tick alarm the operator learns to ignore.
  assert.match(gate, /const GATED_DIGEST_MS = Math\.max\(\s*15 \* 60 \* 1000,/,
    "AGENTHOST_GATED_DIGEST_MS cannot lower the interval below 15 minutes");
});

test("the backlog state is persisted alongside the existing alert dedup", () => {
  assert.match(gate, /gatedDigestAt: Number\.isFinite\(parsed\.gatedDigestAt\) \? parsed\.gatedDigestAt : 0/,
    "read back defensively — a corrupt field must not disable the reminder");
  assert.match(gate, /gated: \[\.\.\.announcedGated\]\.slice\(-ALERT_SEEN_CAP\),\s*channels: \[\.\.\.channelHealthUnhealthy\],\s*gatedDigestAt,/,
    "written through the SAME saveAlertSeen as the other alert state — not a parallel store");
});

test("the reminder audits its own cause", () => {
  assert.match(gate, /audit\("autonomy_gated_backlog"/,
    "the backlog reminder is auditable, so a silent push path is diagnosable (Rule 16)");
});
