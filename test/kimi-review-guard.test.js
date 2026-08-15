// The output guards in scripts/kimi-review.sh, RUN rather than read.
//
// These tests exist because that guard has now falsely refused three complete,
// well-formed reviews (#276 twice, #284), each time because the verdict line
// arrived in a shape nobody had imagined -- and each false refusal printed the
// same "truncated or malformed" message as a real one, so it was indistinguishable
// from the failure the guard exists to catch.
//
// A grep-the-source test would not have caught any of them. So this stubs `kimi`
// and `gh` on PATH, executes the real script, and asserts on its exit code. If the
// guard's pattern regresses, one of these fails.
//
// Skips itself with a stated reason if bash is unavailable (Windows without Git
// Bash). A silent skip and a pass must never look alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "kimi-review.sh");

function bashPath() {
  for (const c of ["bash", "/usr/bin/bash", "C:/Program Files/Git/bin/bash.exe"]) {
    const r = spawnSync(c, ["-c", "exit 0"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  return null;
}
const BASH = bashPath();

// C.UTF-8 is not installed everywhere. Asserting a locale DIFFERENCE on a runner
// that has only one locale would fail for a reason that has nothing to do with the
// guard. Detect it, and skip with a stated reason rather than silently. (Kimi, #286.)
const UTF8_LOCALE = (() => {
  if (!BASH) return null;
  for (const c of ["C.UTF-8", "en_US.UTF-8"]) {
    const r = spawnSync(BASH, ["-c", `LC_ALL=${c} locale charmap 2>/dev/null`], { encoding: "utf8" });
    if (r.status === 0 && /UTF-?8/i.test(r.stdout || "")) return c;
  }
  return null;
})();

// Stub kimi to emit `review`, and gh to satisfy the diff/title/body reads the
// script does before it ever calls kimi. Returns the script's exit code.
function runGuard(review) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-guard-"));
  try {
    fs.writeFileSync(path.join(dir, "review.txt"), review);
    fs.writeFileSync(path.join(dir, "kimi"),
      '#!/bin/sh\ncat "$KIMI_STUB_REVIEW"\n', { mode: 0o755 });
    // `gh pr diff` must produce a non-empty diff or the earlier guard fires first
    // and this test would pass without ever reaching the verdict check -- the exact
    // false-start that made an earlier version of this look green.
    fs.writeFileSync(path.join(dir, "gh"),
      '#!/bin/sh\ncase "$*" in\n  *"pr diff"*) echo "diff --git a/x b/x";;\n  *) echo "stub";;\nesac\n',
      { mode: 0o755 });
    const r = spawnSync(BASH, [script, "1"], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KIMI_STUB_REVIEW: path.join(dir, "review.txt"),
      },
      encoding: "utf8",
    });
    return r.status;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const ACCEPTED = [
  ["two leading spaces (falsely refused on #276)", "reasoning\n  VERDICT: PASS WITH FINDINGS\n"],
  ["a bullet (falsely refused on #284)", "reasoning\n\u2022 VERDICT: PASS\n"],
  ["plain, column 0", "reasoning\nVERDICT: FAIL\n"],
  ["bold markdown", "reasoning\n**VERDICT: PASS**\n"],
  ["a list dash", "reasoning\n- VERDICT: PASS\n"],
];

const REFUSED = [
  ["empty output", ""],
  ["truncated before any verdict", "some findings, then the stream stopped mid-sen"],
  ["only an inline mention in prose, then truncation",
   "I will end with `VERDICT:` on its own line as instructed\nbut the stream was cut mid-sen"],
];

test("the verdict guard accepts every real verdict shape", { skip: BASH ? false : "bash is not available on this machine" }, () => {
  for (const [label, review] of ACCEPTED) {
    assert.equal(runGuard(review), 0, `should ACCEPT: ${label}`);
  }
});

test("the verdict guard still refuses output with no verdict", { skip: BASH ? false : "bash is not available on this machine" }, () => {
  for (const [label, review] of REFUSED) {
    assert.notEqual(runGuard(review), 0, `should REFUSE: ${label}`);
  }
});

test("the chosen pattern matches the bullet in BOTH locales, unlike [[:punct:]]", { skip: !BASH ? "bash is not available on this machine" : !UTF8_LOCALE ? "no UTF-8 locale is installed, so the C-vs-UTF-8 divergence cannot be observed here" : false }, () => {
  // This test previously asserted "[[:punct:]] does not match U+2022" as a flat fact.
  // That is TRUE under the C locale (Git Bash on Windows) and FALSE under a UTF-8
  // locale (Linux CI) -- so it passed locally and failed on CI. The test committed
  // the exact error it was written to document.
  //
  // The corrected claim is STRONGER than the original. [[:punct:]] is not merely
  // wrong here, it is LOCALE-DEPENDENT: a guard built on it accepts the bullet on CI
  // and refuses it on the operator's own machine. A guard whose verdict changes with
  // $LC_ALL is worse than either behaviour applied consistently, because the failure
  // is unreproducible for whoever is looking at it.
  //
  // [^[:alnum:]] matches in both. That is the whole reason it was chosen.
  const bullet = path.join(os.tmpdir(), "kimi-bullet-probe.txt");
  fs.writeFileSync(bullet, "\u2022 VERDICT: PASS\n");
  const run = (locale, pattern) =>
    spawnSync(BASH, ["-c", `LC_ALL=${locale} grep -qE '${pattern}' "${bullet}"`]).status;
  try {
    for (const locale of ["C", UTF8_LOCALE]) {
      assert.equal(run(locale, "^[^[:alpha:]]*VERDICT:"), 0,
        `the shipped pattern must match the bullet under LC_ALL=${locale}`);
    }
    // Pin the divergence itself. If some future grep makes [[:punct:]] agree across
    // locales, this fails and the reasoning above needs rewriting -- which is the
    // point of asserting it rather than only describing it in a comment.
    assert.notEqual(
      run("C", "^[[:punct:][:space:]]*VERDICT:"),
      run(UTF8_LOCALE, "^[[:punct:][:space:]]*VERDICT:"),
      "[[:punct:]] is expected to disagree with itself across locales; that disagreement is why it was rejected");
  } finally {
    try { fs.rmSync(bullet, { force: true }); } catch {}
  }
});
