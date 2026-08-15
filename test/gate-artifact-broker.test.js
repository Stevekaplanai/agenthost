// GATE-BROKERED ARTIFACTS (Steve, 2026-07-26).
//
// WHY THIS EXISTS: the charter requires every human-facing deliverable to be a
// rendered artifact in ~/artifacts, but most engines cannot put a file there.
// Codex is sandboxed read-only even in chat; Kimi is a bare chat API; Gemini
// runs `-p` non-interactively, where its CLI registers neither a shell nor a
// write tool. Asked for a mockup "in artifacts", Gemini pasted the entire HTML
// into the chat and told Steve to check the artifacts panel — for a file that
// was never written. The charter was asking engines for something they
// physically could not do.
//
// So the gate brokers it, exactly as it already brokers BOARD: verbs: the
// engine PROPOSES an ARTIFACT: block, and the gate is the only hand on the
// filesystem. Which makes the parser a trust boundary — its input is model
// output, and its output becomes a filename on disk. These tests are mostly
// about the hostile cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArtifactBlocks, reservedGraphifyArtifactName } from "../container/gate.js";

const block = (name, body) => "ARTIFACT: " + name + "\n" + body + "\nARTIFACT-END";

test("a well-formed block yields the name and the body verbatim", () => {
  const out = parseArtifactBlocks(block("mockup.html", "<!doctype html>\n<h1>Hi</h1>"));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "mockup.html");
  assert.match(out[0].body, /^<!doctype html>\n<h1>Hi<\/h1>\n?$/);
});

test("prose around the block is ignored, and several blocks are picked up", () => {
  const text = [
    "Here is the mockup you asked for.",
    block("a.html", "<p>a</p>"),
    "and the notes:",
    block("b.md", "# notes"),
    "Let me know what you think.",
  ].join("\n");
  assert.deepEqual(parseArtifactBlocks(text).map((a) => a.name), ["a.html", "b.md"]);
});

test("PATH TRAVERSAL: a name that climbs out is reduced to a bare name or dropped", () => {
  // Each of these must NOT produce a name containing a separator or "..".
  for (const evil of [
    "../../etc/passwd.html",
    "..\\..\\windows\\system32\\evil.html",
    "/etc/cron.d/x.html",
    "C:\\Users\\User\\.ssh\\authorized_keys.html",
    "~/.bashrc.html",
  ]) {
    for (const a of parseArtifactBlocks(block(evil, "x"))) {
      assert.ok(!/[\\/]/.test(a.name), evil + " -> no separator survives (" + a.name + ")");
      assert.ok(!a.name.includes(".."), evil + " -> no parent ref survives (" + a.name + ")");
    }
  }
});

test("EXTENSION ALLOWLIST: only .html and .md are ever accepted", () => {
  for (const bad of [
    "shell.sh", "boot.js", "gate.js", "secrets.env", "id_rsa",
    "page.html.sh", "note.md.js", "noextension", "x.HTML.exe",
  ]) {
    assert.deepEqual(parseArtifactBlocks(block(bad, "x")), [], bad + " is refused");
  }
  // ...and the accepted pair is case-insensitive, since the panel serves both.
  for (const good of ["Page.HTML", "notes.MD"]) {
    assert.equal(parseArtifactBlocks(block(good, "x")).length, 1, good + " is accepted");
  }
});

test("DOTFILES are refused (the panel hides them, so a write there is invisible)", () => {
  for (const bad of [".env.html", ".hidden.md", ".htaccess.html"]) {
    assert.deepEqual(parseArtifactBlocks(block(bad, "x")), [], bad + " is refused");
  }
});

test("engine artifact blocks cannot overwrite a reserved committed Graphify leaf", () => {
  const reserved = `graphify-agent-harness-all-${"a".repeat(32)}.html`;
  assert.equal(reservedGraphifyArtifactName(reserved), true);
  assert.equal(reservedGraphifyArtifactName(reserved.toUpperCase()), true,
    "case-only aliases stay reserved on case-insensitive filesystems");
  assert.deepEqual(parseArtifactBlocks(block(reserved, "attacker replacement")), []);
  assert.deepEqual(parseArtifactBlocks(block(reserved.toUpperCase(), "attacker replacement")), []);
});

test("an oversized body is dropped rather than truncated", () => {
  const huge = "x".repeat(512 * 1024 + 1);
  assert.deepEqual(parseArtifactBlocks(block("big.html", huge)), [],
    "a body over the cap is refused outright — a half-written artifact is worse than none");
  const fine = "y".repeat(1024);
  assert.equal(parseArtifactBlocks(block("ok.html", fine)).length, 1);
});

test("an unterminated block writes nothing", () => {
  // The exact shape of Gemini's bug: HTML pasted into chat with no end marker.
  const out = parseArtifactBlocks("ARTIFACT: mockup.html\n<!doctype html>\n<h1>no end marker</h1>");
  assert.deepEqual(out, [], "without ARTIFACT-END there is no block to write");
});

test("the number of blocks per reply is bounded", () => {
  const many = Array.from({ length: 12 }, (_, i) => block("f" + i + ".html", "x")).join("\n");
  assert.ok(parseArtifactBlocks(many).length <= 4, "at most 4 artifacts per turn");
});

test("junk input never throws", () => {
  for (const junk of ["", null, undefined, 42, {}, "ARTIFACT:", "ARTIFACT-END", "ARTIFACT: \nARTIFACT-END"]) {
    assert.doesNotThrow(() => parseArtifactBlocks(junk), JSON.stringify(junk) + " is safe");
  }
});
