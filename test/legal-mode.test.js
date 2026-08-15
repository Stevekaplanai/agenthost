// Legal Mode gate: pure posture logic + the attestation enforcement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legalPosture, enforceLegalMode } from "../src/legal-mode.js";

test("legalPosture: off unless --legal", () => {
  assert.deepEqual(legalPosture({}), { legal: false });
  assert.deepEqual(legalPosture({ "oauth-token": "x" }), { legal: false });
});

test("legalPosture: API key passes without attestation", () => {
  const p = legalPosture({ legal: true, "anthropic-key": "sk-ant-x" });
  assert.equal(p.posture, "api");
  assert.equal(p.needsAttestation, false);
});

test("legalPosture: subscription token needs attestation unless flag set", () => {
  const p = legalPosture({ legal: true, "oauth-token": "tok" });
  assert.equal(p.posture, "subscription");
  assert.equal(p.needsAttestation, true);
  const p2 = legalPosture({ legal: true, "oauth-token": "tok", "training-opt-out-verified": true });
  assert.equal(p2.needsAttestation, false);
});

test("legalPosture: oauth token wins over a stray anthropic-key (posture=subscription)", () => {
  const p = legalPosture({ legal: true, "oauth-token": "tok", "anthropic-key": "sk" });
  assert.equal(p.posture, "subscription");
  assert.equal(p.needsAttestation, true);
});

test("enforceLegalMode: no-op returns {} when --legal absent", async () => {
  assert.deepEqual(await enforceLegalMode({}), {});
});

test("enforceLegalMode: API key path returns LEGAL_MODE=api, no prompt", async () => {
  const secrets = await enforceLegalMode({ legal: true, "anthropic-key": "sk-ant-x" });
  assert.equal(secrets.LEGAL_MODE, "api");
});

test("enforceLegalMode: attested subscription returns LEGAL_MODE=subscription-attested", async () => {
  const secrets = await enforceLegalMode({ legal: true, "oauth-token": "t", "training-opt-out-verified": true });
  assert.equal(secrets.LEGAL_MODE, "subscription-attested");
});

test("enforceLegalMode: unattested subscription throws (non-TTY confirm resolves false)", async () => {
  await assert.rejects(
    () => enforceLegalMode({ legal: true, "oauth-token": "t" }),
    /Legal Mode requires the training opt-out attestation/
  );
});
