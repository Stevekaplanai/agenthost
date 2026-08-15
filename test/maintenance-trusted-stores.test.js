import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "../container/maintenance-trusted-stores.js";

const { createTrustedStores } = mod;

const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

// In-memory stand-in for the root-owned native NDJSON journal (shared by all stores).
function fakeNative() {
  const lines = [];
  return {
    readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null),
    appendFoundationJournalLine: (buf) => { const s = buf.toString("utf8"); if (!s || /[\n\r\0]/.test(s)) throw new Error("bad line"); lines.push(s); },
    _lines: () => lines.slice(),
  };
}
const mk = (native) => createTrustedStores({ native, policy: { ...POLICY }, structuralLimits: LIMITS });

test("construction requires native, policy, and structural limits", () => {
  assert.throws(() => createTrustedStores({ policy: POLICY, structuralLimits: LIMITS }), /native/);
  assert.throws(() => createTrustedStores({ native: fakeNative(), structuralLimits: LIMITS }), /policy/);
  assert.throws(() => createTrustedStores({ native: fakeNative(), policy: POLICY }), /structural limits/);
});

test("exposes all six stores + bootReconcile, each functional over the shared journal", () => {
  const s = mk(fakeNative());
  for (const k of ["stopStore", "claimsStore", "runsStore", "budgetStore", "auditStore", "recoveryStore"]) {
    assert.equal(typeof s[k], "object", `${k} present`);
  }
  assert.equal(typeof s.bootReconcile, "function");
  // STOP boots ENGAGED by default — the fail-closed first_secure_migration state
  // (the box starts STOPPED until reconciliation clears it). Coherent StopView.
  const stop0 = s.stopStore.get();
  assert.equal(stop0.engaged, true, "boots STOPPED by default (fail-closed)");
  assert.ok(Number.isInteger(stop0.version));
  // budget reserve proves a second store is live and wired to the same journal
  s.budgetStore.reserve({ chainId: "c1", workerRef: "wrk_1", tokenUnits: 10, costMicros: 1_000_000 });
  assert.equal(s.budgetStore.view("c1").reservedCostMicros, 1_000_000);
});

test("all six stores share ONE physical journal", () => {
  const native = fakeNative();
  const s = mk(native);
  s.stopStore.engage({ expectedVersion: s.stopStore.get().version, reasonCode: "operator_stop", summary: "x" });
  s.budgetStore.reserve({ chainId: "c1", workerRef: "wrk_1", tokenUnits: 1, costMicros: 1_000_000 });
  s.runsStore.accept({ id: "r1", kind: "board_task", taskId: "t1", chainId: "c1", profileId: "p", repoId: "repo", workMode: "new", engines: ["claude"], summary: "" });
  const types = new Set(native._lines().map((l) => JSON.parse(l).type));
  assert.deepEqual([...types].sort(), ["budget", "run", "stop"], "one journal holds every store's records, type-tagged");
});

test("restart-safe: a second assembly over the SAME journal reconstructs state", () => {
  const native = fakeNative();
  const s1 = mk(native);
  s1.stopStore.engage({ expectedVersion: s1.stopStore.get().version, reasonCode: "operator_stop", summary: "x" });
  s1.budgetStore.reserve({ chainId: "c1", workerRef: "wrk_1", tokenUnits: 5, costMicros: 2_000_000 });
  const s2 = mk(native); // fresh stores, same journal
  assert.equal(s2.stopStore.get().engaged, true);
  assert.equal(s2.budgetStore.view("c1").reservedCostMicros, 2_000_000);
});

test("bootReconcile runs idempotently and interrupts an in-flight worker claim", () => {
  const native = fakeNative();
  const s = mk(native);
  // an accepted worker run + an active claim with an attached worker = in-flight
  s.runsStore.accept({ id: "r1", kind: "board_task", taskId: "t1", chainId: "c1", profileId: "p", repoId: "repo", workMode: "new", engines: ["claude"], summary: "" });
  let claim = s.claimsStore.create({ taskId: "t1", runId: "r1", chainId: "c1", authorEngine: "claude" });
  s.budgetStore.reserve({ chainId: "c1", workerRef: "wrk_1", tokenUnits: 1, costMicros: 1_000_000 });
  claim = s.claimsStore.attachWorker(claim.ref, { expectedVersion: claim.version, workerRef: "wrk_1" });
  s.bootReconcile();
  assert.equal(s.claimsStore.get(claim.ref).state, "interrupted", "in-flight claim interrupted conservatively");
  // idempotent: a second reconcile is a no-op (does not throw)
  s.bootReconcile();
  assert.equal(s.claimsStore.get(claim.ref).state, "interrupted");
});
