import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_LIMITS,
  MAX_STORED_DAYS,
  STATE_FILE_NAME,
  createDeepSeekBudgetState,
} = require("../container/deepseek-budget-state.js");

const ROOT = path.join(import.meta.dirname, "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-budget-state-"));
  const directory = path.join(root, "deepseek-budget");
  fs.mkdirSync(directory, { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, file: path.join(directory, STATE_FILE_NAME) };
}

function reservation(overrides = {}) {
  return {
    id: "deepseek:autonomy:run-1:1",
    runId: "deepseek:autonomy:run-1",
    day: "2026-08-13",
    reservedUsd: 0.75,
    ...overrides,
  };
}

function instrumentedFs(operations) {
  const io = Object.create(fs);
  const fdPaths = new Map();
  io.openSync = (file, flags, mode) => {
    const descriptor = fs.openSync(file, flags, mode);
    fdPaths.set(descriptor, String(file));
    operations.push({ type: "open", file: String(file), flags });
    return descriptor;
  };
  io.closeSync = (descriptor) => {
    operations.push({ type: "close", file: fdPaths.get(descriptor) });
    fdPaths.delete(descriptor);
    return fs.closeSync(descriptor);
  };
  io.fsyncSync = (descriptor) => {
    operations.push({ type: "fsync", file: fdPaths.get(descriptor) });
    return fs.fsyncSync(descriptor);
  };
  io.renameSync = (from, to) => {
    operations.push({ type: "rename", from: String(from), to: String(to) });
    return fs.renameSync(from, to);
  };
  return io;
}

test("spending limits live in the private state and survive agent-visible setting changes", (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });

  assert.deepEqual(state.limits(), DEFAULT_LIMITS, "a new protected store starts from immutable safe defaults");
  assert.deepEqual(state.setLimits({ perRunUsd: 0.5, perDayUsd: 2 }), {
    perRunUsd: 0.5,
    perDayUsd: 2,
  });
  assert.deepEqual(createDeepSeekBudgetState({ directory: paths.directory }).limits(), {
    perRunUsd: 0.5,
    perDayUsd: 2,
  }, "operator limits persist independently of the agent-visible settings file");

  const saved = JSON.parse(fs.readFileSync(paths.file, "utf8"));
  assert.deepEqual(saved.limits, { perRunUsd: 0.5, perDayUsd: 2 });
  assert.throws(() => state.setLimits({ perRunUsd: 0, perDayUsd: 2 }), /perRunUsd/i);
  assert.throws(() => state.setLimits({ perRunUsd: 0.5, perDayUsd: 1001 }), /perDayUsd/i);
  assert.deepEqual(state.limits(), { perRunUsd: 0.5, perDayUsd: 2 }, "invalid updates change nothing");
});

