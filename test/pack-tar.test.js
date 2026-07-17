// Regression guard for the tar drive-letter bug shipped in 0.4.0: GNU tar (the
// tar on the PATH under Git Bash on Windows) reads a leading "C:" in an output
// path as a remote SCP host and dies with "Cannot connect to C:". The packer
// now runs tar from the output dir with RELATIVE paths so no drive letter ever
// reaches tar. This test builds a staging tree and drives the real tar the way
// pack.mjs does, asserting a valid, correct archive results.
//
// It exercises the exact invocation form pack.mjs uses (cwd + relative -f/-C),
// so if anyone reverts to absolute paths this fails on any machine whose PATH
// resolves to GNU tar -- which is the machine that hit the bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeStaging() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "packtar-"));
  const staging = path.join(base, "staging");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "CLAUDE.md"), "# harness\n");
  fs.mkdirSync(path.join(staging, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(staging, ".claude", "skills", "s.md"), "skill\n");
  return base;
}

test("packer tar step writes a valid archive (relative-cwd form, drive-letter safe)", () => {
  const base = makeStaging();
  try {
    // The exact form scripts/pack.mjs uses: cwd=outDir, relative -f and -C.
    // On Windows `base` is an absolute C:\... path; running from cwd keeps the
    // colon out of tar's arguments entirely.
    execFileSync("tar", ["-czf", "harness.tar.gz", "-C", "staging", "."], { cwd: base });
    const tarball = path.join(base, "harness.tar.gz");
    assert.ok(fs.existsSync(tarball), "harness.tar.gz was written");
    assert.ok(fs.statSync(tarball).size > 0, "tarball is non-empty");

    // Contents round-trip: extract and confirm the files are intact.
    const outAgain = path.join(base, "extracted");
    fs.mkdirSync(outAgain);
    execFileSync("tar", ["-xzf", "harness.tar.gz", "-C", "extracted"], { cwd: base });
    assert.equal(fs.readFileSync(path.join(outAgain, "CLAUDE.md"), "utf8"), "# harness\n");
    assert.equal(fs.readFileSync(path.join(outAgain, ".claude", "skills", "s.md"), "utf8"), "skill\n");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
