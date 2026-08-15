import { test } from "node:test";
import assert from "node:assert/strict";
import budgetLib from "../container/deepseek-budget.js";

const {
  DEEPSEEK_V4_FLASH_PEAK_PRICES,
  conservativeUsageCostUsd,
  promptTokenUpperBound,
  normalizeDeepSeekProviderUsage,
  deepSeekUsageForReservation,
  createDeepSeekBudgetLedger,
  createDeepSeekRelayBudget,
} = budgetLib;

test("DeepSeek budget uses the announced V4 Flash peak prices, not the temporary launch discount", () => {
  assert.deepEqual(DEEPSEEK_V4_FLASH_PEAK_PRICES, {
    inputUsdPerMillion: 0.44,
    outputUsdPerMillion: 1.32,
  });
  assert.equal(conservativeUsageCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 1.76);
});

test("prompt upper bound counts bytes plus fixed message framing", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(promptTokenUpperBound(messages), Buffer.byteLength("user") + Buffer.byteLength("hello") + 16);
  assert.ok(promptTokenUpperBound([{ role: "user", content: "😀" }]) >= 4);
});

test("provider usage is trusted only when all three exact counters agree", () => {
  const reservation = { inputTokenUpperBound: 100, maxCompletionTokens: 20 };
  assert.deepEqual(normalizeDeepSeekProviderUsage({
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

  for (const usage of [
    null,
    {},
    { prompt_tokens: 1, completion_tokens: 2 },
    { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    { prompt_tokens: "1", completion_tokens: 2, total_tokens: 3 },
    { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 },
  ]) {
    assert.deepEqual(deepSeekUsageForReservation(usage, reservation), {
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      trusted: false,
      exceededBounds: false,
    });
  }

  assert.deepEqual(deepSeekUsageForReservation({
    prompt_tokens: 101, completion_tokens: 2, total_tokens: 103,
  }, reservation), {
    usage: { prompt_tokens: 101, completion_tokens: 2, total_tokens: 103 },
    trusted: true,
    exceededBounds: true,
  }, "a valid over-bound report is charged at the larger actual amount and flagged");
});

test("one request is clamped so its worst case cannot cross the per-run ceiling", () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0, now: () => Date.UTC(2026, 7, 13, 12) });
  const run = ledger.beginRun({ runId: "run-1", perRunUsd: 0.001, perDayUsd: 1, tzOffsetMin: 0 });
  const reservation = run.reserve([{ role: "user", content: "hello" }], 4096);
  assert.ok(reservation.maxCompletionTokens > 0);
  assert.ok(reservation.maxCompletionTokens < 4096);
  assert.ok(reservation.reservedUsd <= 0.001);
  const actual = run.settle(reservation, { prompt_tokens: 5, completion_tokens: 10 });
  assert.equal(actual.costUsd, conservativeUsageCostUsd({ prompt_tokens: 5, completion_tokens: 10 }));
  assert.equal(run.spentUsd(), actual.costUsd);
});

test("input whose conservative cost already consumes the ceiling is refused with its cause", () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0 });
  const run = ledger.beginRun({ runId: "run-large", perRunUsd: 0.01, perDayUsd: 1, tzOffsetMin: 0 });
  assert.throws(
    () => run.reserve([{ role: "user", content: "x".repeat(30_000) }], 100),
    (error) => error && error.kind === "budget" && /per-run spending limit/.test(error.message),
  );
});

test("concurrent runs reserve the shared daily ceiling before either provider call starts", () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0.0099 });
  const first = ledger.beginRun({ runId: "one", perRunUsd: 1, perDayUsd: 0.01, tzOffsetMin: 0 });
  const firstReservation = first.reserve([{ role: "user", content: "a" }], 4096);
  const second = ledger.beginRun({ runId: "two", perRunUsd: 1, perDayUsd: 0.01, tzOffsetMin: 0 });
  assert.throws(
    () => second.reserve([{ role: "user", content: "b" }], 100),
    (error) => error && error.kind === "budget" && /daily spending limit/.test(error.message),
  );
  first.cancel(firstReservation);
  assert.doesNotThrow(() => second.reserve([{ role: "user", content: "b" }], 100));
});

