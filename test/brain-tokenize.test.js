// Unit tests for the /brain query tokenizer + hit ranking (task #34).
// gate.js exports its pure helpers when require()d (lib mode: require.main !==
// module); the server only boots when gate.js is the entrypoint, so requiring
// it here has no side effects and needs no TTYD_PASSWORD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { tokenizeBrainQuery, rankBrainHits, agentSpawnArgs } = require("../container/gate.js");

test("tokenizer: drops stopwords, keeps content terms", () => {
  // The motivating bug: "/brain what is attribyte" grepped the whole sentence.
  assert.deepEqual(tokenizeBrainQuery("what is attribyte"), ["attribyte"]);
  assert.deepEqual(tokenizeBrainQuery("tell me about the deploy checklist"), ["deploy", "checklist"]);
  assert.deepEqual(tokenizeBrainQuery("what do my notes say about fly volumes"), ["notes", "fly", "volumes"]);
});

test("tokenizer: lowercases and dedupes", () => {
  assert.deepEqual(tokenizeBrainQuery("Attribyte ATTRIBYTE attribyte?"), ["attribyte"]);
});

test("tokenizer: keeps inner punctuation, then appends split-on-separator variants", () => {
  // Compound stays FIRST (strongest signal), base words follow so notes that
  // say "claimflow" or "health check" still hit "/brain claimflow.health".
  assert.deepEqual(tokenizeBrainQuery("what does pack.mjs redact"), ["pack.mjs", "redact", "pack", "mjs"]);
  assert.deepEqual(tokenizeBrainQuery("my 2fa-notes please"), ["2fa-notes", "2fa", "notes"]);
});

test("tokenizer: dotted terms add their base words (the /brain claimflow.health case)", () => {
  assert.deepEqual(tokenizeBrainQuery("claimflow.health"), ["claimflow.health", "claimflow", "health"]);
  assert.deepEqual(tokenizeBrainQuery("how is claimflow.health doing"), ["claimflow.health", "claimflow", "health"]);
});

test("tokenizer: variant split drops stopword and 1-char parts", () => {
  // "up" and "to" are stopwords; only "date" survives the split.
  assert.deepEqual(tokenizeBrainQuery("up-to-date runbook"), ["up-to-date", "runbook", "date"]);
  // The compound itself is a fine base term, but 1-char parts add no variants.
  assert.deepEqual(tokenizeBrainQuery("a-b"), ["a-b"]);
});

test("tokenizer: variants dedupe against base terms and each other", () => {
  // "pack" already present as a base term: the split adds only "mjs".
  assert.deepEqual(tokenizeBrainQuery("pack pack.mjs"), ["pack", "pack.mjs", "mjs"]);
  // Both compounds share the part "health": it is added once.
  assert.deepEqual(tokenizeBrainQuery("claimflow.health db.health"),
    ["claimflow.health", "db.health", "claimflow", "health", "db"]);
});

test("tokenizer: variants never crowd out base terms and stay bounded at 16 total", () => {
  // 8 compound base terms (the base cap) -> variants append after, capped at 16.
  const q = "a.b c.d e.f g.h i.j k.l m.n o.p q.r s.t";
  const terms = tokenizeBrainQuery(q);
  assert.equal(terms.length, 8, "1-char parts add no variants; base cap of 8 holds");
  const q2 = "alpha.bravo charlie.delta echoes.foxtrot golf.hotel india.juliet kilo.lima mike.november oscar.papa";
  const terms2 = tokenizeBrainQuery(q2);
  assert.equal(terms2.length, 16, "capped at 16 total");
  assert.deepEqual(terms2.slice(0, 8),
    ["alpha.bravo", "charlie.delta", "echoes.foxtrot", "golf.hotel", "india.juliet", "kilo.lima", "mike.november", "oscar.papa"],
    "all 8 base compounds kept ahead of any variant");
  assert.deepEqual(terms2.slice(8, 10), ["alpha", "bravo"], "variants follow in base-term order");
});

test("tokenizer: trims edge punctuation and drops 1-char leftovers", () => {
  // "what's" splits to "what" (stopword) + "s" (too short).
  assert.deepEqual(tokenizeBrainQuery("what's attribyte's status?"), ["attribyte", "status"]);
  assert.deepEqual(tokenizeBrainQuery("...redaction..."), ["redaction"]);
});

