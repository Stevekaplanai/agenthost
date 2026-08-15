import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAgents, describeAgent } from "../src/detect.js";

test("detectAgents reports presence per agent dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".hermes"));
  const got = Object.fromEntries(detectAgents(home).map((a) => [a.key, a.present]));
  assert.deepEqual(got, { claude: true, hermes: true, codex: false, openclaw: false });
});

test("describeAgent phrasing matches support level, silent when absent", () => {
  const [claude, hermes, codex, openclaw] = detectAgents(fs.mkdtempSync(path.join(os.tmpdir(), "detect2-")));
  assert.equal(describeAgent(codex), null);
  assert.match(describeAgent({ ...claude, present: true }), /full migration/);
  for (const [agent, optOut] of [
    [hermes, "--no-hermes"],
    [codex, "--no-codex"],
    [openclaw, "--no-openclaw"],
  ]) {
    const text = describeAgent({ ...agent, present: true });
    assert.match(text, /safe (files|subset).*migrate automatically/i);
    assert.match(text, new RegExp(optOut));
    assert.doesNotMatch(text, /waitlist|not yet supported|--agent/);
  }
});
