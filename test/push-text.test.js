// Push notification text (Steve, 2026-07-25).
//
// Steve: "make it so my push notifications hold value by ensuring that they
// just have the actionable event OR the completed task in a small number of
// characters that will fit on my push note."
//
// A phone shows ~1 line of title and ~2 of body; a lock screen shows less.
// Anything past that is invisible, so the rule is: TITLE = what happened,
// BODY = which thing it happened to, both short. These tests guard the
// formatter AND sweep gate.js so a new call site cannot quietly reintroduce a
// paragraph (17 sites were each inventing their own wording before this).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pushClamp, pushSubject, pushPayload, PUSH_TITLE_MAX, PUSH_BODY_MAX } from "../container/gate.js";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

test("the caps stay inside what a phone actually renders", () => {
  assert.ok(PUSH_TITLE_MAX > 0 && PUSH_TITLE_MAX <= 45, "title cap fits one line");
  assert.ok(PUSH_BODY_MAX > 0 && PUSH_BODY_MAX <= 90, "body cap fits ~two lines");
});

test("pushClamp never exceeds the cap and never cuts a word in half", () => {
  const long = "Rewrite the entire onboarding funnel copy for the Series A launch and update every CTA";
  for (const max of [10, 20, 38, 72]) {
    const out = pushClamp(long, max);
    assert.ok(out.length <= max, `"${out}" (${out.length}) within ${max}`);
    assert.ok(out.endsWith("…"), "truncation is signalled");
    // the visible part must not end mid-word
    const body = out.slice(0, -1);
    assert.ok(!/\w$/.test(body) || long.startsWith(body), "cuts on a word boundary where one is available");
  }
});

test("pushClamp leaves short text completely alone", () => {
  assert.equal(pushClamp("Task done", 38), "Task done");
  assert.equal(pushClamp("Loop FAILED", 38), "Loop FAILED");
  assert.ok(!pushClamp("Task done", 38).includes("…"), "no ellipsis when nothing was dropped");
});

test("pushClamp flattens whitespace so a multi-line source cannot span lines", () => {
  assert.equal(pushClamp("two\nlines   here", 38), "two lines here");
  assert.equal(pushClamp("  padded  ", 38), "padded");
  for (const empty of ["", null, undefined]) assert.equal(pushClamp(empty, 38), "");
});

test("pushSubject quotes the subject without double-quoting it", () => {
  assert.equal(pushSubject("Fix the nav", 72), "“Fix the nav”");
  assert.equal(pushSubject('"Fix the nav"', 72), "“Fix the nav”", "pre-quoted input is not re-quoted");
  assert.equal(pushSubject("", 72), "", "nothing in, nothing out (no empty quote marks)");
  assert.equal(pushSubject(null, 72), "");
});

test("pushPayload clamps both fields and passes deep-link data through", () => {
  const p = pushPayload(
    "This event name is far too long to fit on any phone screen at all",
    "and this subject line is also much too long to be rendered in full on a locked phone",
    { task: "t_abc123" },
  );
  assert.ok(p.title.length <= PUSH_TITLE_MAX);
  assert.ok(p.body.length <= PUSH_BODY_MAX);
  assert.deepEqual(p.data, { task: "t_abc123" }, "deep-link data survives (the sw uses it to open the right card)");
  assert.ok(!("data" in pushPayload("a", "b")), "no empty data key when none was given");
});

test("every real notification shape fits, including with a huge task title", () => {
  const huge = "Rewrite the entire onboarding funnel copy for the Series A launch and update every single CTA across the site";
  const shapes = [
    pushPayload("Agent finished", "while the app was closed"),
    pushPayload("Approval needed", "codex: deploy the site to production now"),
    pushPayload("Loop FAILED", "ai-money-minute-daily"),
    pushPayload("codex hit an error", pushSubject(huge, PUSH_BODY_MAX), { task: "t_1" }),
    pushPayload("hermes finished — review", pushSubject(huge, PUSH_BODY_MAX)),
    pushPayload("codex → claude: promote?", pushSubject(huge, PUSH_BODY_MAX), { task: "t_2" }),
    pushPayload("Task done", pushSubject(huge, PUSH_BODY_MAX)),
    pushPayload("PR merged", "reviewed pull request"),
  ];
  for (const s of shapes) {
    assert.ok(s.title.length <= PUSH_TITLE_MAX, `title too long: ${s.title}`);
    assert.ok(s.body.length <= PUSH_BODY_MAX, `body too long: ${s.body}`);
    assert.ok(!/[\n\r]/.test(s.title + s.body), "no newlines reach the lock screen");
    assert.ok(s.title.trim().length > 0, "a notification always says what happened");
  }
});

// ---- the sweep: guard the call sites themselves ----------------------------

test('no push title is the bare word "AgentHost" (it wastes the most visible line)', () => {
  assert.ok(!/title:\s*"AgentHost"\s*,/.test(gate),
    'a title of just "AgentHost" tells Steve nothing he does not already know — name the event');
});

test("no push body embeds a newline list (phones truncate mid-item)", () => {
  const sites = gate.split("sendToAllSubs(").slice(1);
  for (const site of sites) {
    const chunk = site.slice(0, 420);
    const body = chunk.match(/body:\s*([^\n]*)/);
    if (body) assert.ok(!/\\n/.test(body[1]), "push body must not contain \\n: " + body[1].slice(0, 80));
  }
});

test("every sendToAllSubs call routes through the formatter", () => {
  const sites = gate.split("sendToAllSubs(").slice(1);
  assert.ok(sites.length >= 15, "sanity: the sweep found the call sites (" + sites.length + ")");
  for (const site of sites) {
    const chunk = site.slice(0, 500);
    const usesFormatter = /pushPayload\(|pushClamp\(|pushSubject\(/.test(chunk);
    // the helper's own definition and the JSON.stringify inside it are not call sites
    const isDefinition = /^payloadObj\)/.test(chunk);
    if (!isDefinition) {
      assert.ok(usesFormatter, "unformatted push payload -> " + chunk.slice(0, 110).replace(/\s+/g, " "));
    }
  }
});