test("legacy v1 spend state migrates to protected default limits without losing reservations", (t) => {
  const paths = fixture(t);
  const held = reservation();
  fs.writeFileSync(paths.file, JSON.stringify({
    version: 1,
    days: {
      [held.day]: {
        settledUsd: 0.1,
        reservations: [{ id: held.id, runId: held.runId, reservedUsd: held.reservedUsd }],
      },
    },
  }) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(paths.file, 0o600);

  const state = createDeepSeekBudgetState({ directory: paths.directory });
  assert.deepEqual(state.limits(), DEFAULT_LIMITS);
  assert.equal(state.todayUsd(held.day), 0.85);
  const migrated = JSON.parse(fs.readFileSync(paths.file, "utf8"));
  assert.equal(migrated.version, 2, "the first authority read durably migrates before admission");
  assert.deepEqual(migrated.limits, DEFAULT_LIMITS);
  assert.equal(migrated.days[held.day].reservations.length, 1);
  state.setLimits({ perRunUsd: 0.25, perDayUsd: 1 });
  const saved = JSON.parse(fs.readFileSync(paths.file, "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.days[held.day].reservations.length, 1);
});

test("a write-ahead reservation survives restart and is replaced by settled spend", (t) => {
  const paths = fixture(t);
  const held = reservation();
  const first = createDeepSeekBudgetState({ directory: paths.directory });

  assert.equal(first.todayUsd(held.day), 0);
  assert.deepEqual(first.reserve(held), held);
  assert.equal(first.todayUsd(held.day), held.reservedUsd);

  const afterCrash = createDeepSeekBudgetState({ directory: paths.directory });
  assert.equal(afterCrash.todayUsd(held.day), held.reservedUsd,
    "an unclosed provider reservation remains charged after process loss");
  assert.equal(afterCrash.settle(held, 0.125), 0.125);
  assert.equal(afterCrash.todayUsd(held.day), 0.125);

  const afterSettlement = createDeepSeekBudgetState({ directory: paths.directory });
  assert.equal(afterSettlement.todayUsd(held.day), 0.125);
  const saved = JSON.parse(fs.readFileSync(paths.file, "utf8"));
  assert.equal(saved.days[held.day].settledUsd, 0.125);
  assert.deepEqual(saved.days[held.day].reservations, []);
});

test("cancel removes only an exact active reservation and unknown operations fail closed", (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });
  const held = reservation();
  state.reserve(held);

  assert.throws(() => state.settle({ ...held, reservedUsd: 0.74 }, 0.1), /does not match the active reservation/i);
  assert.throws(() => state.cancel({ ...held, id: `${held.id}-unknown` }), /is not active/i);
  assert.equal(state.todayUsd(held.day), held.reservedUsd);
  assert.equal(state.cancel(held), true);
  assert.equal(state.todayUsd(held.day), 0);
  assert.throws(() => state.cancel(held), /is not active/i);
});

test("only a missing state leaf is empty; corrupt, wrong-type, and read errors deny access", (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });
  assert.equal(state.todayUsd("2026-08-13"), 0);

  const racePaths = fixture(t);
  const disappearingParent = Object.create(fs);
  disappearingParent.lstatSync = (target, options) => {
    if (path.resolve(String(target)) === path.resolve(racePaths.file)) {
      fs.rmSync(racePaths.directory, { recursive: true });
      const error = new Error("injected missing state ancestor");
      error.code = "ENOENT";
      throw error;
    }
    return fs.lstatSync(target, options);
  };
  assert.throws(
    () => createDeepSeekBudgetState({
      directory: racePaths.directory,
      fsImpl: disappearingParent,
    }).todayUsd("2026-08-13"),
    (error) => error.code === "DEEPSEEK_BUDGET_STATE_UNAVAILABLE"
      && /dedicated directory could not be revalidated/i.test(error.message),
  );

  fs.writeFileSync(paths.file, "not json\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(paths.file, 0o600);
  assert.throws(() => state.todayUsd("2026-08-13"), /invalid JSON/i);

  fs.rmSync(paths.file);
  fs.mkdirSync(paths.file);
  assert.throws(() => state.todayUsd("2026-08-13"), /not a private regular file/i);
  fs.rmSync(paths.file, { recursive: true });
  fs.writeFileSync(paths.file, JSON.stringify({ version: 1, days: {} }) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(paths.file, 0o600);

  const denied = Object.create(fs);
  denied.openSync = (file, flags, mode) => {
    if (path.basename(String(file)) === STATE_FILE_NAME) {
      const error = new Error("injected state read failure");
      error.code = "EIO";
      throw error;
    }
    return fs.openSync(file, flags, mode);
  };
  assert.throws(
    () => createDeepSeekBudgetState({ directory: paths.directory, fsImpl: denied }).todayUsd("2026-08-13"),
    /injected state read failure/i,
  );
});

test("schema, identifiers, dates, values, and retained history are bounded", (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });
  assert.throws(() => createDeepSeekBudgetState({ directory: "relative/budget-state" }), /absolute path/i);
  assert.throws(() => state.todayUsd("2026-02-30"), /valid local day/i);
  assert.throws(() => state.reserve(reservation({ id: "bad id" })), /reservation id/i);
  assert.throws(() => state.reserve(reservation({ reservedUsd: Number.POSITIVE_INFINITY })), /reservedUsd/i);

  for (let index = 0; index <= MAX_STORED_DAYS; index += 1) {
    const day = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    const held = reservation({
      id: `deepseek:daily:run-${index}:1`,
      runId: `deepseek:daily:run-${index}`,
      day,
      reservedUsd: 0.2,
    });
    state.reserve(held);
    state.settle(held, 0.05);
  }
  const saved = JSON.parse(fs.readFileSync(paths.file, "utf8"));
  assert.equal(Object.keys(saved.days).length, MAX_STORED_DAYS);
  assert.equal(saved.days["2026-01-01"], undefined, "the oldest completed day is pruned");
  assert.equal(saved.days["2026-02-02"].settledUsd, 0.05, "the day being written is never pruned");

  fs.writeFileSync(paths.file, JSON.stringify({ version: 1, days: {}, unexpected: true }) + "\n");
  if (process.platform !== "win32") fs.chmodSync(paths.file, 0o600);
  assert.throws(() => state.todayUsd("2026-08-13"), /unexpected field/i);
});

