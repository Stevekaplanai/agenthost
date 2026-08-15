// deepseek-budget-state.js -- durable, gate-only DeepSeek spending authority.
//
// Every provider request is written here at its worst-case cost before it is
// allowed to leave the gate. A trusted settlement atomically replaces that
// reservation with actual spend; a crash leaves the conservative reservation
// charged. This file is deliberately separate from agent-visible usage.json.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_FILE_NAME = "budget-state.json";
const STATE_VERSION = 2;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_STORED_DAYS = 32;
const MAX_ACTIVE_RESERVATIONS = 1024;
const MAX_IDENTIFIER_BYTES = 192;
const MAX_STORED_USD = 1_000_000;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const DEFAULT_LIMITS = Object.freeze({ perRunUsd: 1, perDayUsd: 5 });
const MAX_PER_RUN_USD = 100;
const MAX_PER_DAY_USD = 1000;

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedCause(error) {
  const text = String(error && error.message || error || "unknown error").replace(/[\r\n]+/g, " ");
  return text.slice(0, 240);
}

function unavailable(message, cause) {
  const detail = cause === undefined ? message : `${message}: ${boundedCause(cause)}`;
  const error = new Error(`DeepSeek budget state unavailable: ${detail}`);
  error.code = "DEEPSEEK_BUDGET_STATE_UNAVAILABLE";
  return error;
}

