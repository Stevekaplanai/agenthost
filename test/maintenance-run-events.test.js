// Phase 1f Step 4a (piece 5): the run-event ledger backing run.events. Pages are
// validated against the REAL protocol edge via
// protocol.validateResponse("run.events", ...) so the ledger cannot drift from
// the RunEventView + page contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import ledgerMod from "../container/maintenance-run-events.js";

const { createRunEventLedger } = ledgerMod;
const EPOCH = "gw_" + "a".repeat(32);
const REQ = "req_" + "b".repeat(32);
const RUN = "run_1";

function validatePage(page, afterSeq, pageLimit) {
  const response = {
    v: 1, gatewayEpoch: EPOCH, requestId: REQ, ok: true, status: "success", code: "OK",
    summary: "ok.", rootCause: null, retry: { safe: false, afterMs: null }, stopCondition: null,
    nextActions: [], artifacts: [], data: page, serverTimeMs: 1,
  };
  return protocol.validateResponse("run.events", response, { requestId: REQ, gatewayEpoch: EPOCH, afterSeq, pageLimit });
}

const accepted = { runId: RUN, eventCode: "accepted", source: "gate", status: "queued", kind: "board_task", engine: "claude", engines: ["claude"], summary: "", nextActions: [], artifacts: [], runVersion: 1 };
const running = { runId: RUN, eventCode: "service_running", source: "service", status: "running", kind: "board_task", engine: "claude", engines: ["claude"], summary: "", nextActions: [], artifacts: [], runVersion: 2 };

test("record assigns monotonic seqs; read pages and validates against the protocol", () => {
  const l = createRunEventLedger({ now: () => 1000 });
  assert.equal(l.record(accepted).seq, 1);
  assert.equal(l.record(running).seq, 2);
  const page = l.read({ afterSeq: 0, limit: 200 });
  assert.deepEqual(page.events.map((e) => e.seq), [1, 2]);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.ledgerGeneration, 0);
  validatePage(page, 0, 200);
});

test("limit paginates with a valid opaque cursor and hasMore", () => {
  const l = createRunEventLedger({ now: () => 1 });
  l.record(accepted); l.record(running);
  const first = l.read({ afterSeq: 0, limit: 1 });
  assert.deepEqual(first.events.map((e) => e.seq), [1]);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^cur_[A-Za-z0-9_-]{22,86}$/);
  validatePage(first, 0, 1);
  const second = l.read({ afterSeq: 1, limit: 1 });
  assert.deepEqual(second.events.map((e) => e.seq), [2]);
  assert.equal(second.hasMore, false);
  validatePage(second, 1, 1);
});

test("record fails closed on eventCode/status disagreement", () => {
  const l = createRunEventLedger({ now: () => 1 });
  assert.throws(() => l.record({ ...accepted, status: "running" }), (e) => e.code === "INVALID_REQUEST");
});

test("record fails closed on source/eventCode mismatch", () => {
  const l = createRunEventLedger({ now: () => 1 });
  assert.throws(() => l.record({ ...running, source: "gate" }), (e) => e.code === "INVALID_REQUEST");
});

test("record fails closed when a single-engine event does not pin engine", () => {
  const l = createRunEventLedger({ now: () => 1 });
  assert.throws(() => l.record({ ...accepted, engine: null }), (e) => e.code === "INVALID_REQUEST");
  // multi-engine must null engine
  assert.throws(() => l.record({ ...accepted, engines: ["claude", "hermes"], engine: "claude" }), (e) => e.code === "INVALID_REQUEST");
});

test("durable-before-exposed: a persist throw keeps the event out of the ledger", () => {
  const l = createRunEventLedger({ now: () => 1, persist: () => { throw new Error("disk full"); } });
  assert.throws(() => l.record(accepted), /disk full/);
  assert.equal(l.size(), 0);
});
