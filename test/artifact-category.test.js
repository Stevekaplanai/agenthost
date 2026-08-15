// An artifact says what KIND of thing it is, and only its author knows.
//
// Steve chose this (2026-08-12) over the alternative of shipping a "Creative"
// lens that filters `~/artifacts` by pattern-matching filenames. That directory
// is flat .html/.md with no tag, no producer and no category, so
// `creative-pulse-brief.html` and `build-plan-2026-07-27.html` are
// indistinguishable downstream -- and `growth-view.tsx` already forbids exactly
// that kind of inference ("it does not infer goals from card titles"), forty
// lines from where a Creative tab would live.
//
// So the signal comes from the producer. These tests drive the REAL `/artifacts`
// route on a REAL booted gate against REAL files on disk, because the thing
// being specified is what an operator surface receives, not what a helper
// returns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "container", "gate.js");
const KEY = "artifact-category-test-key";

function html({ title = "A Thing", category = null } = {}) {
  const meta = category === null ? "" : `<meta name="agenthost:category" content="${category}">`;
  return `<!doctype html><html><head><meta charset="utf-8">${meta}<title>${title}</title></head><body><p>x</p></body></html>`;
}

function md({ title = "A Thing", category = null } = {}) {
  const front = category === null ? "" : `---\ncategory: ${category}\n---\n`;
  return `${front}# ${title}\n\nbody\n`;
}

