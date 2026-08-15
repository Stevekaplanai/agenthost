// ADR-2302 prerequisite #1, half A: the claim store's durability settings.
//
// These are BEHAVIOURAL tests, not source pins — ClaimStore is exported and
// constructible, so each assertion opens a real database and reads back what
// SQLite actually did. That distinction matters here more than usual: the whole
// defect being fixed is a setting that was *assumed* rather than stated.
//
// What was wrong (measured on the box 2026-08-08):
//   - `synchronous` was never set. It is PER-CONNECTION and not persisted, so
//     the store's durability was whatever the library happened to default to.
//     A `sqlite3` CLI query reports the CLI's own default, not the gate's — so
//     the obvious way to check it gave a falsely reassuring answer.
//   - Nothing ever checkpointed. board-claims.sqlite-wal reached 3,790,432 bytes
//     against a 28,672-byte database.
//   - The pragmas lived in _createSchema(), which `initialize: false` skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaimStore } from "../container/claim-store.js";

// Windows keeps a lock on recently-closed SQLite files for a moment, so an
// immediate recursive delete raises EPERM. Production is Linux; the local
// mirror is Windows (same split the gate's persistChatRunMeta already handles).
// Temp-dir cleanup is housekeeping, never the thing under test.
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { if (process.platform !== "win32" || e.code !== "EPERM") throw e; }
}

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claim-"));
  const file = path.join(dir, "claims.sqlite");
  return { dir, file, store: new ClaimStore(file, opts) };
}

test("a fresh store is in WAL mode with synchronous=FULL", () => {
  const { dir, store } = tmpStore();
  try {
    assert.equal(String(store._db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal",
      "WAL is what makes a commit crash-safe without rewriting the whole database");
    assert.equal(Number(store._db.prepare("PRAGMA synchronous").get().synchronous), 2,
      "FULL (2) — each commit fsyncs the WAL. NORMAL (1) would lose commits on power loss, silently");
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("the pragmas apply even when schema initialization is skipped", () => {
  // initialize:false skips _createSchema, which is where journal_mode used to
  // live. A store opened that way on a fresh file sat in rollback-journal mode
  // with different crash semantics than the rest of the box assumes.
  const { dir, store } = tmpStore({ initialize: false });
  try {
    assert.equal(String(store._db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
    assert.equal(Number(store._db.prepare("PRAGMA synchronous").get().synchronous), 2);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("close() folds the WAL back and leaves the database standing on its own", () => {
  const { dir, file, store } = tmpStore();
  try {
    // Write enough to guarantee a WAL exists before the close.
    for (let i = 0; i < 50; i += 1) {
      store.tryAcquire({
        taskId: "t_dur_" + i,
        engine: "claude",
        ttlMs: 60_000,
        schedulerGeneration: 1,
        nowMs: 1000 + i,
      });
    }
    assert.ok(fs.existsSync(file + "-wal"), "a WAL exists while the store is open and written to");

    store.close();

    const walAfter = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
    assert.equal(walAfter, 0,
      "after a graceful close the WAL is truncated — the committed state lives in the database file itself, so a copy or a backup captures it");

    // And the data is genuinely there, read back through a brand-new connection.
    const reopened = new ClaimStore(file);
    try {
      const row = reopened._db.prepare("SELECT count(*) AS n FROM claims").get();
      assert.equal(Number(row.n), 50, "every committed claim survived the close/reopen cycle");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("checkpoint() is best-effort and never throws on a closed store", () => {
  // A checkpoint that cannot run must not prevent a close, or a wedged reader
  // leaks the handle instead of just the disk.
  const { dir, store } = tmpStore();
  store.close();
  assert.equal(store.checkpoint(), false, "returns false rather than throwing once the handle is gone");
  fs.rmSync(dir, { recursive: true, force: true });
});