test("provider authority is refused until the worst-case reservation is durably recorded", () => {
  let failWrite = true;
  const persisted = [];
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve(reservation) {
      if (failWrite) throw new Error("durable reservation write failed");
      persisted.push(reservation);
    },
  });
  const run = ledger.beginRun({ runId: "write-ahead", perRunUsd: 0.001, perDayUsd: 1 });

  assert.throws(
    () => run.reserve([{ role: "user", content: "first" }], 100),
    /durable reservation write failed/,
  );
  failWrite = false;
  const admitted = run.reserve([{ role: "user", content: "second" }], 100);
  assert.deepEqual(persisted, [admitted]);
  run.cancel(admitted);
  run.close();
});

test("write-ahead hooks must complete synchronously before admission", () => {
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: async () => {},
  });
  const run = ledger.beginRun({ runId: "async-hook", perRunUsd: 0.001, perDayUsd: 1 });
  assert.throws(
    () => run.reserve([{ role: "user", content: "request" }], 100),
    /onReserve must be synchronous/,
  );
  run.close();
});

test("an unreadable durable day refuses admission without caching zero spend", () => {
  let readable = false;
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd() {
      if (!readable) throw new Error("durable budget ledger is unreadable");
      return 0;
    },
    onReserve: () => {},
    onCancel: () => {},
  });
  const run = ledger.beginRun({ runId: "strict-read", perRunUsd: 0.001, perDayUsd: 1 });
  assert.throws(
    () => run.reserve([{ role: "user", content: "first" }], 100),
    /durable budget ledger is unreadable/,
  );
  readable = true;
  const reservation = run.reserve([{ role: "user", content: "second" }], 100);
  run.cancel(reservation);
  run.close();
});

test("an invalid durable day value cannot be normalized into zero spend", () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => Number.NaN });
  const run = ledger.beginRun({ runId: "invalid-read", perRunUsd: 0.001, perDayUsd: 1 });
  assert.throws(
    () => run.reserve([{ role: "user", content: "request" }], 100),
    /durable daily spend must be a finite nonnegative number/,
  );
  run.close();
});

test("only a proven pre-provider cancellation clears the durable reservation", async () => {
  const events = [];
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: (reservation) => events.push(["reserve", reservation.id]),
    onSettle: (reservation, costUsd) => events.push(["settle", reservation.id, costUsd]),
    onCancel: (reservation) => events.push(["cancel", reservation.id]),
  });
  const run = ledger.beginRun({ runId: "durable-outcomes", perRunUsd: 1, perDayUsd: 5 });
  const budget = createDeepSeekRelayBudget(run);

  const refused = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await budget.cancel({ reservationId: refused.reservationId, ambiguous: false });

  const ambiguous = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await budget.cancel({ reservationId: ambiguous.reservationId, ambiguous: true });

  const settled = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await budget.settle({
    reservationId: settled.reservationId,
    usage: { promptTokens: 2, outputTokens: 1, totalTokens: 3 },
    trusted: true,
  });

  const ambiguousCost = conservativeUsageCostUsd({ prompt_tokens: 30, completion_tokens: 10 });
  const settledCost = conservativeUsageCostUsd({ prompt_tokens: 2, completion_tokens: 1 });
  assert.deepEqual(events, [
    ["reserve", refused.reservationId],
    ["cancel", refused.reservationId],
    ["reserve", ambiguous.reservationId],
    ["settle", ambiguous.reservationId, ambiguousCost],
    ["reserve", settled.reservationId],
    ["settle", settled.reservationId, settledCost],
  ]);
  budget.close();
});

