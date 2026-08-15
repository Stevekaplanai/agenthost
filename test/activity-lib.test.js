// Unit tests for container/activity-lib.js -- the pure audit->card humanizer that
// powers the Command Center's live Activities feed. The whole mapping is proven
// here without booting the gate; the SSE tailer in gate.js only does I/O + calls
// cardFromLine, so proving the mapping proves the feed's content contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeAudit, cardFromLine, levelFor, titleize } from "../container/activity-lib.js";

test("a mapped event gets its human phrase, level, and structured fields", () => {
  const c = humanizeAudit({ t: "2026-07-24T05:00:00.000Z", event: "channel_reply_sent", eng: "gemini", tid: "T-12", detail: "sent to telegram" });
  assert.equal(c.title, "Replied on a channel");
  assert.equal(c.level, "pass");
  assert.equal(c.who, "gemini");
  assert.equal(c.taskId, "T-12");
  assert.equal(c.detail, "sent to telegram");
  assert.equal(c.event, "channel_reply_sent");
  assert.equal(c.t, "2026-07-24T05:00:00.000Z");
});

test("failure-suffixed events are RED even when unmapped (heuristic, not a lie)", () => {
  assert.equal(levelFor("board_runner_error"), "fail");
  assert.equal(levelFor("channel_reply_send_failed"), "fail");
  assert.equal(levelFor("wake_fail"), "fail");
  assert.equal(levelFor("channel_health_unreachable"), "fail");
  assert.equal(levelFor("some_new_thing_failed"), "fail", "an event we've never seen still classifies by suffix");
});

test("paused/held/denied events are AMBER (gate), distinct from hard failures", () => {
  assert.equal(levelFor("git_review_blocked"), "gate");
  assert.equal(levelFor("board_intent_denied"), "gate");
  assert.equal(levelFor("autonomy_claim_quarantined"), "gate");
  assert.equal(levelFor("channel_rate_limited"), "gate");
  assert.equal(levelFor("channel_consequence_gated"), "gate");
  assert.equal(levelFor("channel_engine_ineligible"), "gate");
});

test("known-good events are GREEN (pass)", () => {
  assert.equal(levelFor("chat_run"), "pass");
  assert.equal(levelFor("git_proposal_created"), "pass");
  assert.equal(levelFor("wake_checkin"), "pass");
  assert.equal(levelFor("login_ok"), "pass");
});

test("routine events default to INFO (neutral)", () => {
  assert.equal(levelFor("chat_upload"), "info");
  assert.equal(levelFor("channel_engine_dispatch"), "pass"); // dispatch is a good/handled event
  assert.equal(levelFor("cron_run"), "pass");
  assert.equal(levelFor("gateway_shutdown"), "info");
});

test("an UNMAPPED event still reads as words, never raw snake_case (the whole point)", () => {
  const c = humanizeAudit({ event: "some_brand_new_event" });
  assert.equal(c.title, "Some Brand New Event");
  assert.equal(c.level, "info");
  assert.doesNotMatch(c.title, /_/, "no underscores leak into the human title");
});

test("titleize strips a trailing underscore (the real 'secret_' event) cleanly", () => {
  assert.equal(titleize("secret_"), "Secret");
});

test("missing optional fields collapse to empty strings, never undefined/null in the card", () => {
  const c = humanizeAudit({ event: "cron_run" });
  assert.equal(c.who, "");
  assert.equal(c.taskId, "");
  assert.equal(c.detail, "");
  assert.equal(c.t, "");
});

test("a non-object or event-less entry yields null (skipped by the feed)", () => {
  assert.equal(humanizeAudit(null), null);
  assert.equal(humanizeAudit({}), null);
  assert.equal(humanizeAudit({ event: "   " }), null);
  assert.equal(humanizeAudit("nope"), null);
});

test("cardFromLine parses a real audit.log line; a partial/corrupt line -> null (not a throw)", () => {
  const line = JSON.stringify({ t: "2026-07-24T05:01:00.000Z", event: "git_review_blocked", eng: "codex", detail: "unsafe mutation" });
  const c = cardFromLine(line);
  assert.equal(c.title, "Blocked a risky merge");
  assert.equal(c.level, "gate");
  assert.equal(c.who, "codex");
  // a line caught mid-append (no closing brace) must not throw the tailer
  assert.equal(cardFromLine('{"t":"2026-07-24T05:01:00.000Z","eve'), null);
  assert.equal(cardFromLine(""), null);
  assert.equal(cardFromLine("   "), null);
});
