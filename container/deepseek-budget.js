// deepseek-budget.js -- hard spending ceilings for every DeepSeek request.
//
// The provider reports usage only after a response, so the gate reserves a
// conservative worst case BEFORE sending. Input is bounded by UTF-8 bytes (a
// token cannot consume fewer than one encoded byte), output is clamped with the
// provider's max_completion_tokens field, and concurrent runs share one daily
// reservation ledger. Actual usage replaces the reservation when it arrives.

"use strict";

// DeepSeek's announced 2026-08-16 PEAK prices for DeepSeek-V4-Flash. The launch
// discount and cache-hit price are intentionally ignored: ceilings must remain
// safe after the scheduled price change and when no prompt cache hits.
const DEEPSEEK_V4_FLASH_PEAK_PRICES = Object.freeze({
  inputUsdPerMillion: 0.44,
  outputUsdPerMillion: 1.32,
});

const MAX_PROVIDER_OUTPUT_TOKENS = 4096;
const EPSILON = 1e-12;

function finiteNonnegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function promptTokenUpperBound(messages) {
  if (!Array.isArray(messages)) throw new TypeError("DeepSeek messages must be an array");
  let bytes = 0;
  for (const message of messages) {
    const role = String(message && message.role || "");
    const content = messageText(message && message.content);
    bytes += Buffer.byteLength(role, "utf8") + Buffer.byteLength(content, "utf8") + 16;
  }
  return bytes;
}

function conservativeUsageCostUsd(usage) {
  const input = finiteNonnegative(usage && (usage.prompt_tokens ?? usage.inputTokens));
  const output = finiteNonnegative(usage && (usage.completion_tokens ?? usage.outputTokens));
  return (input * DEEPSEEK_V4_FLASH_PEAK_PRICES.inputUsdPerMillion
    + output * DEEPSEEK_V4_FLASH_PEAK_PRICES.outputUsdPerMillion) / 1_000_000;
}

function worstCaseCostUsd(inputTokenUpperBound, outputTokens) {
  return conservativeUsageCostUsd({
    prompt_tokens: inputTokenUpperBound,
    completion_tokens: outputTokens,
  });
}

function normalizeDeepSeekProviderUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const promptTokens = usage.prompt_tokens ?? usage.promptTokens;
  const completionTokens = usage.completion_tokens ?? usage.outputTokens;
  const totalTokens = usage.total_tokens ?? usage.totalTokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0
      || !Number.isSafeInteger(completionTokens) || completionTokens < 0
      || !Number.isSafeInteger(totalTokens) || totalTokens < 0
      || totalTokens !== promptTokens + completionTokens) return null;
  return Object.freeze({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  });
}

function deepSeekUsageForReservation(usage, reservation) {
  if (!reservation || !Number.isSafeInteger(reservation.inputTokenUpperBound)
      || !Number.isSafeInteger(reservation.maxCompletionTokens)) {
    throw new TypeError("DeepSeek usage validation requires a budget reservation");
  }
  const normalized = normalizeDeepSeekProviderUsage(usage);
  if (!normalized) {
    return Object.freeze({
      usage: Object.freeze({
        prompt_tokens: reservation.inputTokenUpperBound,
        completion_tokens: reservation.maxCompletionTokens,
        total_tokens: reservation.inputTokenUpperBound + reservation.maxCompletionTokens,
      }),
      trusted: false,
      exceededBounds: false,
    });
  }
  return Object.freeze({
    usage: normalized,
    trusted: true,
    exceededBounds: normalized.prompt_tokens > reservation.inputTokenUpperBound
      || normalized.completion_tokens > reservation.maxCompletionTokens,
  });
}

function localDay(nowMs, tzOffsetMin) {
  const offset = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  return new Date(nowMs + offset * 60_000).toISOString().slice(0, 10);
}

function budgetError(scope) {
  const error = new Error(`DeepSeek ${scope} spending limit leaves no safe budget for this request`);
  error.kind = "budget";
  error.scope = scope;
  return error;
}

function utcDayRolloverError() {
  const error = new Error("DeepSeek autonomous run crossed the UTC budget day; start a new run");
  error.kind = "budget";
  error.scope = "utc-day-rollover";
  error.causeName = "dsh_relay_budget_utc_day_changed";
  return error;
}