async function boot(t, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-category-"));
  const dir = path.join(home, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

  const charter = path.join(home, "tiny-charter.md");
  fs.writeFileSync(charter, "You are a test agent.");

  const gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      AGENT_CHARTER_FILE: charter,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      WAKE_CHECKIN: "off",
      AGENTHOST_CANONICAL_HOST: "",
      FLY_APP_NAME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 20_000);
    gate.stdout.on("data", (c) => {
      stdout += c.toString();
      const m = stdout.match(/listening on (\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    gate.stderr.on("data", (c) => { stderr += c.toString(); });
    gate.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });

  const { cookie } = await mintOperatorSession(base, KEY);
  t.after(async () => {
    await stopChild(gate);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const res = await fetch(base + "/artifacts", {
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const byName = new Map(body.files.map((f) => [f.name, f]));
  return { byName, files: body.files };
}

test("the listing carries the category the author declared, in both artifact formats", async (t) => {
  const { byName } = await boot(t, {
    "brief.html": html({ title: "Creative Pulse", category: "creative" }),
    "plan.md": md({ title: "Build Plan", category: "plan" }),
  });

  assert.equal(byName.get("brief.html").category, "creative");
  assert.equal(byName.get("plan.md").category, "plan");
  // The title must keep working -- both facts now come from a single read, and a
  // refactor that quietly broke the title while fixing the category would look
  // like a pass here otherwise.
  assert.equal(byName.get("brief.html").title, "Creative Pulse");
  assert.equal(byName.get("plan.md").title, "Build Plan");
});

test("an artifact that never said what it is reports null, and is NOT guessed from its name", async (t) => {
  const { byName } = await boot(t, {
    // Named exactly like the real box's untagged creative work. If anything ever
    // starts inferring from filenames, this is the assertion that catches it.
    "creative-pulse-brief-2026-08-01.html": html({ title: "Creative Pulse Brief" }),
    "build-plan-2026-07-27.html": html({ title: "Build Plan" }),
    "notes.md": md({ title: "Notes" }),
  });

  assert.equal(byName.get("creative-pulse-brief-2026-08-01.html").category, null,
    "a filename that SAYS creative is still not a declaration -- this is the whole point");
  assert.equal(byName.get("build-plan-2026-07-27.html").category, null);
  assert.equal(byName.get("notes.md").category, null);
});

test("a malformed or hostile category is dropped rather than passed through", async (t) => {
  const { byName } = await boot(t, {
    "shouty.html": html({ category: "CREATIVE" }),
    "spaced.html": html({ category: "not a slug" }),
    "injected.html": html({ category: "<script>x</script>" }),
    "toolong.html": html({ category: "c".repeat(40) }),
    "empty.md": md({ category: "" }),
  });

  // Case is normalised -- an author writing CREATIVE meant creative, and that is
  // a formatting difference, not an ambiguity.
  assert.equal(byName.get("shouty.html").category, "creative");
  // Everything that is not a clean slug becomes null rather than reaching a
  // surface. Same posture as the rest of this route: distrust the value, and
  // failing to a known-nothing beats passing through a shape nobody validated.
  assert.equal(byName.get("spaced.html").category, null);
  assert.equal(byName.get("injected.html").category, null);
  assert.equal(byName.get("toolong.html").category, null);
  assert.equal(byName.get("empty.md").category, null);
});

test("every row carries the key, so a consumer never has to distinguish absent from untagged", async (t) => {
  const { files } = await boot(t, {
    "tagged.html": html({ category: "report" }),
    "untagged.html": html({}),
  });

  assert.equal(files.length, 2);
  for (const f of files) {
    assert.ok(Object.hasOwn(f, "category"),
      `${f.name} is missing the category key entirely; a consumer would then have to treat undefined and null as the same thing, which is how a filter silently starts matching everything`);
  }
});

// The three cases Kimi found on #387. Each one is a way for the reader to
// produce a WRONG answer rather than no answer, which is the failure mode this
// whole feature exists to avoid -- a category nobody declared is exactly as
// misleading as a category guessed from a filename.
test("a category mentioned in the BODY is not mistaken for a declaration", async (t) => {
  const { byName } = await boot(t, {
    // Frontmatter present and closed, but declaring something else entirely.
    // The body then talks about categories, as a doc about this very feature
    // would. Before the fix the reader scanned 2000 characters past the opening
    // `---` without requiring it to close, and read the body line.
    "about-categories.md": [
      "---",
      "title: How categories work",
      "---",
      "",
      "# How categories work",
      "",
      "Set it in frontmatter, like this:",
      "",
      "category: creative",
      "",
      "and the gate will read it.",
    ].join("\n"),
    // No frontmatter at all, body mentions one.
    "no-frontmatter.md": "# Notes\n\ncategory: creative\n",
  });

  assert.equal(byName.get("about-categories.md").category, null,
    "prose about a category is not a declaration of one");
  assert.equal(byName.get("no-frontmatter.md").category, null,
    "a body line without any frontmatter block is not a declaration either");
});

test("a meta tag is read however its attributes are ordered or spaced", async (t) => {
  const { byName } = await boot(t, {
    // `name` before `content` is a convention, not a rule. Both of these are
    // valid HTML and mean the same thing; an ordered pattern silently ignored
    // the second, and a silently ignored declaration looks exactly like an
    // author who never declared anything.
    "ordered.html": `<!doctype html><html><head><meta name="agenthost:category" content="report"><title>A</title></head><body>x</body></html>`,
    "reversed.html": `<!doctype html><html><head><meta content="report" name="agenthost:category"><title>B</title></head><body>x</body></html>`,
    "spaced.html": `<!doctype html><html><head><meta name = "agenthost:category" content = "report"><title>C</title></head><body>x</body></html>`,
    "uppercase-tag.html": `<!doctype html><html><head><META NAME="agenthost:category" CONTENT="report"><title>D</title></head><body>x</body></html>`,
    // A different meta tag must not be harvested just because it sits nearby.
    "other-meta.html": `<!doctype html><html><head><meta name="description" content="creative"><title>E</title></head><body>x</body></html>`,
  });

  assert.equal(byName.get("ordered.html").category, "report");
  assert.equal(byName.get("reversed.html").category, "report");
  assert.equal(byName.get("spaced.html").category, "report");
  assert.equal(byName.get("uppercase-tag.html").category, "report");
  assert.equal(byName.get("other-meta.html").category, null,
    "content from an unrelated meta tag is not the category");
});