test("history pressure never prunes a conservative crash reservation", (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });
  const held = [];
  for (let index = 0; index < MAX_STORED_DAYS; index += 1) {
    const day = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    const item = reservation({
      id: `deepseek:crash:run-${index}:1`,
      runId: `deepseek:crash:run-${index}`,
      day,
      reservedUsd: 0.2,
    });
    state.reserve(item);
    held.push(item);
  }
  const overflow = reservation({
    id: "deepseek:crash:overflow:1",
    runId: "deepseek:crash:overflow",
    day: "2026-02-02",
    reservedUsd: 0.2,
  });
  assert.throws(() => state.reserve(overflow), /without dropping an active reservation/i);

  const afterFailure = createDeepSeekBudgetState({ directory: paths.directory });
  for (const item of held) assert.equal(afterFailure.todayUsd(item.day), item.reservedUsd);
  assert.equal(afterFailure.todayUsd(overflow.day), 0);
});

test("state leaves reject symbolic links, hard links, and unsafe permissions", {
  skip: process.platform === "win32" ? "POSIX ownership and mode enforcement runs in Linux CI" : false,
}, (t) => {
  const paths = fixture(t);
  const state = createDeepSeekBudgetState({ directory: paths.directory });
  state.reserve(reservation());

  fs.chmodSync(paths.file, 0o640);
  assert.throws(() => state.todayUsd("2026-08-13"), /mode must be 0600/i);
  fs.chmodSync(paths.file, 0o600);

  const linked = path.join(paths.root, "linked-budget-state.json");
  fs.linkSync(paths.file, linked);
  assert.throws(() => state.todayUsd("2026-08-13"), /multiple hard links/i);
  fs.unlinkSync(linked);

  const victim = path.join(paths.root, "victim.json");
  fs.writeFileSync(victim, fs.readFileSync(paths.file), { mode: 0o600 });
  fs.unlinkSync(paths.file);
  fs.symlinkSync(victim, paths.file);
  assert.throws(() => state.todayUsd("2026-08-13"), /symbolic link/i);
});

test("the dedicated directory rejects symlinks and unsafe permissions", {
  skip: process.platform === "win32" ? "POSIX directory ownership and mode enforcement runs in Linux CI" : false,
}, (t) => {
  const paths = fixture(t);
  fs.chmodSync(paths.directory, 0o750);
  assert.throws(
    () => createDeepSeekBudgetState({ directory: paths.directory }).todayUsd("2026-08-13"),
    /directory mode must be 0700/i,
  );
  fs.chmodSync(paths.directory, 0o700);

  const alias = path.join(paths.root, "budget-alias");
  fs.symlinkSync(paths.directory, alias, "dir");
  assert.throws(
    () => createDeepSeekBudgetState({ directory: alias }).todayUsd("2026-08-13"),
    /directory is a symbolic link/i,
  );
});

test("the dedicated directory must belong to the expected gate uid", (t) => {
  const paths = fixture(t);
  const actualUid = Number(fs.lstatSync(paths.directory).uid);
  assert.throws(
    () => createDeepSeekBudgetState({
      directory: paths.directory,
      expectedUid: actualUid + 1,
    }).todayUsd("2026-08-13"),
    /owner must be uid/i,
  );
});

