// Text that was written twice and decoded once must never ship again.
//
// This exact defect has shipped THREE times on this repo:
//   1. the inventory middot
//   2. 21 sequences in agenthost-growth.ts
//   3. 47 sequences in command-center.tsx, found 2026-08-03 -- including the
//      mode-switch toast, which rendered to Steve on his phone as
//      "DEV MODE set aEUR" the box is restarting to apply itaEUR|".
//      His words: "there are stray marks and letters after Dev Mode".
//
// Same cause every time: a tool rewrites a UTF-8 file while guessing a
// single-byte encoding, so an em-dash (bytes E2 80 94) is re-encoded as the
// three characters those bytes look like in CP1252. Nothing errors. The file
// stays valid. It only becomes visible when a human reads the screen -- which
// is why it kept reaching Steve instead of a test.
//
// The signature is unambiguous: a literal 'a-circumflex' or 'A-circumflex'
// followed by the C1-range characters that only ever appear from this mistake.
// No legitimate source in this repo contains them.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// Built from code points, never written literally: a test that contains the
// thing it forbids reports itself, and a guard that flags its own explanation
// gets deleted. (Both the assist and nav guards hit this trap on 2026-08-03.)
const A_CIRC = String.fromCharCode(0xe2); // â  -- lead byte of most punctuation
const A_CIRC_CAP = String.fromCharCode(0xc2); // Â  -- lead byte of NBSP, middot
const EURO = String.fromCharCode(0x20ac); // €
const TM = String.fromCharCode(0x2122); // ™
const SQUIG = String.fromCharCode(0x153); // œ

/** The double-encoded lead sequences. Each is two characters that cannot occur
 *  together in text anyone typed on purpose. */
const SEQUENCES = [
  A_CIRC + EURO, // — – ' ' " " …  (E2 80 xx)
  A_CIRC + TM, // ™ and friends
  A_CIRC + SQUIG, // œ-family
  A_CIRC_CAP + String.fromCharCode(0xb7), // ·  middot
  A_CIRC_CAP + String.fromCharCode(0xa0), // non-breaking space
  A_CIRC_CAP + String.fromCharCode(0xae), // ®
];

const DIRS = ["container", "dashboard/components", "dashboard/app", "scripts", "site", "desktop"];
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".html", ".css", ".md", ".json"]);
// The build output is generated FROM the sources this test guards; scanning it
// too would just report the same defect twice and make the failure harder to
// read. Fix the source, rebuild, and the artifact follows.
const SKIP = /node_modules|[\\/]dashboard-ui[\\/]|[\\/]\.next[\\/]|[\\/]dist[\\/]|package-lock/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a directory that does not exist here is not a failure
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

test("no source file contains double-encoded text", () => {
  const files = walk.call(null, path.join(root, DIRS[0]));
  for (const d of DIRS.slice(1)) walk(path.join(root, d), files);

  // An empty scan passes every assertion below while checking nothing. That is
  // how the phone-reachability test stayed green for its whole life. Assert the
  // scan actually happened.
  assert.ok(
    files.length > 50,
    `the scan found only ${files.length} files -- the walk is broken, so this test proves nothing`,
  );

  const hits = [];
  for (const file of files) {
    if (path.basename(file) === "no-mojibake.test.js") continue;
    const text = fs.readFileSync(file, "utf8");
    for (const seq of SEQUENCES) {
      let at = text.indexOf(seq);
      while (at !== -1) {
        const line = text.slice(0, at).split("\n").length;
        const context = text.slice(Math.max(0, at - 35), at + 25).replace(/\s+/g, " ");
        hits.push(`${path.relative(root, file)}:${line}  ...${context}...`);
        at = text.indexOf(seq, at + 1);
        if (hits.length > 40) break;
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    "these characters were written twice and decoded once -- an em-dash, ellipsis or middot " +
      "that will render on Steve's phone as stray letters:\n  " +
      hits.join("\n  ") +
      "\nRe-save the file as UTF-8 and replace each sequence with the character it was meant to be.",
  );
});

test("the guard actually detects the sequence it forbids", () => {
  // Proving the check fails on the bug it targets, rather than trusting that a
  // green run means anything. This is the exact string that reached Steve.
  const sample = "setToast(`DEV MODE set " + A_CIRC + EURO + '" the box is restarting to apply it' + A_CIRC + EURO + "|`)";
  const found = SEQUENCES.some((s) => sample.includes(s));
  assert.ok(found, "the sequence list no longer matches the defect it was written for");

  const clean = "setToast(`DEV MODE set — the box is restarting to apply it…`)";
  assert.ok(
    !SEQUENCES.some((s) => clean.includes(s)),
    "the correct string is being flagged -- this guard would cry wolf on good code",
  );
});
