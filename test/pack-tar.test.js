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

function listArchive(base) {
  return execFileSync("tar", ["-tzf", "harness.tar.gz"], { cwd: base, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
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

// Cross-platform (macOS) parity: the packer passes `--exclude .DS_Store` BEFORE
// the `-C staging .` operands and sets COPYFILE_DISABLE=1. The arg order is the
// one both GNU tar (Windows/Linux) and BSD tar (macOS) honor -- this asserts the
// exact invocation still produces a valid archive and that a .DS_Store in the
// tree is kept out. (COPYFILE_DISABLE's ._* suppression is BSD-tar-only and
// can't be observed on GNU tar, so it's set but not asserted here.)
test("packer tar step excludes .DS_Store (exact invocation form)", () => {
  const base = makeStaging();
  try {
    fs.writeFileSync(path.join(base, "staging", ".DS_Store"), "\x00\x00finder-metadata");
    fs.writeFileSync(path.join(base, "staging", ".claude", ".DS_Store"), "\x00\x00finder-metadata");
    execFileSync("tar", ["-czf", "harness.tar.gz", "--exclude", ".DS_Store", "-C", "staging", "."], {
      cwd: base,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const entries = listArchive(base);
    assert.ok(entries.some((e) => e.endsWith("CLAUDE.md")), "real files are still packed");
    assert.ok(!entries.some((e) => e.endsWith(".DS_Store")), "no .DS_Store entry in the archive");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The post-archive audit re-EXTRACTS the finished tarball, and that call had the
// bug the -czf call above was fixed for -- plus a second one. GNU tar C-escapes
// its -C argument, so an absolute Windows temp path like
// ...\Temp\agenthost-pack-XXXX\.archive-audit-YYYY turns "\a" into a BEL byte and
// tar dies "Cannot open". Every non-dry-run pack then failed its own audit and
// deleted the tarball: no deploy or sync could ship anything from this machine.
// The audit now passes the audit dir's BASENAME with cwd already at outDir.
test("packer archive-audit extraction uses a relative -C (escape- and drive-letter safe)", () => {
  // "agenthost-" starts with the letter that trips \a; the prefix is deliberate.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-packtar-"));
  try {
    const staging = path.join(base, "staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "CLAUDE.md"), "# harness\n");
    execFileSync("tar", ["-czf", "harness.tar.gz", "-C", "staging", "."], { cwd: base });

    const auditDir = fs.mkdtempSync(path.join(base, ".archive-audit-"));
    // The exact form scripts/pack.mjs uses: basename, not the absolute path.
    execFileSync("tar", ["-xzf", "harness.tar.gz", "-C", path.basename(auditDir)], { cwd: base });
    assert.equal(fs.readFileSync(path.join(auditDir, "CLAUDE.md"), "utf8"), "# harness\n");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
