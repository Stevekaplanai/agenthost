const test = require('node:test');
const assert = require('node:assert/strict');

const addonPath = process.env.AGENTHOST_MAINTENANCE_NATIVE || '/build/maintenance-native.node';
const native = require(addonPath);

test('native boundary exposes only the fixed authority surface', () => {
  const names = [
    'acceptVerifiedGate',
    'appendFoundationJournalLine',
    'appendQuarantineJournalLine',
    'createAuthorityListener',
    'openTrustedStores',
    'readFoundationJournal',
    'recordDirectGateChild',
    'revokeActiveGate',
    'setSelfNonDumpable',
  ];
  assert.deepEqual(names.filter(name => typeof native[name] === 'function'), names);
});

// The authority guard is ROOT (uid 0), not PID 1 — on a container platform the
// platform's own init is PID 1 and our authority runs as a root CHILD, so a
// getpid()==1 guard could never pass on the box. This test adapts to whoever runs
// it: non-root (normal CI/dev) must be refused with NATIVE_NOT_AUTHORITY; root
// (the docker-build stage that runs `node --test maintenance-native.test.js`, and
// the box) passes the guard and any failure is for a DOWNSTREAM reason (no
// /data/maintenance, no `gate` group, no listener) — never NATIVE_NOT_AUTHORITY.
test('native authority is gated on root (not PID 1)', () => {
  const calls = [
    () => native.openTrustedStores(),
    () => native.readFoundationJournal(),
    () => native.appendFoundationJournalLine(Buffer.from('{}')),
    () => native.appendQuarantineJournalLine(Buffer.from('{}')),
    () => native.createAuthorityListener(),
    () => native.recordDirectGateChild(1),
    () => native.acceptVerifiedGate(),
    () => native.revokeActiveGate(),
  ];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  for (const call of calls) {
    if (isRoot) {
      // Passes the root guard; if it throws it's a downstream error, not the guard.
      try { call(); } catch (error) { assert.notEqual(error && error.code, 'NATIVE_NOT_AUTHORITY'); }
    } else {
      assert.throws(call, error => error && error.code === 'NATIVE_NOT_AUTHORITY');
    }
  }
});

test('a process can make itself non-dumpable without root authority', () => {
  assert.equal(native.setSelfNonDumpable(), true);
});
