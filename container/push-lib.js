// Web Push (RFC 8291 aes128gcm content encryption + RFC 8292 VAPID ES256),
// implemented with Node's built-in crypto only. Zero dependencies -- this ships
// inside the container next to gate.js, which runs as the unprivileged "agent"
// user and may never pull npm packages at runtime.
//
// Two public entry points:
//   generateVapidKeys()                      -> { publicKey, privateKey }  (base64url)
//   sendPush(subscription, payload, vapid, opts) -> Promise<{ status }>
//
// The encryption follows RFC 8291 exactly: an ephemeral P-256 ECDH with the
// subscriber's p256dh key, HKDF-SHA256 keyed by the subscription auth secret,
// then AES-128-GCM with the RFC 8188 aes128gcm framing. VAPID auth is an ES256
// JWT per RFC 8292, sent as "Authorization: vapid t=<jwt>, k=<pub>" with a
// "Crypto-Key: p256ecdsa=<pub>" fallback for older push services.

"use strict";

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

// ---- base64url helpers -----------------------------------------------------

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s, "base64");
}

// ---- VAPID key generation --------------------------------------------------

// Raw uncompressed public point (0x04 || X || Y, 65 bytes) from an EC KeyObject.
function rawPublicFromKey(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  const x = leftPad(b64urlDecode(jwk.x), 32);
  const y = leftPad(b64urlDecode(jwk.y), 32);
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function leftPad(buf, len) {
  if (buf.length === len) return buf;
  if (buf.length > len) return buf.slice(buf.length - len);
  return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
}

function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pubRaw = rawPublicFromKey(publicKey); // 65 bytes
  const privJwk = privateKey.export({ format: "jwk" });
  const privRaw = leftPad(b64urlDecode(privJwk.d), 32); // 32 bytes
  return {
    publicKey: b64urlEncode(pubRaw),
    privateKey: b64urlEncode(privRaw),
  };
}

// ---- RFC 8291 content encryption -------------------------------------------

function hkdf(salt, ikm, info, length) {
  // crypto.hkdfSync does Extract(salt, ikm) then Expand(info, length).
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

// Encrypt one payload into a single aes128gcm record (RFC 8188 framing with
// RFC 8291 key derivation). Returns the full message body (header || ciphertext
// || tag). `opts` may inject { salt, serverPrivateKey } for known-answer tests;
// otherwise a fresh salt and ephemeral key are generated.
function encryptPayload(uaPublic, authSecret, payload, opts) {
  opts = opts || {};
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const recordSize = opts.recordSize || 4096;

  // Ephemeral application-server ECDH key (or a fixed one for tests).
  const ecdh = crypto.createECDH("prime256v1");
  let asPublic;
  if (opts.serverPrivateKey) {
    ecdh.setPrivateKey(opts.serverPrivateKey);
    asPublic = ecdh.getPublicKey(); // raw 65 bytes
  } else {
    asPublic = ecdh.generateKeys(); // raw 65 bytes
  }
  const ecdhSecret = ecdh.computeSecret(uaPublic); // 32 bytes

  const salt = opts.salt || crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  // RFC 8291 3.4: IKM = HKDF(auth_secret, ecdh_secret,
  //   "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 2.2: PRK = HKDF-Extract(salt, IKM); then expand for CEK and nonce.
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // Single record: plaintext || 0x02 (last-record delimiter), no extra padding.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  if (record.length > recordSize - 16) {
    throw new Error("payload too large for record size");
  }

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  // RFC 8188 2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);

  return {
    body: Buffer.concat([header, asPublic, ciphertext, tag]),
    salt,
    serverPublicKey: asPublic,
    cek,
    nonce,
    ikm,
  };
}

// ---- RFC 8292 VAPID JWT ----------------------------------------------------

// Build an EC private KeyObject from raw base64url VAPID keys. The JWK import
// needs the public coordinates too, which we recover from the 65-byte public.
function privateKeyObjectFromVapid(vapid) {
  const pub = b64urlDecode(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID publicKey must be a 65-byte uncompressed point");
  }
  return crypto.createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
    },
  });
}

function buildVapidJwt(audience, subject, vapid, expiresInSeconds) {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(expiresInSeconds || 12 * 3600, 24 * 3600); // RFC 8292: <= 24h
  const payload = { aud: audience, exp, sub: subject };

  const signingInput =
    b64urlEncode(Buffer.from(JSON.stringify(header))) +
    "." +
    b64urlEncode(Buffer.from(JSON.stringify(payload)));

  const key = privateKeyObjectFromVapid(vapid);
  // ES256 = ECDSA/P-256/SHA-256 with a raw 64-byte (r||s) JOSE signature.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return signingInput + "." + b64urlEncode(signature);
}

// ---- send ------------------------------------------------------------------

// subscription: { endpoint, keys: { p256dh, auth } }
// payload:      string (already JSON-encoded by the caller) or Buffer
// vapid:        { publicKey, privateKey } base64url, from generateVapidKeys()
// opts:         { subject, ttl, urgency, topic, expiration } and test hooks
function sendPush(subscription, payload, vapid, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let body, endpoint, headers;
    try {
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        throw new Error("invalid subscription");
      }
      const uaPublic = b64urlDecode(subscription.keys.p256dh);
      const authSecret = b64urlDecode(subscription.keys.auth);
      if (uaPublic.length !== 65) throw new Error("p256dh must be 65 bytes");
      if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");

      const enc = encryptPayload(uaPublic, authSecret, payload, opts);
      body = enc.body;

      endpoint = new URL(subscription.endpoint);
      const audience = endpoint.origin;
      const subject = opts.subject || "mailto:push@agenthost.space";
      const jwt = buildVapidJwt(audience, subject, vapid, opts.expiration);
      const vapidPub = vapid.publicKey;

      headers = {
        "Authorization": `vapid t=${jwt}, k=${vapidPub}`,
        "Crypto-Key": `p256ecdsa=${vapidPub}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "TTL": String(opts.ttl == null ? 86400 : opts.ttl),
      };
      if (opts.urgency) headers["Urgency"] = String(opts.urgency);
      if (opts.topic) headers["Topic"] = String(opts.topic);
    } catch (err) {
      reject(err);
      return;
    }

    const req = https.request(
      {
        method: "POST",
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        path: endpoint.pathname + endpoint.search,
        headers,
      },
      (res) => {
        // Drain so the socket can be reused/closed; we only need the status.
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode }));
      }
    );
    req.on("error", reject);
    // A push endpoint that completes the TLS handshake but never responds would
    // otherwise pin the socket + this promise until the OS TCP timeout (minutes);
    // fan-outs fire on every cron/chat completion, so cap each attempt.
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error("push request timed out")));
    req.end(body);
  });
}

module.exports = {
  generateVapidKeys,
  sendPush,
  // Exported for tests (known-answer + structural). Not part of the stable API.
  _encryptPayload: encryptPayload,
  _buildVapidJwt: buildVapidJwt,
  _b64urlEncode: b64urlEncode,
  _b64urlDecode: b64urlDecode,
};
