// Phase 1f Step 4d seam: OBJECTIVE DELIVERY. The run objective must reach the
// jailed engine. It is threaded work.start → launcher.start → spawn and delivered
// as a fixed, injection-safe argv-element substitution of `{objective}`. Verified
// in pure node (the real bwrap launch is box-side); this retires the seam's
// design uncertainty.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import { createStopStore } from "../container/maintenance-stop-store.js";
import { createClaimsStore } from "../container/maintenance-claims-store.js";
import { createRunsStore } from "../container/maintenance-runs-store.js";
import { createBudgetStore } from "../container/maintenance-budget-store.js";
import { createAuditStore } from "../container/maintenance-audit-store.js";
import workServiceMod from "../container/maintenance-work-service.js";
import runtimeMod from "../container/maintenance-worker-runtime.js";

const { createWorkService } = workServiceMod;
const { substituteObjective } = runtimeMod;

const EPOCH = "gw_" + "a".repeat(32);
const CONN = "conn-1";
const REPO = "repo_" + "a".repeat(16);
const pass = () => {};
const mem = (r = []) => ({ records: r, append: (x) => r.push(JSON.parse(JSON.stringify(x))), readAll: () => r.slice() });
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

test("substituteObjective replaces only the exact {objective} argv element (injection-safe)", () => {
  assert.deepEqual(substituteObjective(["claude", "-p", "{objective}"], "fix the bug"), ["claude", "-p", "fix the bug"]);
  // never a substring: a flag that merely contains the token text is untouched
  assert.deepEqual(substituteObjective(["claude", "--x={objective}"], "hi"), ["claude", "--x={objective}"]);
  // a missing objective yields an empty slot, not a dangling token
  assert.deepEqual(substituteObjective(["claude", "-p", "{objective}"], undefined), ["claude", "-p", ""]);
  // the objective is one element even with shell metacharacters — never split/interpolated
  assert.deepEqual(substituteObjective(["claude", "-p", "{objective}"], "a; rm -rf / #"), ["claude", "-p", "a; rm -rf / #"]);
  assert.throws(() => substituteObjective("not-array", "x"), /argv/);
});

test("work.start threads the objective through the launcher to spawn", () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  stopStore.resume({ expectedVersion: 1 });
  const claimsStore = createClaimsStore({ log: mem(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: mem(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: POLICY, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: mem() });
  runsStore.accept({ id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] });

  let seen = null;
  const svc = createWorkService({
    stopStore, claimsStore, runsStore, budgetStore, auditStore,
    handles: protocol.createHandleRegistry(),
    spawn: (args) => { seen = args; return { childRef: "chld_x" }; }, // capture what the launcher hands the runtime
    worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => 1_000,
  });
  const request = { v: 1, gatewayEpoch: EPOCH, requestId: "req_" + "b".repeat(32), deadlineMs: 10_000, method: "work.start",
    params: { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "refactor the parser", claimHandle: null } };
  svc.start(request, { connectionId: CONN, gatewayEpoch: EPOCH });
  assert.equal(seen.objective, "refactor the parser", "the launcher forwarded the objective to the runtime spawn");
  assert.equal(seen.profileId, "profile_x");
});