test("a failed durable cancellation keeps the in-memory reservation charged", () => {
  let allowCancel = false;
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: () => {},
    onCancel() {
      if (!allowCancel) throw new Error("durable cancellation write failed");
    },
  });
  const run = ledger.beginRun({ runId: "cancel-write", perRunUsd: 0.001, perDayUsd: 1 });
  const reservation = run.reserve([{ role: "user", content: "request" }], 100);
  assert.throws(() => run.cancel(reservation), /durable cancellation write failed/);
  assert.throws(() => run.close(), /active reservations/);
  allowCancel = true;
  run.cancel(reservation);
  run.close();
});

test("a failed durable settlement keeps the conservative reservation active", () => {
  let allowSettle = false;
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: () => {},
    onSettle() {
      if (!allowSettle) throw new Error("durable settlement write failed");
    },
  });
  const run = ledger.beginRun({ runId: "settle-write", perRunUsd: 0.001, perDayUsd: 1 });
  const reservation = run.reserve([{ role: "user", content: "request" }], 100);
  assert.throws(
    () => run.settle(reservation, { prompt_tokens: 2, completion_tokens: 1 }),
    /durable settlement write failed/,
  );
  assert.throws(() => run.close(), /active reservations/);
  allowSettle = true;
  run.settle(reservation, { prompt_tokens: 2, completion_tokens: 1 });
  run.close();
});

test("relay retries a durable pre-provider cancellation without losing its handle", async () => {
  let allowCancel = false;
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: () => {},
    onCancel() {
      if (!allowCancel) throw new Error("relay cancellation WAL failed");
    },
  });
  const run = ledger.beginRun({ runId: "relay-cancel-retry", perRunUsd: 1, perDayUsd: 5 });
  const budget = createDeepSeekRelayBudget(run);
  const reservation = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });

  await assert.rejects(
    budget.cancel({ reservationId: reservation.reservationId, ambiguous: false }),
    /relay cancellation WAL failed/,
  );
  allowCancel = true;
  await budget.cancel({ reservationId: reservation.reservationId, ambiguous: false });
  budget.close();
});

test("relay retries a durable settlement without double-charging usage", async () => {
  let allowSettle = false;
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    onReserve: () => {},
    onSettle() {
      if (!allowSettle) throw new Error("relay settlement WAL failed");
    },
  });
  const run = ledger.beginRun({ runId: "relay-settle-retry", perRunUsd: 1, perDayUsd: 5 });
  const budget = createDeepSeekRelayBudget(run);
  const reservation = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  const settlement = {
    reservationId: reservation.reservationId,
    usage: { promptTokens: 2, outputTokens: 1, totalTokens: 3 },
    trusted: true,
  };

  await assert.rejects(budget.settle(settlement), /relay settlement WAL failed/);
  allowSettle = true;
  await budget.settle(settlement);
  assert.deepEqual(budget.usage(), {
    inputTokens: 2,
    outputTokens: 1,
    costUsd: conservativeUsageCostUsd({ prompt_tokens: 2, completion_tokens: 1 }),
    plan: "key",
  });
  budget.close();
});

test("multiple relay calls share one autonomous run ceiling", () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0 });
  const run = ledger.beginRun({ runId: "autonomous", perRunUsd: 0.00002, perDayUsd: 1, tzOffsetMin: 0 });
  const one = run.reserve([{ role: "user", content: "first" }], 100);
  run.settle(one, { prompt_tokens: 10, completion_tokens: 10 });
  assert.throws(
    () => run.reserve([{ role: "user", content: "second" }], 4096),
    (error) => error && error.kind === "budget" && /per-run spending limit/.test(error.message),
  );
});

