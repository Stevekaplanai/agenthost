// memory-capture.js -- agents write what they learn to the team brain.
//
// THE GAP THIS CLOSES (found 2026-08-03, Steve's call to build it): of the 200
// memories in the brain, 195 were seeded repo documents and 0 -- zero -- had
// ever been written by an agent about something it learned. The brain was a
// document library wearing agent names. Every path that could have captured a
// memory either didn't exist or was a hook the gate deliberately disables for
// speed. This is the path that exists.
//
// THE PATTERN (same trust model as BOARD: and ARTIFACT:): the engine proposes
// in its reply, the gate is the only hand on the brain. An engine that learned
// something durable ends a line with
//
//   MEMORY: <the fact, one line>
//
// and the gate posts it to the memory service with THAT ENGINE'S OWN key
// (MEMORY_KEY_<ENGINE>), so the author comes from the key row -- the service's
// anti-spoofing rule, unchanged. No hooks, no extra model calls, no latency:
// parsing a finished reply costs nothing, which is why this exists and the
// hook-based capture does not.
//
// FLOOD CONTROL (the practitioner's first flag: the failure mode of capture is
// not too few memories, it is a brain full of noise that buries the real ones):
//   - opt-in per turn: no MEMORY: line, no capture. Nothing auto-summarizes.
//   - ONE memory per turn. The first well-formed line wins; the rest drop.
//   - length-capped. A memory is a distilled lesson, not a transcript.
//   - always scope:shared, kind:fact. Shared because the brain page now reads
//     as Steve (brain-lib.js) and a private agent memory would be invisible to
//     him -- captured-but-unseeable is the same defect as unreachable (Rule 11).
//     Fact because shared rule/procedure writes are admin-gated by the service
//     on purpose, and capture must never need an admin key.
//
// Pure parsing + key mapping here; the posting (network, audit) lives with the
// gate, injected for tests.
"use strict";

// One line, anchored at line start. Free text follows -- there is no id/verb
// shape to validate (unlike BOARD:), so the anchors and caps are the guard.
const MEMORY_LINE_RE = /^[ \t]*MEMORY:[ \t]*(\S[^\r\n]*)$/gm;
const MEMORY_MAX_CHARS = 1000;
const MEMORY_MAX_PER_TURN = 1;

/** MEMORY: lines from a finished reply, capped. Pure. */
function parseMemoryBlocks(text) {
  const out = [];
  // Same ceiling as parseArtifactBlocks, same reason: this runs on EVERY
  // reply, and an unbounded input is an event-loop stall waiting to happen.
  if (typeof text !== "string" || !text || text.length > 2 * 1024 * 1024) return out;
  let m;
  MEMORY_LINE_RE.lastIndex = 0;
  while ((m = MEMORY_LINE_RE.exec(text)) && out.length < MEMORY_MAX_PER_TURN) {
    const content = String(m[1] || "").trim().slice(0, MEMORY_MAX_CHARS);
    if (content) out.push({ content });
  }
  return out;
}

// Engine label -> the env var holding that engine's own brain key. The list
// mirrors start.sh's ~/.memory.env writer and the seeder: these are the agents
// that HAVE keys. An unknown label maps to null and the capture is refused by
// name -- never silently, and never with a borrowed key, because a borrowed
// key would stamp the wrong author on the memory, which is the exact defect
// the panel just recovered from.
const ENGINE_KEY_VARS = {
  claude: "MEMORY_KEY_CLAUDE",
  codex: "MEMORY_KEY_CODEX",
  gemini: "MEMORY_KEY_GEMINI",
  kimi: "MEMORY_KEY_KIMI",
  hi: "MEMORY_KEY_HI",
  kh: "MEMORY_KEY_KH",
  cursor: "MEMORY_KEY_CURSOR",
};

/** { key } for this engine, or { why } it cannot write. Pure. */
function captureConfig(engineLabel, env) {
  const e = env || process.env;
  const url = String(e.MEMORY_SERVICE_URL || "").replace(/\/+$/, "");
  if (!url) return { why: "MEMORY_SERVICE_URL is unset on the box" };
  const varName = ENGINE_KEY_VARS[String(engineLabel || "").toLowerCase()];
  if (!varName) return { why: `no brain key is defined for engine '${engineLabel}'` };
  const key = String(e[varName] || "").trim();
  if (!key) return { why: `${varName} is not reaching the gate (allowlist or secret missing)` };
  return { url, key };
}

// The instruction every engine sees. Lives here so the syntax and its parser
// cannot drift apart, and so a test can assert the charter actually teaches
// what the gate actually parses -- an instruction nobody receives is Rule 11's
// unreachable feature wearing a comment.
const MEMORY_SYNTAX_NOTE =
  "\n\nTEAM BRAIN -- durable memory. When a turn teaches you something the whole team should " +
  "still know next week (a decision, a gotcha, a fact about this system that is not in the docs), " +
  "end your reply with one line:\n" +
  "  MEMORY: <the lesson, one line, plain language>\n" +
  "The gate stores it in the team brain under YOUR name, shared with the whole team and Steve. " +
  "At most one per turn, and most turns need none -- routine work is not a memory. " +
  "Never put secrets, tokens, or key values in one.";

module.exports = {
  parseMemoryBlocks,
  captureConfig,
  ENGINE_KEY_VARS,
  MEMORY_SYNTAX_NOTE,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_PER_TURN,
};
