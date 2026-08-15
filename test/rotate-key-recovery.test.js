import { test } from "node:test";
import assert from "node:assert/strict";
import { accessKeyFingerprint, rotateKeyCommand } from "../src/commands/rotate-key.js";

const APP = "fixture-app";
const ORIGIN = "https://app.agenthost.space";
const OLD_KEY = "missing-state-old-key-fixture";
const NEW_KEY = "missing-state-new-key-fixture";
const OLD_FINGERPRINT = accessKeyFingerprint(OLD_KEY);
const NEW_FINGERPRINT = accessKeyFingerprint(NEW_KEY);

function marker({
  keyFingerprint = OLD_FINGERPRINT,
  rotationRequired = true,
  retiredKeyFingerprints = [OLD_FINGERPRINT],
  ...overrides
} = {}) {
  return {
    version: 2,
    mode: "foundation",
    keyFingerprint,
    rotationRequired,
    ownerUid: 1001,
    ownerGid: 1001,
    retiredKeyFingerprints,
    ...overrides,
  };
}

function snapshot({
  marker: markerValue = marker(),
  pending = false,
  recoveryRequired = false,
  rotationRequired = markerValue.rotationRequired,
  ...overrides
} = {}) {
  return {
    appName: APP,
    canonicalHost: "app.agenthost.space",
    dataIdentity: { dev: "2049", ino: "2" },
    marker: markerValue,
    pending,
    recoveryRequired,
    rotationRequired,
    ...overrides,
  };
}

function flags(overrides = {}) {
  return {
    app: APP,
    "recover-missing-state": true,
    "access-key": NEW_KEY,
    ...overrides,
  };
}

function recoveryDependencies({ snapshots, ...overrides } = {}) {
  const calls = [];
  const activated = snapshot({
      marker: marker({
        keyFingerprint: NEW_FINGERPRINT,
        rotationRequired: false,
        retiredKeyFingerprints: [OLD_FINGERPRINT],
      }),
      recoveryRequired: true,
      rotationRequired: false,
    });
  const remote = [...(snapshots || [
    snapshot(),
    snapshot(),
    activated,
    snapshot({ ...activated, recoveryRequired: false }),
  ])];
  let saved = null;
  const dependencies = {
    loadState: () => { calls.push("load"); return null; },
    listMachines: (app) => {
      calls.push("machines");
      assert.equal(app, APP);
      return [{ id: "machine-one", state: "started" }];
    },
    readRemoteAuthState: (app, machineId) => {
      calls.push("read");
      assert.equal(app, APP);
      assert.equal(machineId, "machine-one");
      return structuredClone(remote.length > 1 ? remote.shift() : remote[0]);
    },
    stageSecrets: async (app, secrets) => {
      calls.push("stage");
      assert.equal(app, APP);
      assert.deepEqual(secrets, { TTYD_PASSWORD: NEW_KEY });
    },
    deployStagedSecrets: (app) => {
      calls.push("deploy");
      assert.equal(app, APP);
      return { code: 0, stdout: "release complete", stderr: "" };
    },
    acknowledgeRecovery: async (origin, accessKey) => {
      calls.push("ack");
      assert.equal(origin, ORIGIN);
      assert.equal(accessKey, NEW_KEY);
      return { statusCode: 204, cookie: "agenthost_auth=opaque-fixture" };
    },
    saveState: (app, update) => {
      calls.push("save");
      assert.equal(app, APP);
      saved = structuredClone(update);
    },
    sleep: async () => { calls.push("sleep"); },
    log: () => {},
    ...overrides,
  };
  return { calls, dependencies, get saved() { return saved; } };
}

function count(calls, name) {
  return calls.filter((call) => call === name).length;
}

test("explicit missing-state recovery proves the one machine before one deploy, acknowledges HTTPS recovery, then saves", async () => {
  const fixture = recoveryDependencies();

  const result = await rotateKeyCommand(flags(), fixture.dependencies);

  assert.deepEqual(result, { app: APP });
  assert.equal(count(fixture.calls, "machines"), 1);
  assert.equal(count(fixture.calls, "stage"), 1);
  assert.equal(count(fixture.calls, "deploy"), 1);
  assert.equal(count(fixture.calls, "ack"), 1);
  assert.equal(count(fixture.calls, "save"), 1);
  assert.ok(fixture.calls.indexOf("read") < fixture.calls.indexOf("stage"));
  assert.ok(fixture.calls.lastIndexOf("read") > fixture.calls.indexOf("deploy"));
  assert.ok(fixture.calls.indexOf("ack") > fixture.calls.indexOf("deploy"));
  assert.ok(fixture.calls.lastIndexOf("read") > fixture.calls.indexOf("ack"));
  assert.ok(fixture.calls.indexOf("save") > fixture.calls.lastIndexOf("read"));
  assert.deepEqual(fixture.saved, {
    origin: ORIGIN,
    ttydPassword: NEW_KEY,
    retiredAccessKeyFingerprints: [OLD_FINGERPRINT],
  });
});