function positiveLimit(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive number`);
  return n;
}

function synchronousHook(options, name) {
  const hook = options[name];
  if (hook === undefined) return () => {};
  if (typeof hook !== "function") throw new TypeError(`DeepSeek ${name} must be a function`);
  return (...args) => {
    const result = hook(...args);
    if (result != null
        && (typeof result === "object" || typeof result === "function")
        && typeof result.then === "function") {
      throw new TypeError(`DeepSeek ${name} must be synchronous`);
    }
    return result;
  };
}

function createDeepSeekBudgetLedger(options = {}) {
  const readTodayUsd = typeof options.readTodayUsd === "function" ? options.readTodayUsd : () => 0;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onReserve = synchronousHook(options, "onReserve");
  const onSettle = synchronousHook(options, "onSettle");
  const onCancel = synchronousHook(options, "onCancel");
  const dayBaseUsd = new Map();
  const daySettledUsd = new Map();
  const dayReservedUsd = new Map();
  const activeRunIds = new Set();
  let nextReservationId = 1;

  function baseFor(day) {
    if (!dayBaseUsd.has(day)) {
      const value = Number(readTodayUsd(day));
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError("DeepSeek durable daily spend must be a finite nonnegative number");
      }
      dayBaseUsd.set(day, value);
    }
    return dayBaseUsd.get(day);
  }

  function changeDayReservation(day, delta) {
    const next = Math.max(0, (dayReservedUsd.get(day) || 0) + delta);
    if (next <= EPSILON) dayReservedUsd.delete(day);
    else dayReservedUsd.set(day, next);
  }

  function beginRun({ runId, perRunUsd, perDayUsd, tzOffsetMin = 0 }) {
    const id = String(runId || "").trim();
    if (!id) throw new TypeError("DeepSeek runId is required");
    if (activeRunIds.has(id)) throw new Error(`DeepSeek budget run ${id} is already active`);
    const runLimit = positiveLimit(perRunUsd, "DeepSeek per-run limit");
    const dayLimit = positiveLimit(perDayUsd, "DeepSeek daily limit");
    const day = localDay(now(), tzOffsetMin);
    const reservations = new Map();
    let settledUsd = 0;
    let closed = false;
    activeRunIds.add(id);

    function ensureOpen() {
      if (closed) throw new Error(`DeepSeek budget run ${id} is closed`);
    }

    function requireReservation(reservation) {
      const stored = reservation && reservations.get(reservation.id);
      if (!stored || stored !== reservation) throw new Error("DeepSeek budget reservation is not active");
      return stored;
    }

    function removeReservation(reservation) {
      requireReservation(reservation);
      reservations.delete(reservation.id);
      changeDayReservation(day, -reservation.reservedUsd);
    }

    return Object.freeze({
      reserve(messages, requestedMaxOutputTokens = MAX_PROVIDER_OUTPUT_TOKENS) {
        ensureOpen();
        if (localDay(now(), tzOffsetMin) !== day) throw utcDayRolloverError();
        const requested = Math.min(
          MAX_PROVIDER_OUTPUT_TOKENS,
          Math.max(1, Math.trunc(Number(requestedMaxOutputTokens) || MAX_PROVIDER_OUTPUT_TOKENS)),
        );
        const runReserved = [...reservations.values()].reduce((sum, item) => sum + item.reservedUsd, 0);
        const availableRun = Math.max(0, runLimit - settledUsd - runReserved);
        const usedDay = baseFor(day) + (daySettledUsd.get(day) || 0) + (dayReservedUsd.get(day) || 0);
        const availableDay = Math.max(0, dayLimit - usedDay);
        const available = Math.min(availableRun, availableDay);
        const limitingScope = availableRun <= availableDay ? "per-run" : "daily";
        const inputUpperBound = promptTokenUpperBound(messages);
        const inputCost = worstCaseCostUsd(inputUpperBound, 0);
        const oneOutputTokenCost = worstCaseCostUsd(0, 1);
        if (available + EPSILON < inputCost + oneOutputTokenCost) throw budgetError(limitingScope);
        const affordableOutput = Math.floor(
          ((available - inputCost) * 1_000_000) / DEEPSEEK_V4_FLASH_PEAK_PRICES.outputUsdPerMillion,
        );
        const maxCompletionTokens = Math.min(requested, affordableOutput);
        if (maxCompletionTokens < 1) throw budgetError(limitingScope);
        const reservedUsd = worstCaseCostUsd(inputUpperBound, maxCompletionTokens);
        const reservation = Object.freeze({
          id: `${id}:${nextReservationId++}`,
          runId: id,
          day,
          maxCompletionTokens,
          inputTokenUpperBound: inputUpperBound,
          reservedUsd,
        });
        // This synchronous hook is the write-ahead boundary: the worst-case
        // charge must be durable before either the in-memory ledger or the
        // provider-facing relay can observe an admitted reservation.
        onReserve(reservation);
        reservations.set(reservation.id, reservation);
        changeDayReservation(day, reservedUsd);
        return reservation;
      },

      settle(reservation, usage) {
        ensureOpen();
        const stored = requireReservation(reservation);
        const costUsd = conservativeUsageCostUsd(usage);
        // Atomically replace the durable worst-case reservation with actual (or
        // deliberately conservative ambiguous) spend before releasing memory.
        // A hook failure therefore leaves the larger reservation fail-closed.
        onSettle(stored, costUsd);
        removeReservation(stored);
        settledUsd += costUsd;
        daySettledUsd.set(day, (daySettledUsd.get(day) || 0) + costUsd);
        return Object.freeze({
          costUsd,
          exceededReservation: costUsd > reservation.reservedUsd + EPSILON,
          exceededRunLimit: settledUsd > runLimit + EPSILON,
          exceededDayLimit: baseFor(day) + (daySettledUsd.get(day) || 0) > dayLimit + EPSILON,
        });
      },

      cancel(reservation) {
        ensureOpen();
        const stored = requireReservation(reservation);
        // Only a request proven not to have reached the provider may erase its
        // durable write-ahead charge. Keep it active if persistence is unsure.
        onCancel(stored);
        removeReservation(stored);
      },

      spentUsd() { return settledUsd; },

      close() {
        ensureOpen();
        if (reservations.size) throw new Error(`DeepSeek budget run ${id} still has active reservations`);
        closed = true;
        activeRunIds.delete(id);
      },
    });
  }

  return Object.freeze({ beginRun });
}

// Adapts the run ledger to the gate-owned DSH relay capability. The harness may
// issue more than one provider request, but every request shares this one run
// ceiling. A response without trusted usage, or a provider request whose final
// outcome is ambiguous, is charged at the reservation's conservative maximum.
function createDeepSeekRelayBudget(run, options = {}) {
  if (!run || typeof run.reserve !== "function" || typeof run.settle !== "function"
      || typeof run.cancel !== "function" || typeof run.close !== "function") {
    throw new TypeError("DeepSeek relay budget requires an open budget run");
  }
  const reservations = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let closed = false;
  const onAnomaly = synchronousHook(options, "onAnomaly");

  function active(reservationId) {
    const reservation = reservations.get(String(reservationId || ""));
    if (!reservation) throw new Error("DeepSeek relay budget reservation is not active");
    return reservation;
  }

  function charge(reservation, usage) {
    const settlement = deepSeekUsageForReservation(usage, reservation);
    const result = run.settle(reservation, settlement.usage);
    inputTokens += settlement.usage.prompt_tokens;
    outputTokens += settlement.usage.completion_tokens;
    costUsd += result.costUsd;
    return { settlement, result };
  }

  return Object.freeze({
    async reserve({ requestBytes, maxOutputTokens } = {}) {
      if (closed) throw new Error("DeepSeek relay budget is closed");
      const bytes = Number(requestBytes);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 * 1024) {
        throw new TypeError("DeepSeek relay requestBytes must be an integer from 0 to 1048576");
      }
      const reservation = run.reserve([{ role: "user", content: "x".repeat(bytes) }], maxOutputTokens);
      reservations.set(reservation.id, reservation);
      return { reservationId: reservation.id, maxOutputTokens: reservation.maxCompletionTokens };
    },

    async settle({ reservationId, usage, trusted } = {}) {
      const reservation = active(reservationId);
      const outcome = charge(reservation, trusted === true ? usage : null);
      reservations.delete(reservation.id);
      if (outcome.settlement.exceededBounds) {
        onAnomaly(new Error("DeepSeek provider usage exceeded the reserved token bounds"));
        throw new Error("DeepSeek provider usage exceeded the reserved token bounds");
      }
    },

    async cancel({ reservationId, ambiguous } = {}) {
      const reservation = active(reservationId);
      if (ambiguous === true) {
        charge(reservation, null);
      } else {
        run.cancel(reservation);
      }
      reservations.delete(reservation.id);
    },

    usage() { return Object.freeze({ inputTokens, outputTokens, costUsd, plan: "key" }); },

    close() {
      if (closed) return;
      if (reservations.size) throw new Error("DeepSeek relay budget still has active reservations");
      run.close();
      closed = true;
    },
  });
}

module.exports = {
  DEEPSEEK_V4_FLASH_PEAK_PRICES,
  MAX_PROVIDER_OUTPUT_TOKENS,
  conservativeUsageCostUsd,
  promptTokenUpperBound,
  normalizeDeepSeekProviderUsage,
  deepSeekUsageForReservation,
  createDeepSeekBudgetLedger,
  createDeepSeekRelayBudget,
};
