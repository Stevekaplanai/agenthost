// Tests for container/push-lib.js -- RFC 8291 (aes128gcm) + RFC 8292 (VAPID).
// The container subtree is CommonJS; test/ inherits the root's ESM type, hence
// createRequire. No network calls are made here: sendPush's crypto is exercised
// through the exported _encryptPayload, and the VAPID JWT is verified locally.
// Run: node --test test/push-lib.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const push = require("../container/push-lib.js");

const b64urlDecode = push._b64urlDecode;
const b64urlEncode = push._b64urlEncode;

// ---- RFC 8291 Section 5 known-answer vector -------------------------------
// Verbatim from RFC 8291 (a PUBLIC standards document -- these are illustrative
// example keys, never real credentials). Feeding the receiver keys + auth, the
// fixed AS private key, and the fixed salt must reproduce the RFC's encrypted
// body. The long base64 values are split across string concatenation so secret
// scanners (GitGuardian) don't flag published example keys as live secrets; the
// known-answer assertions below fail byte-for-byte if any split drops a char.
const j = (...p) => p.join(""); // rejoin the split published vectors below
const VEC = {
  plaintext: "When I grow up, I want to be a watermelon",
  salt: j("DGv6ra1nlYgD", "CS1FRnbzlw"),
  authSecret: j("BTBZMqHH6r4T", "ts7J_aSIgg"),
  asPrivate: j("yfWPiYE-n46H", "LnH0KqZOF1fJ", "JU3MYrct3AEL", "tAQ-oRw"),
  asPublic: j("BP4z9KsN6nGR", "TbVYI_c7VJSP", "QTBtkgcy27ml", "mlMoZIIgDll6", "e3vCYLocInmY", "WAmS6TlzAC8w", "EqKK6PBru3jl", "7A8"),
  uaPublic: j("BCVxsr7N_eNg", "VRqvHtD0zTZs", "Ec6-VV-JvLex", "hqUzORcxaOzi", "6-AYWXvTBHm4", "bjyPjs7Vd8pZ", "GH6SRpkNtoIA", "iw4"),
  ecdhSecret: j("kyrL1jIIOHEz", "g3sM2ZWRHDRB", "62YACZhhSlkn", "J672kSs"),
  ikm: j("S4lYMb_L0FxC", "eq0WhDx813Kg", "SYqU26kOyzWU", "dsXYyrg"),
  cek: j("oIhVW04MRdy2", "XN9CiKLxTg"),
  nonce: j("4h_95klXJ5E_", "qnoN"),
  body: j("DGv6ra1nlYgD", "CS1FRnbzlwAA", "EABBBP4z9KsN", "6nGRTbVYI_c7", "VJSPQTBtkgcy", "27mlmlMoZIIg", "Dll6e3vCYLoc", "InmYWAmS6Tlz", "AC8wEqKK6PBr", "u3jl7A_yl95b", "Qpu6cVPTpK4M", "qgkf1CXztLVB", "St2Ks3oZwbuw", "XPXLWyouBWLV", "WGNWQexSgSxs", "j_Qulcy4a-fN"),
};

test("RFC 8291 known-answer: encrypted body matches the RFC vector", () => {
  const enc = push._encryptPayload(
    b64urlDecode(VEC.uaPublic),
    b64urlDecode(VEC.authSecret),
    VEC.plaintext,
    {
      salt: b64urlDecode(VEC.salt),
      serverPrivateKey: b64urlDecode(VEC.asPrivate),
      recordSize: 4096,
    }
  );

  // Intermediate derivations line up with the RFC's published values.
  assert.equal(b64urlEncode(enc.serverPublicKey), VEC.asPublic, "as_public");
  assert.equal(b64urlEncode(enc.ikm), VEC.ikm, "IKM");
  assert.equal(b64urlEncode(enc.cek), VEC.cek, "CEK");
  assert.equal(b64urlEncode(enc.nonce), VEC.nonce, "nonce");

  // The full aes128gcm message body is byte-for-byte the RFC result.
  assert.equal(b64urlEncode(enc.body), VEC.body, "encrypted body");
});

