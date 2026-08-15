import { test } from "node:test";
import assert from "node:assert/strict";
import adapterMod from "../container/maintenance-journal-adapter.js";
import budgetMod from "../container/maintenance-budget-store.js";
import stopMod from "../container/maintenance-stop-store.js";

const { createFoundationJournalAdapter } = adapterMod;
const { createBudgetStore } = budgetMod;
const { createStopStore } = stopMod;

const pass = () => {};
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const codeOf = (e) => e && e.code;

// In-memory stand-in for the root-owned native NDJSON journal.
function fakeNative() {
  const lines = [];
  return {
    readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null),
    appendFoundationJournalLine: (buf) => {
      const s = buf.toString("utf8");
      if (s.length === 0 || /[\n\r\0]/.test(s)) { const e = new Error("invalid journal line"); e.code = "INVALID_REQUEST"; throw e; }
      lines.push(s);
    },
    _push: (raw) => lines.push(raw),
    _lines: () => lines.slice(),
  };
}

test("construction requires native + a known store type", () => {
  assert.throws(() => createFoundationJournalAdapter({ type: "budget" }), /native/);
  assert.throws(() => createFoundationJournalAdapter({ native: fakeNative(), type: "bogus" }), /known store type/);
});

test("append + readAll round-trips within a type; null journal reads empty", () => {
  const native = fakeNative();
  const a = createFoundationJournalAdapter({ native, type: "budget" });
  assert.deepEqual(a.readAll(), []); // ENOENT-equivalent
  a.append({ type: "budget", op: "reserve", workerRef: "w1", costMicros: 5 });
  a.append({ type: "budget", op: "settle", workerRef: "w1", costMicros: 3 });
  assert.deepEqual(a.readAll().map((r) => r.op), ["reserve", "settle"]);
});

test("append refuses a record whose type is not the adapter's view", () => {
  const a = createFoundationJournalAdapter({ native: fakeNative(), type: "budget" });
  assert.throws(() => a.append({ type: "claim", op: "create" }), (e) => codeOf(e) === "INVALID_REQUEST");
});

test("ONE shared journal, two type-views: each sees only its own records, total order preserved", () => {
  const native = fakeNative();
  const budget = createFoundationJournalAdapter({ native, type: "budget" });
  const claim = createFoundationJournalAdapter({ native, type: "claim" });
  budget.append({ type: "budget", op: "reserve", n: 1 });
  claim.append({ type: "claim", op: "create", n: 2 });
  budget.append({ type: "budget", op: "settle", n: 3 });
  claim.append({ type: "claim", op: "attach", n: 4 });
  assert.deepEqual(budget.readAll().map((r) => r.n), [1, 3]);
  assert.deepEqual(claim.readAll().map((r) => r.n), [2, 4]);
  assert.equal(native._lines().length, 4, "all four records share one physical journal");
});

test("fail-closed: a malformed line makes readAll throw STORE_UNAVAILABLE (never a gapped view)", () => {
  const native = fakeNative();
  const a = createFoundationJournalAdapter({ native, type: "budget" });
  a.append({ type: "budget", op: "reserve" });
  native._push("{ this is not valid json");
  assert.throws(() => a.readAll(), (e) => codeOf(e) === "STORE_UNAVAILABLE");
});

// The money test: real stores over ONE shared journal, then fresh stores replay
// the SAME journal — state reconstructs with no cross-contamination.
test("real budget + stop stores share one journal; replay reconstructs each, ignoring the other's records", () => {
  const native = fakeNative();
  const mkBudget = () => createBudgetStore({ log: createFoundationJournalAdapter({ native, type: "budget" }), policy: { ...POLICY }, structuralLimits: LIMITS });
  const mkStop = () => createStopStore({ log: createFoundationJournalAdapter({ native, type: "stop" }), validateStopView: pass });

  const budget = mkBudget();
  const stop = mkStop();
  budget.reserve({ chainId: "c1", workerRef: "wrk_1", tokenUnits: 10, costMicros: 2_000_000 });
  stop.engage({ expectedVersion: stop.get().version, reasonCode: "operator_stop", summary: "op" });
  budget.reserve({ chainId: "c1", workerRef: "wrk_2", tokenUnits: 5, costMicros: 1_000_000 });

  // One physical journal now interleaves budget + stop records.
  assert.ok(native._lines().length >= 3);

  // Fresh stores replaying the SAME shared journal reconstruct their own state.
  const budget2 = mkBudget();
  const stop2 = mkStop();
  assert.equal(budget2.view("c1").reservedCostMicros, 3_000_000, "budget replayed from the shared journal (ignored stop records)");
  assert.equal(stop2.get().engaged, true, "stop replayed from the shared journal (ignored budget records)");
});