test("writes use an exclusive no-follow same-directory temp, then fsync file, rename, and fsync parent", (t) => {
  const paths = fixture(t);
  const operations = [];
  const io = instrumentedFs(operations);
  const state = createDeepSeekBudgetState({ directory: paths.directory, fsImpl: io });
  const held = reservation();
  state.reserve(held);
  state.settle(held, 0.1);

  const tempOpen = operations.find((item) => item.type === "open" && item.file.endsWith(".tmp"));
  assert.ok(tempOpen, "a same-directory temporary leaf is opened");
  assert.equal(path.dirname(tempOpen.file), paths.directory);
  assert.equal(tempOpen.flags & fs.constants.O_EXCL, fs.constants.O_EXCL);
  assert.equal(tempOpen.flags & (fs.constants.O_NOFOLLOW || 0), fs.constants.O_NOFOLLOW || 0);

  const renames = operations.filter((item) => item.type === "rename");
  assert.equal(renames.length, 2, "both first publication and replacement use atomic rename");
  assert.ok(renames.every((item) => item.to === paths.file));
  const renameIndex = operations.findIndex((item) => item.type === "rename");
  assert.ok(renameIndex > -1);
  assert.ok(operations.slice(0, renameIndex).some((item) => item.type === "fsync" && item.file.endsWith(".tmp")),
    "temporary contents are flushed before publication");
  if (process.platform !== "win32") {
    assert.ok(operations.slice(renameIndex + 1).some((item) => item.type === "fsync" && item.file === paths.directory),
      "the parent rename is flushed before success returns");
  }
});

test("post-rename parent-fsync failure stays named and leaves a conservative state", {
  skip: process.platform === "win32" ? "directory fsync is a Linux durability proof" : false,
}, (t) => {
  const paths = fixture(t);
  const directoryDescriptors = new Set();
  const io = Object.create(fs);
  io.openSync = (file, flags, mode) => {
    const descriptor = fs.openSync(file, flags, mode);
    if (path.resolve(String(file)) === path.resolve(paths.directory)) {
      directoryDescriptors.add(descriptor);
    }
    return descriptor;
  };
  io.closeSync = (descriptor) => {
    directoryDescriptors.delete(descriptor);
    return fs.closeSync(descriptor);
  };
  io.fsyncSync = (descriptor) => {
    if (directoryDescriptors.has(descriptor) && fs.existsSync(paths.file)) {
      const error = new Error("injected parent fsync failure");
      error.code = "EIO";
      throw error;
    }
    return fs.fsyncSync(descriptor);
  };

  const held = reservation();
  assert.throws(
    () => createDeepSeekBudgetState({ directory: paths.directory, fsImpl: io }).reserve(held),
    (error) => error.code === "DEEPSEEK_BUDGET_STATE_UNAVAILABLE"
      && /injected parent fsync failure/i.test(error.message),
  );
  assert.equal(createDeepSeekBudgetState({ directory: paths.directory }).todayUsd(held.day), held.reservedUsd,
    "restart sees the published worst-case reservation even when durability acknowledgement was ambiguous");
});

test("container boot keeps the protected budget directory gate-owned across flag changes", () => {
  const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "container", "Dockerfile"), "utf8");
  assert.match(entrypoint,
    /AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR="\$ARTIFACT_REVIEW_ROOT\/deepseek-budget"/);
  assert.match(entrypoint,
    /\[ ! -L "\$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR" \][\s\S]+?install -d -o gate -g gate -m 0700 "\$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR"/);
  const selectedOwnerLoop = entrypoint.match(/for private_tree in [^\n]+; do/)?.[0] || "";
  assert.doesNotMatch(selectedOwnerLoop, /AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR/);
  const budgetRestoreStart = entrypoint.indexOf('deepseek_budget_tree="$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR"');
  const budgetRestoreEnd = entrypoint.indexOf('chown root:root "$ARTIFACT_REVIEW_ROOT"', budgetRestoreStart);
  assert.ok(budgetRestoreStart >= 0 && budgetRestoreEnd > budgetRestoreStart,
    "the protected budget restore is bounded before the root-anchor repair");
  const budgetRestore = entrypoint.slice(budgetRestoreStart, budgetRestoreEnd);
  assert.match(budgetRestore,
    /find -P "\$deepseek_budget_tree" -xdev -type d -print0 \\\n\s+\| xargs -0 -r chown gate:gate --/);
  assert.match(budgetRestore,
    /find -P "\$deepseek_budget_tree" -xdev -type d -print0 \\\n\s+\| xargs -0 -r chmod 0700 --/);
  assert.match(budgetRestore,
    /find -P "\$deepseek_budget_tree" -xdev -type f -links 1 -print0 \\\n\s+\| xargs -0 -r chown gate:gate --/);
  assert.match(budgetRestore,
    /find -P "\$deepseek_budget_tree" -xdev -type f -links 1 -print0 \\\n\s+\| xargs -0 -r chmod 0600 --/);
  assert.match(entrypoint, /export AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR/);
  assert.match(dockerfile, /COPY deepseek-budget-state\.js \/opt\/agenthost\/deepseek-budget-state\.js/);
});
