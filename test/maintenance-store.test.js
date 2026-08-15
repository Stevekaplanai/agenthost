import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  MaintenanceStoreError,
  MIGRATION_STATES,
  createMaintenanceStore,
} = require("../container/maintenance-store.js");

const GW = "gw_0123456789abcdef0123456789abcdef";
const REQ = "req_0123456789abcdef0123456789abcdef";
const DIGEST = "sha256:" + "a".repeat(64);

class MemoryAdapter {
  constructor(options = {}) {
    this.journal = options.journal ?? null;
    this.trustedError = options.trustedError ?? null;
    this.readError = options.readError ?? null;
    this.appendError = options.appendError ?? null;
    this.quarantined = [];
    this.assertions = 0;
    this.appended = [];
    this.legacy = options.legacy ?? "agent-owned legacy state";
  }

  assertTrusted() {
    this.assertions += 1;
    if (this.trustedError) throw this.trustedError;
  }

  readJournal() {
    if (this.readError) throw this.readError;
    return this.journal;
  }

  appendJournal(line) {
    if (this.appendError) throw this.appendError;
    this.appended.push(line);
    this.journal = this.journal ? `${this.journal}\n${line}` : line;
  }

  quarantine(record) {
    this.quarantined.push(record);
  }
}

function fixture(options = {}) {
  let nowMs = 1_784_690_000_000;
  const adapter = options.adapter || new MemoryAdapter();
  const store = createMaintenanceStore({
    adapter,
    now: () => nowMs,
    redact: options.redact || ((value) => String(value)),
  });
  return {
    adapter,
    store,
    setNow(value) { nowMs = value; },
  };
}

function errorCode(code) {
  return (error) => error instanceof MaintenanceStoreError && error.code === code;
}

test("fresh dormant store persists the stopped foundation record and reopens it", () => {
  const f = fixture();
  const first = f.store.open();

  assert.equal(first.state, "ready");
  assert.equal(first.migrationState, "not_started");
  assert.equal(first.stop.engaged, true);
  assert.equal(f.adapter.appended.length, 1, "the default STOPPED record exists before open returns");
  assert.match(f.adapter.journal, /foundation/);

  const reopened = fixture({ adapter: f.adapter }).store.open();
  assert.deepEqual(reopened, first);
  assert.equal(f.adapter.appended.length, 1, "reopen never rewrites the foundation record");
  assert.equal(f.adapter.legacy, "agent-owned legacy state", "legacy agent-owned state is not imported");
});

test("migration journal is monotonic, idempotent at the current step, and restart-safe", () => {
  const f = fixture();
  f.store.open();
  assert.deepEqual(MIGRATION_STATES, [
    "not_started", "secure_dirs", "agent_markers_moved", "stores_created",
    "legacy_labeled", "stopped_defaulted", "cutover_ready", "complete",
  ]);

  assert.throws(() => f.store.advanceMigration("stores_created"), errorCode("INVALID_TRANSITION"));
  for (const state of MIGRATION_STATES.slice(1)) {
    assert.equal(f.store.advanceMigration(state).migrationState, state);
    assert.equal(f.store.advanceMigration(state).migrationState, state, "same step is a retry, not a second advance");
  }
  assert.throws(() => f.store.advanceMigration("cutover_ready"), errorCode("INVALID_TRANSITION"));

  const reopened = fixture({ adapter: f.adapter }).store.open();
  assert.equal(reopened.migrationState, "complete");
});

test("unsafe trusted storage fails closed before read or write", () => {
  for (const reason of ["symlink", "wrong_owner", "wrong_mode", "wrong_type"]) {
    const adapter = new MemoryAdapter({ trustedError: new Error(reason) });
    const store = fixture({ adapter }).store;
    assert.throws(() => store.open(), errorCode("STORE_UNAVAILABLE"), reason);
    assert.equal(adapter.appended.length, 0, `${reason}: no foundation record was created`);
    assert.equal(store.health().state, "unavailable", `${reason}: health does not invent availability`);
  }

  const unreadable = new MemoryAdapter({ readError: new Error("read failed") });
  const store = fixture({ adapter: unreadable }).store;
  assert.throws(() => store.open(), errorCode("STORE_UNAVAILABLE"));
  assert.equal(unreadable.appended.length, 0, "a read failure cannot create a replacement journal");
});