test("tokenizer: all-stopword query yields no terms (caller falls back to the raw query)", () => {
  assert.deepEqual(tokenizeBrainQuery("what is the"), []);
  assert.deepEqual(tokenizeBrainQuery(""), []);
  assert.deepEqual(tokenizeBrainQuery("   "), []);
});

test("tokenizer: caps at 8 distinct terms", () => {
  const q = "alpha bravo charlie delta echoes foxtrot golf hotel india juliet";
  const terms = tokenizeBrainQuery(q);
  assert.equal(terms.length, 8);
  assert.deepEqual(terms.slice(0, 2), ["alpha", "bravo"]);
});

test("ranking: lines matching more terms float to the top; ties keep rg order", () => {
  const hits = [
    "notes/a.md:1:only attribution here",
    "notes/b.md:2:attribyte does attribution",
    "notes/c.md:3:only attribyte here",
  ].join("\n") + "\n";
  const ranked = rankBrainHits(hits, ["attribyte", "attribution"]).split("\n");
  assert.equal(ranked[0], "notes/b.md:2:attribyte does attribution", "two-term line ranks first");
  assert.deepEqual(ranked.slice(1), [
    "notes/a.md:1:only attribution here",
    "notes/c.md:3:only attribyte here",
  ], "one-term lines keep their original relative order");
});

test("ranking: matching is case-insensitive", () => {
  const hits = "a.md:1:nothing relevant\nb.md:1:ATTRIBYTE launch plan\n";
  assert.equal(rankBrainHits(hits, ["attribyte"]).split("\n")[0], "b.md:1:ATTRIBYTE launch plan");
});

test("ranking: empty hits / empty terms are safe and drop blank lines", () => {
  assert.equal(rankBrainHits("", ["x"]), "");
  assert.equal(rankBrainHits("\n\n", ["x"]), "");
  assert.equal(rankBrainHits("a.md:1:hit\n", []), "a.md:1:hit");
});

// ---- agentSpawnArgs: the chat-speed fix's arg builder ------------------------
// Every gate-spawned one-shot (chat, /brain, cron) goes through this builder,
// so asserting its shape here covers all three call sites. The timing claim
// itself was measured manually (10.1s -> 3.5s with two 3s hooks); tests only
// pin the MECHANISM (hook suppression present in spawn args), never wall clock.

test("agentSpawnArgs: one-shots suppress hooks via a disableAllHooks settings overlay", () => {
  assert.deepEqual(agentSpawnArgs("hello", false, {}), [
    "-p", "hello", "--dangerously-skip-permissions",
    "--settings", '{"disableAllHooks":true}',
  ]);
  // The overlay must be valid JSON with the CLI's supported kill switch --
  // `-p` silently ignores settings that fail validation, so a typo here would
  // silently bring the slowness back.
  const at = agentSpawnArgs("x", false, {}).indexOf("--settings");
  assert.equal(JSON.parse(agentSpawnArgs("x", false, {})[at + 1]).disableAllHooks, true);
});

test("agentSpawnArgs: -c (continue) rides after the suppression overlay", () => {
  const args = agentSpawnArgs("hello", true, {});
  assert.equal(args[args.length - 1], "-c");
  assert.ok(args.includes("--settings"), "continue runs still suppress hooks");
  // Positional contract the e2e fake bins rely on: prompt stays at argv[2].
  assert.deepEqual(args.slice(0, 2), ["-p", "hello"]);
});

test("agentSpawnArgs: AGENT_CHAT_HOOKS=1 keeps the user's hooks (opt-out of suppression)", () => {
  assert.deepEqual(agentSpawnArgs("hello", true, { AGENT_CHAT_HOOKS: "1" }),
    ["-p", "hello", "--dangerously-skip-permissions", "-c"]);
  // Only the exact "1" opts out; anything else keeps the fast default.
  assert.ok(agentSpawnArgs("x", false, { AGENT_CHAT_HOOKS: "0" }).includes("--settings"));
  assert.ok(agentSpawnArgs("x", false, { AGENT_CHAT_HOOKS: "" }).includes("--settings"));
});