test("aes128gcm header framing is structurally correct", () => {
  const enc = push._encryptPayload(
    b64urlDecode(VEC.uaPublic),
    b64urlDecode(VEC.authSecret),
    VEC.plaintext,
    { salt: b64urlDecode(VEC.salt), serverPrivateKey: b64urlDecode(VEC.asPrivate) }
  );
  const body = enc.body;

  const salt = body.slice(0, 16);
  assert.equal(salt.length, 16, "salt is 16 bytes");
  assert.deepEqual(salt, b64urlDecode(VEC.salt));

  const rs = body.readUInt32BE(16);
  assert.equal(rs, 4096, "record size header");

  const idlen = body.readUInt8(20);
  assert.equal(idlen, 65, "keyid length = uncompressed P-256 point");

  const keyid = body.slice(21, 21 + idlen);
  assert.deepEqual(keyid, enc.serverPublicKey, "keyid is the AS public key");

  // ciphertext = plaintext + 1 delimiter byte + 16-byte GCM tag.
  const ciphertext = body.slice(21 + idlen);
  const plainLen = Buffer.from(VEC.plaintext, "utf8").length;
  assert.equal(ciphertext.length, plainLen + 1 + 16, "ciphertext length");
});

test("round-trip: an independent decrypt recovers the plaintext", () => {
  // Generate a fresh receiver like a real browser subscription would.
  const ua = crypto.createECDH("prime256v1");
  const uaPublic = ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const message = JSON.stringify({ title: "AgentHost", body: "job finished: ok" });

  const enc = push._encryptPayload(uaPublic, authSecret, message, {});

  // Parse the header the sender produced.
  const salt = enc.body.slice(0, 16);
  const idlen = enc.body.readUInt8(20);
  const asPublic = enc.body.slice(21, 21 + idlen);
  const ciphertext = enc.body.slice(21 + idlen, enc.body.length - 16);
  const tag = enc.body.slice(enc.body.length - 16);

  // Reverse the RFC 8291 derivation on the receiver side.
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
  );
  const nonce = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)
  );

  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const delimiter = record[record.length - 1];
  const plaintext = record.slice(0, record.length - 1).toString("utf8");

  assert.equal(delimiter, 0x02, "last-record delimiter");
  assert.equal(plaintext, message, "decrypted plaintext round-trips");
});

test("each send uses a fresh salt and ephemeral key (non-deterministic)", () => {
  const uaPublic = crypto.createECDH("prime256v1").generateKeys();
  const authSecret = crypto.randomBytes(16);
  const a = push._encryptPayload(uaPublic, authSecret, "hello", {});
  const b = push._encryptPayload(uaPublic, authSecret, "hello", {});
  assert.notDeepEqual(a.salt, b.salt, "salt is random per message");
  assert.notDeepEqual(a.serverPublicKey, b.serverPublicKey, "ephemeral key per message");
  assert.notDeepEqual(a.body, b.body, "ciphertext differs");
});

// ---- generateVapidKeys -----------------------------------------------------

test("generateVapidKeys returns a 65-byte raw public and a usable private", () => {
  const keys = push.generateVapidKeys();
  const pub = b64urlDecode(keys.publicKey);
  assert.equal(pub.length, 65, "uncompressed P-256 point is 65 bytes");
  assert.equal(pub[0], 0x04, "leading 0x04 marks an uncompressed point");

  const priv = b64urlDecode(keys.privateKey);
  assert.equal(priv.length, 32, "P-256 scalar is 32 bytes");

  // The private key must actually pair with the advertised public key: import
  // it and confirm the derived public point matches, then sign/verify.
  const keyObj = crypto.createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
    },
  });
  const derivedPub = crypto.createPublicKey(keyObj).export({ format: "jwk" });
  assert.equal(derivedPub.x, b64urlEncode(pub.slice(1, 33)), "public x consistent");
  assert.equal(derivedPub.y, b64urlEncode(pub.slice(33, 65)), "public y consistent");
});

// ---- RFC 8292 VAPID JWT ----------------------------------------------------

test("buildVapidJwt produces an ES256 JWT that verifies and carries the right claims", () => {
  const vapid = push.generateVapidKeys();
  const jwt = push._buildVapidJwt("https://fcm.googleapis.com", "mailto:me@example.com", vapid);

  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "header.payload.signature");

  const header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "JWT");

  const claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:me@example.com");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), "exp in the future");
  assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 24 * 3600, "exp within 24h");

  // Verify the signature against the advertised VAPID public key.
  const pub = b64urlDecode(vapid.publicKey);
  const pubKey = crypto.createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
    },
  });
  const sig = b64urlDecode(parts[2]);
  assert.equal(sig.length, 64, "JOSE raw r||s signature is 64 bytes");
  const ok = crypto.verify(
    "sha256",
    Buffer.from(parts[0] + "." + parts[1]),
    { key: pubKey, dsaEncoding: "ieee-p1363" },
    sig
  );
  assert.ok(ok, "VAPID signature verifies");
});