test("missing-state recovery is opt-in, rejects every caller-controlled origin, and never treats a corrupt local record as absent", async () => {
  for (const [candidateFlags, loadState, pattern] of [
    [flags({ "recover-missing-state": undefined }), () => null, /trusted saved access key|recover-missing-state/i],
    [flags({ origin: "https://attacker.example" }), () => null, /origin.*not accepted|protected box identity/i],
    [flags({ origin: "https://localhost" }), () => null, /origin.*not accepted|protected box identity/i],
    [flags({ origin: "https://app.agenthost.space:4443" }), () => null, /origin.*not accepted|protected box identity/i],
    [flags(), () => ({ app: APP, origin: ORIGIN }), /trusted saved access key|corrupt|incomplete/i],
  ]) {
    const calls = [];
    await assert.rejects(
      () => rotateKeyCommand(candidateFlags, {
        loadState,
        listMachines: () => { calls.push("machines"); return [{ id: "machine-one", state: "started" }]; },
        stageSecrets: async () => { calls.push("stage"); },
        deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
        saveState: () => { calls.push("save"); },
      }),
      pattern,
    );
    assert.deepEqual(calls, []);
  }
});

test("recovery requires exactly one started machine and performs no mutation when fleet authority is ambiguous", async () => {
  for (const machines of [
    [],
    [{ id: "machine-one", state: "stopped" }],
    [{ id: "machine-one", state: "started" }, { id: "machine-two", state: "started" }],
  ]) {
    const fixture = recoveryDependencies({
      listMachines: () => { fixture.calls.push("machines"); return machines; },
    });
    await assert.rejects(
      () => rotateKeyCommand(flags(), fixture.dependencies),
      /exactly one started machine|sole started machine/i,
    );
    assert.equal(count(fixture.calls, "stage"), 0);
    assert.equal(count(fixture.calls, "deploy"), 0);
    assert.equal(count(fixture.calls, "save"), 0);
  }
});

test("strict preflight refuses pending, malformed, current, and retired candidates before staging", async () => {
  const cases = [
    [snapshot({ pending: true }), /pending/i],
    [snapshot({ extra: "not-allowed" }), /schema|unexpected/i],
    [snapshot({ marker: marker({ unsupported: true }) }), /schema|unexpected/i],
    [snapshot({ appName: "attacker-app" }), /app identity.*requested app|requested app/i],
    [snapshot({ canonicalHost: "localhost:4443" }), /canonical hostname/i],
    [snapshot({ marker: marker({ keyFingerprint: NEW_FINGERPRINT, retiredKeyFingerprints: [OLD_FINGERPRINT] }) }), /matches.*current|same.*candidate|already current/i],
    [snapshot({ marker: marker({ retiredKeyFingerprints: [OLD_FINGERPRINT, NEW_FINGERPRINT] }) }), /retired|previously used/i],
    [snapshot({ rotationRequired: false }), /rotation.*required/i],
  ];

  for (const [before, pattern] of cases) {
    const fixture = recoveryDependencies({ snapshots: [before] });
    await assert.rejects(() => rotateKeyCommand(flags(), fixture.dependencies), pattern);
    assert.equal(count(fixture.calls, "read"), 1);
    assert.equal(count(fixture.calls, "stage"), 0);
    assert.equal(count(fixture.calls, "deploy"), 0);
    assert.equal(count(fixture.calls, "save"), 0);
  }
});

test("fresh recovery verifies the exact post-release marker and never saves a mismatch", async () => {
  const acceptedMarker = marker({
    keyFingerprint: NEW_FINGERPRINT,
    rotationRequired: false,
    retiredKeyFingerprints: [OLD_FINGERPRINT],
  });
  const mismatches = [
    snapshot({ marker: marker({ keyFingerprint: accessKeyFingerprint("different-new-key-fixture"), rotationRequired: false }), recoveryRequired: true, rotationRequired: false }),
    snapshot({ marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: false, retiredKeyFingerprints: [] }), recoveryRequired: true, rotationRequired: false }),
    snapshot({ marker: acceptedMarker, recoveryRequired: true, rotationRequired: false, dataIdentity: { dev: "2049", ino: "999" } }),
    snapshot({ marker: acceptedMarker, pending: true, recoveryRequired: true, rotationRequired: false }),
    snapshot({ marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: true }), recoveryRequired: false, rotationRequired: true }),
    snapshot({ marker: acceptedMarker, recoveryRequired: false, rotationRequired: false }),
    snapshot({ marker: acceptedMarker, recoveryRequired: true, rotationRequired: false, unexpected: true }),
  ];

  for (const after of mismatches) {
    const fixture = recoveryDependencies({ snapshots: [snapshot(), snapshot(), after] });
    await assert.rejects(() => rotateKeyCommand(flags(), fixture.dependencies));
    assert.equal(count(fixture.calls, "stage"), 1);
    assert.equal(count(fixture.calls, "deploy"), 1);
    assert.equal(count(fixture.calls, "ack"), 0);
    assert.equal(count(fixture.calls, "save"), 0);
  }
});

