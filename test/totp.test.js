// TOTP tests: RFC 6238 Appendix B known-answer vectors (SHA-1 rows) plus the
// verify() window/format behavior the gate's 2FA depends on. The RFC vectors
// are 8-digit with the published ASCII test secret "12345678901234567890" --
// public standards data, not credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const totp = require("../container/totp.js");

// RFC 6238 test secret is the raw ASCII bytes of "12345678901234567890";
// our API takes base32, so encode it the way the RFC's key is defined.
const RFC_SECRET_B32 = totp.base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("RFC 6238 Appendix B SHA-1 vectors (8-digit)", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(
      totp.totp(RFC_SECRET_B32, { now: t, digits: 8 }),
      expected,
      `T=${t}`
    );
  }
});

test("base32 round-trips arbitrary bytes", () => {
  for (const len of [1, 5, 10, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf, `len=${len}`);
  }
  // Case/space/padding tolerance (users paste secrets in all shapes).
  assert.deepEqual(
    totp.base32Decode("mfrg g33d ===="),
    totp.base32Decode("MFRGG33D"),
    "lowercase + spaces + padding accepted"
  );
});

test("generateSecret produces a 20-byte base32 secret", () => {
  const s = totp.generateSecret();
  assert.equal(totp.base32Decode(s).length, 20);
  assert.match(s, /^[A-Z2-7]+$/);
  assert.notEqual(totp.generateSecret(), s, "secrets are random");
});

test("verify accepts the current code and the +/-1 window, rejects outside", () => {
  const secret = totp.generateSecret();
  const now = 1700000000; // fixed instant, mid-step
  const code = totp.totp(secret, { now });
  assert.equal(totp.verify(code, secret, { now }), true, "current step");
  assert.equal(totp.verify(code, secret, { now: now + 30 }), true, "+1 step (drift)");
  assert.equal(totp.verify(code, secret, { now: now - 30 }), true, "-1 step (drift)");
  assert.equal(totp.verify(code, secret, { now: now + 90 }), false, "+3 steps rejected");
  assert.equal(totp.verify(code, secret, { now: now - 90 }), false, "-3 steps rejected");
});

test("verify rejects malformed input without throwing", () => {
  const secret = totp.generateSecret();
  for (const bad of ["", null, undefined, "12345", "1234567", "12345a", "000 000", "-00000", {}]) {
    assert.equal(totp.verify(bad, secret), false, JSON.stringify(bad));
  }
});

test("otpauthUrl encodes label/issuer and carries the secret", () => {
  const url = totp.otpauthUrl("MFRGG33D", "steve box", "AgentHost");
  assert.ok(url.startsWith("otpauth://totp/AgentHost:steve%20box?"));
  assert.ok(url.includes("secret=MFRGG33D"));
  assert.ok(url.includes("issuer=AgentHost"));
  assert.ok(url.includes("digits=6") && url.includes("period=30"));
});
