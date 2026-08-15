// TOTP (RFC 6238) over HOTP (RFC 4226), implemented with Node's built-in
// crypto only -- ships inside the container next to gate.js, which must never
// pull npm packages at runtime (zero-dependency invariant).
//
// The gate uses this for opt-in 2FA: a secret enrolled at /2fa is stored on
// the volume, and the cookie login then requires a 6-digit code. SHA-1 is what
// every authenticator app (Google Authenticator, Authy, 1Password...) speaks
// for otpauth:// URIs; it is used here as an HMAC PRF per the RFCs, not as a
// collision-resistant hash, which remains sound.

"use strict";

const crypto = require("crypto");

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// RFC 4648 base32, no padding: authenticator apps expect secrets in this form.
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// HOTP (RFC 4226 5.3): HMAC-SHA1 over the 8-byte big-endian counter, dynamic
// truncation, then the low `digits` decimal digits (zero-padded).
function hotp(keyBuf, counter, digits) {
  const msg = Buffer.alloc(8);
  // 53-bit-safe split; TOTP counters stay far below 2^53.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac("sha1", keyBuf).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

// TOTP (RFC 6238): HOTP with counter = floor(unixSeconds / step).
function totp(secretBase32, opts) {
  opts = opts || {};
  const key = base32Decode(secretBase32);
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const now = opts.now === undefined ? Math.floor(Date.now() / 1000) : opts.now;
  return hotp(key, Math.floor(now / step), digits);
}

// Verify with a +/-1 step window (RFC 6238 5.2 recommends allowing one step of
// clock drift). Constant-time comparison so timing can't leak digit prefixes.
function verify(code, secretBase32, opts) {
  opts = opts || {};
  const input = String(code || "").trim();
  const digits = opts.digits || 6;
  if (!new RegExp(`^[0-9]{${digits}}$`).test(input)) return false;
  const step = opts.step || 30;
  const now = opts.now === undefined ? Math.floor(Date.now() / 1000) : opts.now;
  const window = opts.window === undefined ? 1 : opts.window;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(now / step);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const expected = hotp(key, counter + i, digits);
    // bitwise-OR accumulate; never early-exit on match (constant work).
    ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input)) || ok;
  }
  return ok;
}

// 20 random bytes (RFC 4226 recommends >=128 bits, suggests 160) as base32.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// otpauth:// URI that authenticator apps import (via QR or manual entry).
function otpauthUrl(secretBase32, label, issuer) {
  const lab = encodeURIComponent(label || "agenthost");
  const iss = encodeURIComponent(issuer || "AgentHost");
  return `otpauth://totp/${iss}:${lab}?secret=${secretBase32}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { totp, verify, generateSecret, otpauthUrl, base32Encode, base32Decode, _hotp: hotp };