test("same-candidate retry with recovery pending skips deploy, acknowledges once, and saves", async () => {
  const current = snapshot({
    marker: marker({
      keyFingerprint: NEW_FINGERPRINT,
      rotationRequired: false,
      retiredKeyFingerprints: [OLD_FINGERPRINT],
    }),
    recoveryRequired: true,
    rotationRequired: false,
  });
  const fixture = recoveryDependencies({
    snapshots: [current, snapshot({ ...current, recoveryRequired: false })],
  });

  await rotateKeyCommand(flags(), fixture.dependencies);

  assert.equal(count(fixture.calls, "stage"), 0);
  assert.equal(count(fixture.calls, "deploy"), 0);
  assert.equal(count(fixture.calls, "ack"), 1);
  assert.equal(count(fixture.calls, "save"), 1);
  assert.deepEqual(fixture.saved, {
    origin: ORIGIN,
    ttydPassword: NEW_KEY,
    retiredAccessKeyFingerprints: [OLD_FINGERPRINT],
  });
});

test("retry after acknowledgement succeeded but local save failed saves only and never redeploys or acknowledges twice", async () => {
  const beforeAck = snapshot({
    marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: false, retiredKeyFingerprints: [OLD_FINGERPRINT] }),
    recoveryRequired: true,
    rotationRequired: false,
  });
  const first = recoveryDependencies({
    snapshots: [beforeAck, snapshot({ ...beforeAck, recoveryRequired: false })],
    saveState: () => { first.calls.push("save"); throw new Error("injected local save failure"); },
  });
  await assert.rejects(() => rotateKeyCommand(flags(), first.dependencies), /local.*save|saved state|injected local save failure/i);
  assert.equal(count(first.calls, "stage"), 0);
  assert.equal(count(first.calls, "deploy"), 0);
  assert.equal(count(first.calls, "ack"), 1);
  assert.equal(count(first.calls, "save"), 1);

  const afterAck = snapshot({
    marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: false, retiredKeyFingerprints: [OLD_FINGERPRINT] }),
    recoveryRequired: false,
    rotationRequired: false,
  });
  const retry = recoveryDependencies({ snapshots: [afterAck] });
  await rotateKeyCommand(flags(), retry.dependencies);
  assert.equal(count(retry.calls, "stage"), 0);
  assert.equal(count(retry.calls, "deploy"), 0);
  assert.equal(count(retry.calls, "ack"), 0);
  assert.equal(count(retry.calls, "save"), 1);
});

test("recovery acknowledgement must return HTTPS session proof before local state is saved", async () => {
  const current = snapshot({
    marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: false, retiredKeyFingerprints: [OLD_FINGERPRINT] }),
    recoveryRequired: true,
    rotationRequired: false,
  });
  for (const response of [
    { statusCode: 200, cookie: "agenthost_auth=opaque-fixture" },
    { statusCode: 204, cookie: "" },
  ]) {
    const fixture = recoveryDependencies({
      snapshots: [current],
      acknowledgeRecovery: async (origin, key) => {
        fixture.calls.push("ack");
        assert.equal(origin, ORIGIN);
        assert.equal(key, NEW_KEY);
        return response;
      },
    });
    await assert.rejects(() => rotateKeyCommand(flags(), fixture.dependencies), /recovery.*acknowledg|session.*proof|HTTP 20/i);
    assert.equal(count(fixture.calls, "save"), 0);
  }
});

test("missing-state recovery redacts the candidate from failures and output", async () => {
  const output = [];
  const current = snapshot({
    marker: marker({ keyFingerprint: NEW_FINGERPRINT, rotationRequired: false, retiredKeyFingerprints: [OLD_FINGERPRINT] }),
    recoveryRequired: true,
    rotationRequired: false,
  });
  const fixture = recoveryDependencies({
    snapshots: [current],
    acknowledgeRecovery: async () => {
      fixture.calls.push("ack");
      throw new Error(`remote refused ${NEW_KEY}`);
    },
    log: (line) => output.push(String(line)),
  });

  let message = "";
  try {
    await rotateKeyCommand(flags(), fixture.dependencies);
  } catch (error) {
    message = String(error.message || error);
  }
  assert.ok(message, "the injected acknowledgement failure must be reported");
  assert.equal(count(fixture.calls, "ack"), 1);
  assert.doesNotMatch(message, new RegExp(NEW_KEY));
  assert.doesNotMatch(output.join("\n"), new RegExp(NEW_KEY));
  assert.equal(count(fixture.calls, "save"), 0);
});