function assertExactFields(value, fields, label) {
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw unavailable(`${label} contains unexpected field ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) throw unavailable(`${label} is missing field ${key}`);
  }
}

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function requireDay(value) {
  if (!validDay(value)) throw new TypeError("DeepSeek budget day must be a valid local day in YYYY-MM-DD form");
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)
      || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function requireUsd(value, label, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value)
      || value < 0 || (positive && value <= 0) || value > MAX_STORED_USD) {
    throw new TypeError(`${label} must be a ${positive ? "positive" : "nonnegative"} bounded number`);
  }
  return value;
}

function normalizeReservation(value) {
  if (!ownObject(value)) throw new TypeError("DeepSeek budget reservation must be an object");
  return Object.freeze({
    id: requireIdentifier(value.id, "DeepSeek reservation id"),
    runId: requireIdentifier(value.runId, "DeepSeek reservation runId"),
    day: requireDay(value.day),
    reservedUsd: requireUsd(value.reservedUsd, "DeepSeek reservation reservedUsd", true),
  });
}

function normalizeLimits(value) {
  if (!ownObject(value)) throw new TypeError("DeepSeek spending limits must be an object");
  assertExactFields(value, ["perRunUsd", "perDayUsd"], "DeepSeek spending limits");
  const perRunUsd = requireUsd(value.perRunUsd, "DeepSeek spending limits perRunUsd", true);
  const perDayUsd = requireUsd(value.perDayUsd, "DeepSeek spending limits perDayUsd", true);
  if (perRunUsd < 0.01 || perRunUsd > MAX_PER_RUN_USD) {
    throw new TypeError(`DeepSeek spending limits perRunUsd must be from 0.01 to ${MAX_PER_RUN_USD}`);
  }
  if (perDayUsd < 0.01 || perDayUsd > MAX_PER_DAY_USD) {
    throw new TypeError(`DeepSeek spending limits perDayUsd must be from 0.01 to ${MAX_PER_DAY_USD}`);
  }
  return Object.freeze({ perRunUsd, perDayUsd });
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameVersion(left, right) {
  return sameIdentity(left, right)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function createDeepSeekBudgetState(options = {}) {
  const io = options.fsImpl || fs;
  const constants = io.constants || fs.constants;
  const requestedDirectory = String(options.directory || "");
  if (!requestedDirectory || !path.isAbsolute(requestedDirectory)) {
    throw new TypeError("DeepSeek budget state directory must be an absolute path");
  }
  const directory = path.resolve(requestedDirectory);
  const expectedUid = options.expectedUid === undefined
    ? (typeof process.getuid === "function" ? process.getuid() : null)
    : options.expectedUid;
  if (expectedUid !== null && (!Number.isSafeInteger(expectedUid) || expectedUid < 0)) {
    throw new TypeError("DeepSeek budget state expectedUid must be a nonnegative integer");
  }
  const stateFile = path.join(directory, STATE_FILE_NAME);

  function assertOwnerMode(stat, label, mode) {
    if (expectedUid !== null && Number(stat.uid) !== expectedUid) {
      throw unavailable(`${label} owner must be uid ${expectedUid}`);
    }
    if (process.platform !== "win32" && (Number(stat.mode) & 0o7777) !== mode) {
      throw unavailable(`${label} mode must be ${mode.toString(8).padStart(4, "0")}`);
    }
  }

  function inspectDirectory() {
    let leaf;
    try { leaf = io.lstatSync(directory); }
    catch (error) { throw unavailable("could not inspect the dedicated directory", error); }
    if (leaf.isSymbolicLink()) throw unavailable("dedicated directory is a symbolic link");
    if (!leaf.isDirectory()) throw unavailable("dedicated path is not a directory");
    assertOwnerMode(leaf, "dedicated directory", 0o700);

    let resolved;
    try { resolved = path.resolve(io.realpathSync(directory)); }
    catch (error) { throw unavailable("could not resolve the dedicated directory", error); }
    const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    if (comparable(resolved) !== comparable(directory)) {
      throw unavailable("dedicated directory path resolves through a symbolic link");
    }

    if (process.platform !== "win32") {
      let descriptor = null;
      try {
        descriptor = io.openSync(directory,
          constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
        const opened = io.fstatSync(descriptor);
        if (!opened.isDirectory() || !sameIdentity(leaf, opened)) {
          throw unavailable("dedicated directory changed during validation");
        }
        assertOwnerMode(opened, "dedicated directory", 0o700);
      } catch (error) {
        if (error && error.code === "DEEPSEEK_BUDGET_STATE_UNAVAILABLE") throw error;
        throw unavailable("could not pin the dedicated directory", error);
      } finally {
        if (descriptor !== null) { try { io.closeSync(descriptor); } catch {} }
      }
    }
    return leaf;
  }

  function validateStateLeaf(leaf, label = "state file", allowEmpty = false) {
    if (leaf.isSymbolicLink()) throw unavailable(`${label} is a symbolic link`);
    if (!leaf.isFile()) throw unavailable(`${label} is not a private regular file`);
    if (Number(leaf.nlink) !== 1) throw unavailable(`${label} has multiple hard links`);
    if (Number(leaf.size) < (allowEmpty ? 0 : 1) || Number(leaf.size) > MAX_STATE_BYTES) {
      throw unavailable(`${label} size is outside the safe bound`);
    }
    assertOwnerMode(leaf, label, 0o600);
  }

  function emptyState() {
    return { limits: normalizeLimits(DEFAULT_LIMITS), days: new Map(), needsMigration: false };
  }

  function parseState(text) {
    let value;
    try { value = JSON.parse(text); }
    catch (error) { throw unavailable("state file contains invalid JSON", error); }
    if (!ownObject(value)) throw unavailable("state file root must be an object");
    if (value.version === 1) {
      assertExactFields(value, ["version", "days"], "state file root");
    } else if (value.version === STATE_VERSION) {
      assertExactFields(value, ["version", "limits", "days"], "state file root");
    } else {
      throw unavailable("state file version is unsupported");
    }
    if (!ownObject(value.days)) throw unavailable("state file days must be an object");
    const dayNames = Object.keys(value.days);
    if (dayNames.length > MAX_STORED_DAYS) throw unavailable("state file retains too many days");

    const state = emptyState();
    state.needsMigration = value.version === 1;
    if (value.version === STATE_VERSION) {
      try { state.limits = normalizeLimits(value.limits); }
      catch (error) { throw unavailable("state file has invalid spending limits", error); }
    }
    const seenIds = new Set();
    let reservationCount = 0;
    for (const day of dayNames) {
      if (!validDay(day)) throw unavailable(`state file contains invalid local day ${day}`);
      const record = value.days[day];
      if (!ownObject(record)) throw unavailable(`state file day ${day} must be an object`);
      assertExactFields(record, ["settledUsd", "reservations"], `state file day ${day}`);
      let settledUsd;
      try { settledUsd = requireUsd(record.settledUsd, `state file day ${day} settledUsd`); }
      catch (error) { throw unavailable(`state file day ${day} has invalid settled spend`, error); }
      if (!Array.isArray(record.reservations)) {
        throw unavailable(`state file day ${day} reservations must be an array`);
      }
      const reservations = new Map();
      for (const item of record.reservations) {
        if (!ownObject(item)) throw unavailable(`state file day ${day} contains an invalid reservation`);
        assertExactFields(item, ["id", "runId", "reservedUsd"], `state file day ${day} reservation`);
        let normalized;
        try { normalized = normalizeReservation({ ...item, day }); }
        catch (error) { throw unavailable(`state file day ${day} contains an invalid reservation`, error); }
        if (seenIds.has(normalized.id)) throw unavailable(`state file repeats reservation ${normalized.id}`);
        seenIds.add(normalized.id);
        reservations.set(normalized.id, normalized);
        reservationCount += 1;
        if (reservationCount > MAX_ACTIVE_RESERVATIONS) {
          throw unavailable("state file contains too many active reservations");
        }
      }
      const reservedUsd = [...reservations.values()].reduce((sum, item) => sum + item.reservedUsd, 0);
      if (!Number.isFinite(settledUsd + reservedUsd) || settledUsd + reservedUsd > MAX_STORED_USD) {
        throw unavailable(`state file day ${day} total spend is outside the safe bound`);
      }
      state.days.set(day, { settledUsd, reservations });
    }
    return state;
  }

  function readState() {
    const directoryBefore = inspectDirectory();
    let leaf;
    try { leaf = io.lstatSync(stateFile); }
    catch (error) {
      if (error && error.code === "ENOENT") {
        let directoryAfter;
        try { directoryAfter = inspectDirectory(); }
        catch (cause) {
          throw unavailable("state leaf was missing and the dedicated directory could not be revalidated", cause);
        }
        if (!sameIdentity(directoryBefore, directoryAfter)) {
          throw unavailable("dedicated directory changed while the missing state leaf was checked");
        }
        return emptyState();
      }
      throw unavailable("could not inspect the state file", error);
    }
    validateStateLeaf(leaf);
    let descriptor = null;
    try {
      descriptor = io.openSync(stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = io.fstatSync(descriptor);
      validateStateLeaf(opened);
      if (!sameVersion(leaf, opened)) throw unavailable("state file changed before it could be read");
      const text = io.readFileSync(descriptor, "utf8");
      const after = io.fstatSync(descriptor);
      const current = io.lstatSync(stateFile);
      validateStateLeaf(after);
      validateStateLeaf(current);
      if (!sameVersion(opened, after) || !sameVersion(opened, current)) {
        throw unavailable("state file changed while it was being read");
      }
      return parseState(text);
    } catch (error) {
      if (error && error.code === "DEEPSEEK_BUDGET_STATE_UNAVAILABLE") throw error;
      throw unavailable("could not read the state file", error);
    } finally {
      if (descriptor !== null) { try { io.closeSync(descriptor); } catch {} }
    }
  }

  function pruneState(state, protectedDay) {
    for (const [day, record] of state.days) {
      if (day !== protectedDay && record.settledUsd === 0 && record.reservations.size === 0) {
        state.days.delete(day);
      }
    }
    while (state.days.size > MAX_STORED_DAYS) {
      const oldest = [...state.days.keys()].sort().find((day) => {
        const record = state.days.get(day);
        return day !== protectedDay && record.reservations.size === 0;
      });
      if (!oldest) throw unavailable("state history cannot be pruned without dropping an active reservation");
      state.days.delete(oldest);
    }
  }

  function serializeState(state) {
    const days = {};
    for (const day of [...state.days.keys()].sort()) {
      const record = state.days.get(day);
      days[day] = {
        settledUsd: record.settledUsd,
        reservations: [...record.reservations.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((item) => ({ id: item.id, runId: item.runId, reservedUsd: item.reservedUsd })),
      };
    }
    const payload = Buffer.from(JSON.stringify({ version: STATE_VERSION, limits: state.limits, days }) + "\n", "utf8");
    if (payload.length > MAX_STATE_BYTES) throw unavailable("new state exceeds the safe size bound");
    return payload;
  }

  function migrateIfNeeded(state) {
    if (!state.needsMigration) return state;
    writeState(state);
    state.needsMigration = false;
    return state;
  }

  function writeState(state) {
    const directoryStat = inspectDirectory();
    const payload = serializeState(state);
    const temp = path.join(directory,
      `.${STATE_FILE_NAME}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
    let descriptor = null;
    let renamed = false;
    try {
      descriptor = io.openSync(temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      const opened = io.fstatSync(descriptor);
      validateStateLeaf(opened, "temporary state file", true);
      io.writeFileSync(descriptor, payload);
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = null;
      const temporaryLeaf = io.lstatSync(temp);
      validateStateLeaf(temporaryLeaf, "temporary state file");
      io.renameSync(temp, stateFile);
      renamed = true;
      const published = io.lstatSync(stateFile);
      validateStateLeaf(published);
      if (!sameIdentity(temporaryLeaf, published)) {
        throw unavailable("published state file does not match the flushed temporary file");
      }

      if (process.platform !== "win32") {
        let directoryDescriptor = null;
        try {
          directoryDescriptor = io.openSync(directory,
            constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
          const currentDirectory = io.fstatSync(directoryDescriptor);
          if (!currentDirectory.isDirectory() || !sameIdentity(directoryStat, currentDirectory)) {
            throw unavailable("dedicated directory changed before publication was durable");
          }
          assertOwnerMode(currentDirectory, "dedicated directory", 0o700);
          io.fsyncSync(directoryDescriptor);
        } finally {
          if (directoryDescriptor !== null) io.closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      if (error && error.code === "DEEPSEEK_BUDGET_STATE_UNAVAILABLE") throw error;
      throw unavailable("could not durably save the state file", error);
    } finally {
      if (descriptor !== null) { try { io.closeSync(descriptor); } catch {} }
      if (!renamed) { try { io.unlinkSync(temp); } catch {} }
    }
  }

  function findReservation(state, expected) {
    const record = state.days.get(expected.day);
    const stored = record && record.reservations.get(expected.id);
    if (!stored) throw new Error(`DeepSeek budget reservation ${expected.id} is not active`);
    if (stored.runId !== expected.runId || stored.reservedUsd !== expected.reservedUsd) {
      throw new Error(`DeepSeek budget reservation ${expected.id} does not match the active reservation`);
    }
    return { record, stored };
  }

  return Object.freeze({
    limits() {
      return normalizeLimits(migrateIfNeeded(readState()).limits);
    },

    setLimits(value) {
      const limits = normalizeLimits(value);
      const state = readState();
      state.limits = limits;
      writeState(state);
      return limits;
    },

    todayUsd(dayValue) {
      const day = requireDay(dayValue);
      const record = migrateIfNeeded(readState()).days.get(day);
      if (!record) return 0;
      return record.settledUsd
        + [...record.reservations.values()].reduce((sum, item) => sum + item.reservedUsd, 0);
    },

    reserve(value) {
      const held = normalizeReservation(value);
      const state = readState();
      for (const record of state.days.values()) {
        if (record.reservations.has(held.id)) {
          throw new Error(`DeepSeek budget reservation ${held.id} is already active`);
        }
      }
      const reservationCount = [...state.days.values()]
        .reduce((sum, record) => sum + record.reservations.size, 0);
      if (reservationCount >= MAX_ACTIVE_RESERVATIONS) {
        throw unavailable("active reservation limit has been reached");
      }
      const record = state.days.get(held.day) || { settledUsd: 0, reservations: new Map() };
      if (record.settledUsd + [...record.reservations.values()]
        .reduce((sum, item) => sum + item.reservedUsd, held.reservedUsd) > MAX_STORED_USD) {
        throw unavailable(`state file day ${held.day} total spend is outside the safe bound`);
      }
      record.reservations.set(held.id, held);
      state.days.set(held.day, record);
      pruneState(state, held.day);
      writeState(state);
      return held;
    },

    settle(value, costValue) {
      const expected = normalizeReservation(value);
      const costUsd = requireUsd(costValue, "DeepSeek settlement costUsd");
      const state = readState();
      const { record } = findReservation(state, expected);
      const remainingReservedUsd = [...record.reservations.values()]
        .reduce((sum, item) => sum + (item.id === expected.id ? 0 : item.reservedUsd), 0);
      if (record.settledUsd + costUsd + remainingReservedUsd > MAX_STORED_USD) {
        throw unavailable(`state file day ${expected.day} settled spend is outside the safe bound`);
      }
      record.settledUsd += costUsd;
      record.reservations.delete(expected.id);
      pruneState(state, expected.day);
      writeState(state);
      return costUsd;
    },

    cancel(value) {
      const expected = normalizeReservation(value);
      const state = readState();
      const { record } = findReservation(state, expected);
      record.reservations.delete(expected.id);
      pruneState(state, expected.day);
      writeState(state);
      return true;
    },
  });
}

module.exports = {
  DEFAULT_LIMITS,
  MAX_STORED_DAYS,
  STATE_FILE_NAME,
  createDeepSeekBudgetState,
};