test("persistence failures never report success or an empty foundation", () => {
  const adapter = new MemoryAdapter({ appendError: new Error("disk full") });
  const store = fixture({ adapter }).store;
  assert.throws(() => store.open(), errorCode("STORE_UNAVAILABLE"));
  assert.equal(store.health().state, "unavailable");
  assert.equal(store.snapshot(), null, "a failed write never becomes an empty/clear state");

  const migration = fixture();
  migration.store.open();
  migration.adapter.appendError = new Error("fsync failed");
  assert.throws(() => migration.store.advanceMigration("secure_dirs"), errorCode("STORE_UNAVAILABLE"));
  assert.equal(migration.store.health().state, "unavailable", "a failed migration append does not advance in memory");

  const idempotency = fixture();
  idempotency.store.open();
  idempotency.adapter.appendError = new Error("fsync failed");
  assert.throws(() => idempotency.store.commitIdempotency({
    gatewayEpoch: GW,
    requestId: REQ,
    digest: DIGEST,
    response: { summary: "Must not report committed" },
  }), errorCode("STORE_UNAVAILABLE"));
  assert.equal(idempotency.store.health().state, "unavailable", "a failed idempotency append has no success path");
});

test("asynchronous adapters fail closed instead of reporting durable success", async () => {
  const initial = new MemoryAdapter();
  initial.assertTrusted = () => Promise.resolve();
  const store = fixture({ adapter: initial }).store;
  assert.throws(() => store.open(), errorCode("STORE_UNAVAILABLE"));
  assert.equal(initial.appended.length, 0, "a Promise-returning trust check cannot create a foundation record");

  const mutation = fixture();
  mutation.store.open();
  mutation.adapter.appendJournal = () => Promise.reject(new Error("later write failure"));
  assert.throws(() => mutation.store.advanceMigration("secure_dirs"), errorCode("STORE_UNAVAILABLE"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutation.store.health().state, "unavailable", "an asynchronous write cannot report a completed transition");
});

test("durable idempotency replays after reopen and changed bodies conflict without mutation", () => {
  const f = fixture();
  f.store.open();
  const response = { status: "success", summary: "Committed response", data: { ok: true } };
  const committed = f.store.commitIdempotency({ gatewayEpoch: GW, requestId: REQ, digest: DIGEST, response });
  assert.equal(committed.action, "committed");

  const reopened = fixture({ adapter: f.adapter }).store;
  reopened.open();
  assert.deepEqual(reopened.lookupIdempotency({ gatewayEpoch: GW, requestId: REQ, digest: DIGEST }), {
    action: "replay",
    response,
  });
  const before = f.adapter.journal;
  assert.deepEqual(reopened.lookupIdempotency({
    gatewayEpoch: GW,
    requestId: REQ,
    digest: "sha256:" + "b".repeat(64),
  }), { action: "conflict" });
  assert.equal(f.adapter.journal, before, "a conflict cannot write or alter the committed record");
});

test("torn or invalid journal records quarantine without erasing valid prior history", () => {
  for (const tail of [
    "{\"v\":1,\"type\":\"unknown\",\"secret\":\"SHORT_SECRET\"}",
    "{\"v\":1,\"type\":",
  ]) {
    const f = fixture();
    f.store.open();
    const valid = f.adapter.journal;
    f.adapter.journal += `\n${tail}`;

    const reopened = fixture({
      adapter: f.adapter,
      redact: (value) => String(value).replaceAll("SHORT_SECRET", "[REDACTED]"),
    }).store;
    assert.throws(() => reopened.open(), errorCode("STORE_UNAVAILABLE"));
    assert.ok(f.adapter.journal.startsWith(valid), "the valid durable prefix is not reset or overwritten");
    assert.equal(f.adapter.quarantined.length, 1);
    assert.equal(f.adapter.quarantined[0].reasonCode, "corrupt");
    assert.doesNotMatch(JSON.stringify(f.adapter.quarantined[0]), /SHORT_SECRET/);
    assert.match(f.adapter.quarantined[0].recordDigest, /^sha256:[0-9a-f]{64}$/);
  }

  const empty = new MemoryAdapter({ journal: "" });
  const emptyStore = fixture({ adapter: empty }).store;
  assert.throws(() => emptyStore.open(), errorCode("STORE_UNAVAILABLE"));
  assert.equal(empty.appended.length, 0, "an existing zero-byte journal is never silently reset");
  assert.equal(empty.quarantined.length, 1, "an existing zero-byte journal is quarantined");
});

test("hostile journal values cannot escape the unavailable error contract", () => {
  const adapter = new MemoryAdapter({
    journal: { toString() { throw new Error("untrusted journal conversion"); } },
  });
  const store = fixture({ adapter }).store;
  assert.throws(() => store.open(), errorCode("STORE_UNAVAILABLE"));
  assert.equal(store.health().state, "unavailable");
});

test("redaction runs before idempotency or quarantine persistence", () => {
  const secret = "tiny7!";
  const encoded = [
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    Buffer.from(secret).toString("hex"),
  ];
  const redact = (value) => [secret, ...encoded].reduce(
    (safe, form, index) => safe.replaceAll(form, `[REDACTED_${index}]`),
    String(value),
  );
  const f = fixture({ redact });
  f.store.open();
  f.store.commitIdempotency({
    gatewayEpoch: GW,
    requestId: REQ,
    digest: DIGEST,
    response: {
      summary: `${secret} ${encoded.join(" ")}`,
      data: { token: secret },
      [secret]: "raw key",
      [encoded[0]]: "base64 key",
      [encoded[1]]: "base64url key",
      [encoded[2]]: "hex key",
    },
  });
  for (const form of [secret, ...encoded]) assert.doesNotMatch(f.adapter.journal, new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(f.adapter.journal, /\[REDACTED_/);
});

test("public maintenance-store inputs reject malformed IDs and non-JSON responses", () => {
  const f = fixture();
  f.store.open();
  const before = f.adapter.journal;
  assert.throws(() => f.store.lookupIdempotency({ gatewayEpoch: "wrong", requestId: REQ, digest: DIGEST }), errorCode("INVALID_REQUEST"));
  assert.throws(() => f.store.commitIdempotency({
    gatewayEpoch: GW,
    requestId: REQ,
    digest: DIGEST,
    response: { unsafe: () => "no" },
  }), errorCode("INVALID_REQUEST"));
  assert.equal(f.adapter.journal, before, "invalid inputs cannot append a journal record");

  const collision = fixture({ redact: () => "[REDACTED]" });
  collision.store.open();
  const collisionBefore = collision.adapter.journal;
  assert.throws(() => collision.store.commitIdempotency({
    gatewayEpoch: GW,
    requestId: REQ,
    digest: DIGEST,
    response: { first: "one", second: "two" },
  }), errorCode("INVALID_REQUEST"));
  assert.equal(collision.adapter.journal, collisionBefore, "redaction cannot collapse distinct response keys");
});

test("dormant foundation modules are image-resident but no live runtime imports or launches them", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "container");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "entrypoint.sh"), "utf8");
  const start = fs.readFileSync(path.join(root, "start.sh"), "utf8");
  const gate = fs.readFileSync(path.join(root, "gate.js"), "utf8");
  const storeSource = fs.readFileSync(path.join(root, "maintenance-store.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(root, "maintenance-service.js"), "utf8");

  assert.match(dockerfile, /^COPY --chown=root:root maintenance-protocol\.js \/opt\/agenthost\/maintenance-protocol\.js$/m);
  assert.match(dockerfile, /^COPY --chown=root:root maintenance-store\.js \/opt\/agenthost\/maintenance-store\.js$/m);
  assert.match(dockerfile, /^COPY --chown=root:root maintenance-service\.js \/opt\/agenthost\/maintenance-service\.js$/m);
  for (const source of [entrypoint, start, gate]) {
    assert.doesNotMatch(source, /maintenance-(?:service|store)\.js|maint\.sock/);
  }
  for (const source of [storeSource, serviceSource]) {
    assert.doesNotMatch(source, /node:fs|node:net|\/data|maint\.sock/);
  }
});