test("relay refuses a new reservation after its autonomous run crosses UTC midnight", async () => {
  let nowMs = Date.UTC(2026, 7, 14, 23, 59, 59);
  const persisted = [];
  const ledger = createDeepSeekBudgetLedger({
    readTodayUsd: () => 0,
    now: () => nowMs,
    onReserve: (reservation) => persisted.push(reservation),
  });
  const run = ledger.beginRun({ runId: "utc-rollover", perRunUsd: 1, perDayUsd: 5, tzOffsetMin: 0 });
  const budget = createDeepSeekRelayBudget(run);
  const beforeMidnight = await budget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await budget.cancel({ reservationId: beforeMidnight.reservationId, ambiguous: false });

  nowMs = Date.UTC(2026, 7, 15, 0, 0, 1);
  await assert.rejects(
    budget.reserve({ requestBytes: 10, maxOutputTokens: 10 }),
    (error) => error && error.kind === "budget"
      && error.scope === "utc-day-rollover"
      && error.causeName === "dsh_relay_budget_utc_day_changed",
  );
  assert.equal(persisted.length, 1, "no post-rollover reservation reaches the durable/provider authority boundary");
  budget.close();
});

test("relay budget full-charges ambiguous or missing usage and releases pre-provider cancellations", async () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0 });
  const run = ledger.beginRun({ runId: "relay", perRunUsd: 1, perDayUsd: 1, tzOffsetMin: 0 });
  const budget = createDeepSeekRelayBudget(run);

  const ambiguous = await budget.reserve({ runId: "relay", requestBytes: 100, maxOutputTokens: 50 });
  await budget.cancel({ reservationId: ambiguous.reservationId, cause: "dsh_upstream_lost", ambiguous: true });
  const afterAmbiguous = budget.usage();
  assert.ok(afterAmbiguous.inputTokens >= 100)
  assert.equal(afterAmbiguous.outputTokens, 50)
  assert.ok(afterAmbiguous.costUsd > 0)

  const beforeProvider = await budget.reserve({ runId: "relay", requestBytes: 20, maxOutputTokens: 10 });
  await budget.cancel({ reservationId: beforeProvider.reservationId, cause: "dsh_request_invalid", ambiguous: false });
  assert.deepEqual(budget.usage(), afterAmbiguous, "a request refused before provider contact must not spend")

  const trusted = await budget.reserve({ runId: "relay", requestBytes: 30, maxOutputTokens: 10 });
  await budget.settle({
    reservationId: trusted.reservationId,
    usage: { promptTokens: 7, outputTokens: 3, totalTokens: 10 },
    trusted: true,
  });
  assert.equal(budget.usage().inputTokens, afterAmbiguous.inputTokens + 7)
  assert.equal(budget.usage().outputTokens, afterAmbiguous.outputTokens + 3)
  budget.close()
});

test("relay full-charges inconsistent usage and rejects a valid over-bound provider report", async () => {
  const ledger = createDeepSeekBudgetLedger({ readTodayUsd: () => 0 });
  const malformedRun = ledger.beginRun({ runId: "relay-malformed", perRunUsd: 1, perDayUsd: 5 });
  const malformedBudget = createDeepSeekRelayBudget(malformedRun);
  const malformed = await malformedBudget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await malformedBudget.settle({
    reservationId: malformed.reservationId,
    usage: { promptTokens: 0, outputTokens: 0, totalTokens: 1 },
    trusted: true,
  });
  assert.deepEqual(malformedBudget.usage(), {
    inputTokens: 30,
    outputTokens: 10,
    costUsd: conservativeUsageCostUsd({ prompt_tokens: 30, completion_tokens: 10 }),
    plan: "key",
  });
  malformedBudget.close();

  let anomalies = 0;
  const overRun = ledger.beginRun({ runId: "relay-over-bound", perRunUsd: 1, perDayUsd: 5 });
  const overBudget = createDeepSeekRelayBudget(overRun, { onAnomaly() { anomalies += 1; } });
  const over = await overBudget.reserve({ requestBytes: 10, maxOutputTokens: 10 });
  await assert.rejects(overBudget.settle({
    reservationId: over.reservationId,
    usage: { promptTokens: 31, outputTokens: 0, totalTokens: 31 },
    trusted: true,
  }), /exceeded the reserved token bounds/);
  assert.equal(anomalies, 1);
  assert.equal(overBudget.usage().inputTokens, 31, "the larger trusted actual count is durably charged");
  overBudget.close();
});
