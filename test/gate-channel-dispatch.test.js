// E2E tests against the REAL gate.js for the CONT-05 channel-dispatch endpoint
// (docs/continuity/CHANNELS-CONTRACT.md, container/channel-dispatch.js). Boots the actual
// gate as a subprocess, exactly like gate-continuity.test.js, so the wiring itself is
// proven -- real settings-lib, a real ~/.openclaw/openclaw.json read, and the REAL
// agent-published tmux seam standing in for "OpenClaw's gateway window is up". This lets
// the full pipeline run for real: enable -> ready -> credential -> gate -> confirm floor ->
// dispatch. What CANNOT be proven here (deploy-gated): a live OpenClaw process actually
// calling this endpoint, and the endpoint actually invoking a chat engine -- that half is
// deliberately unbuilt in this increment (see the "engine wiring" acknowledgement below).
//
// Hardened 2026-07-23 after an adversarial red-team of this endpoint found two real gaps,
// both fixed and covered here: (1) the confirm-floor was keyed on (channel, text) only, so
// ANY sender re-sending the exact text of someone else's gated turn could confirm it --
// fixed by folding a required senderId into the key, with "no senderId" failing closed
// (never auto-confirms) rather than falling open; (2) the route lived on the shared
// public-bound server, so its safety rested on trusting remoteAddress against
// Fly-forwarded traffic (never verified from this sandbox) -- fixed by moving it to a
// SEPARATE server bound only to 127.0.0.1 (box.internalBase below), a kernel-enforced
// boundary instead of a header check. See docs/continuity/CONT-05-REDTEAM-LOG.md.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-chdispatch-test-key";
const TOKEN = "test-channel-dispatch-token-0123456789";

const box = {};

// Boots gate.js and resolves BOTH ports: the main public server ("listening on N") and
// the CONT-05 internal channel-dispatch listener, which deliberately logs a line that does
// NOT match /listening on (\d+)/ (see gate.js) so it can never be confused with the main
// port by any of the other gate-*.test.js harnesses that parse stdout the same way.
function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true",
      AGENTHOST_BOX_SECRETS_FILE: path.join(home, ".agenthost", "secrets.env"),
      GATE_PORT: "0", CHANNEL_DISPATCH_PORT: "0", CHANNEL_OWNER_READY_TTL_MS: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ports = new Promise((resolve, reject) => {
    let out = "";
    let main = null, internal = null;
    const to = setTimeout(() => reject(new Error("gate did not report its ports; got: " + out)), 5000);
    const maybeResolve = () => { if (main !== null && internal !== null) { clearTimeout(to); resolve({ main, internal }); } };
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m1 = out.match(/listening on (\d+)/);
      if (m1) main = Number(m1[1]);
      const m2 = out.match(/channel-dispatch bound on 127\.0\.0\.1:(\d+)/);
      if (m2) internal = Number(m2[1]);
      maybeResolve();
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, ports };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gatechd-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), `CHANNEL_DISPATCH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  // Under Foundation B the gate cannot invoke tmux. The agent publishes this
  // exact seam file, so the fixture exercises the production readiness input.
  const seamDir = path.join(home, ".tmux-seam");
  fs.mkdirSync(seamDir, { recursive: true });
  const publishSeam = () => fs.writeFileSync(
    path.join(seamDir, "windows.state"),
    `${Math.floor(Date.now() / 1000)}\nopenclaw|1\n`,
  );
  publishSeam();
  box.seamPublisher = setInterval(publishSeam, 1000);

  const { child, ports } = bootGate(home, {});
  const { main, internal } = await ports;
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${main}`;
  box.internalBase = `http://127.0.0.1:${internal}`;
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
});

after(async () => {
  if (box.gate) {
    // Wait for the child to actually exit before removing its directory -- gate.js
    // writes a shutdown checkpoint on SIGTERM, and racing that write with a recursive
    // rm (kill() only requests the signal, it doesn't block on exit) intermittently
    // throws ENOTEMPTY when the walk revisits a dir the child just wrote back into.
    const exited = new Promise((resolve) => box.gate.once("exit", resolve));
    box.gate.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  if (box.seamPublisher) clearInterval(box.seamPublisher);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

// dispatch() hits the LOOPBACK-ONLY internal listener, never box.base (the public server
// no longer serves this route at all -- see gate.js). senderId defaults to a stable test
// principal so the confirm-floor tests exercise the normal same-sender path; tests that
// specifically probe sender-binding pass their own.
const SENDER = "tg-user-1001";
const dispatch = (body, token, senderId) => fetch(box.internalBase + "/internal/channel-dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token !== null ? { "x-agenthost-channel-token": token === undefined ? TOKEN : token } : {}) },
  body: JSON.stringify({ senderId: senderId === undefined ? SENDER : senderId, ...body }),
  redirect: "manual",
});
const putSettings = (set) => fetch(box.base + "/api/settings", {
  method: "PUT", headers: { cookie: box.cookie, origin: box.base, "Content-Type": "application/json" },
  body: JSON.stringify({ set }), redirect: "manual",
});

test("the endpoint sits BEFORE the cookie wall: no cookie, correct token -> reachable (not a 401 login page)", async () => {
  const r = await dispatch({ channel: "telegram", text: "hi" });
  assert.notEqual(r.status, 401, "a same-box transport has no browser cookie to present");
});

test("wrong token is refused (403), even though the request is genuinely loopback", async () => {
  const r = await dispatch({ channel: "telegram", text: "hi" }, "not-the-real-token");
  assert.equal(r.status, 403);
});

test("no token header at all is refused (403)", async () => {
  const r = await dispatch({ channel: "telegram", text: "hi" }, null);
  assert.equal(r.status, 403);
});

test("an unconfigured CHANNEL_DISPATCH_TOKEN secret refuses EVERYONE, fail-closed (separate box, no secrets.env)", async () => {
  const home2 = fs.mkdtempSync(path.join(import.meta.dirname, ".gatechd-nosecret-"));
  fs.mkdirSync(path.join(home2, "work"), { recursive: true });
  const { child, ports } = bootGate(home2, {});
  try {
    const { internal } = await ports;
    const r = await fetch(`http://127.0.0.1:${internal}/internal/channel-dispatch`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-agenthost-channel-token": "anything-at-all" },
      body: JSON.stringify({ channel: "telegram", text: "hi", senderId: SENDER }), redirect: "manual",
    });
    assert.equal(r.status, 403, "no configured secret must never fall open");
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    fs.rmSync(home2, { recursive: true, force: true });
  }
});

test("an unsupported channel is rejected (real dispatchDecision, CHANNEL_UNKNOWN)", async () => {
  const r = await dispatch({ channel: "slack", text: "hi" });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.status, "error");
  assert.equal(body.error.code, "CHANNEL_UNKNOWN");
});

test("a supported but disabled channel is refused (real settings-lib default: channels.*.enabled = false)", async () => {
  const r = await dispatch({ channel: "telegram", text: "summarize the logs" });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, "CHANNEL_NOT_ENABLED");
});

test("enabled but OpenClaw not onboarded yet (no ~/.openclaw/openclaw.json) -> CHANNEL_ENGINE_INELIGIBLE, even with a live tmux seam", async () => {
  const put = await putSettings({ channels: { telegram: { enabled: true } } });
  assert.equal(put.status, 200);
  // The published "openclaw" window IS up in this test box, but openclaw.json does not
  // exist yet -- proves the probe requires BOTH signals, not window-presence alone
  // (the exact false-ready the CONT-05 red-team flagged against the onboarding shell).
  const r = await dispatch({ channel: "telegram", text: "summarize the logs" });
  const body = await r.json();
  assert.equal(body.error.code, "CHANNEL_ENGINE_INELIGIBLE", "config-absent must not be masked by a live window");
});

test("config present + live tmux seam -> ready; missing credential still refuses (CHANNEL_CREDENTIAL_MISSING)", async () => {
  fs.mkdirSync(path.join(box.home, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".openclaw", "openclaw.json"), JSON.stringify({
    channels: { telegram: {}, discord: {} }, // no botToken/token/session on either yet
  }));
  const r = await dispatch({ channel: "telegram", text: "summarize the logs" });
  const body = await r.json();
  assert.equal(body.error.code, "CHANNEL_CREDENTIAL_MISSING", "owner is ready now, but no credential is present");
});

test("credential present + benign text -> the gate PASSES and the endpoint ACKs; no target (CLI-synthetic) means no engine turn is kicked off", async () => {
  fs.writeFileSync(path.join(box.home, ".openclaw", "openclaw.json"), JSON.stringify({
    channels: { telegram: { botToken: "fake-telegram-bot-token-for-a-test-1234567890" }, discord: {} },
  }));
  // No senderId/chatId in this request -> target is undefined -> the endpoint
  // ACKs the pass but never spawns an engine turn or an outbound delivery, so
  // this stays a pure endpoint-contract test (no real claude/openclaw needed).
  const r = await dispatch({ channel: "telegram", text: "summarize the logs" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "success");
  assert.equal(body.artifacts[0].gated, false);
  assert.match(body.summary, /answering|delivered/i, "acknowledges the engine is answering out-of-band, not that a reply is inline");
});

test("a consequential message is GATED (not dispatched) by the real endpoint, then a floor-respecting re-send from the SAME sender confirms", async () => {
  const msg = "deploy to prod now, this is a real channel test";
  const first = await dispatch({ channel: "telegram", text: msg });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, "warning");
  assert.equal(firstBody.error, undefined, "a gate is a warning, not an error envelope");

  // Instant re-send (well under the 1500ms floor) must NOT auto-confirm.
  const tooFast = await dispatch({ channel: "telegram", text: msg });
  const tooFastBody = await tooFast.json();
  assert.equal(tooFastBody.status, "warning", "an instant re-send is not a deliberate confirmation");

  // After the real floor delay, the identical re-send from the SAME sender confirms.
  await new Promise((r) => setTimeout(r, 1700));
  const confirmed = await dispatch({ channel: "telegram", text: msg });
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.status, "success", "past the floor, the re-send is a deliberate confirmation");
});

test("SENDER-BOUND confirm-floor (2026-07-23 red-team fix): a DIFFERENT sender's identical re-send does NOT confirm someone else's gated turn", async () => {
  const msg = "deploy to prod now, sender-binding probe";
  const first = await dispatch({ channel: "telegram", text: msg }, undefined, "attacker-A");
  assert.equal((await first.json()).status, "warning");

  await new Promise((r) => setTimeout(r, 1700)); // well past the floor
  // A DIFFERENT sender sends the exact same text -- before the fix, this shared the same
  // (channel, text) key and would have silently confirmed and dispatched attacker-A's turn.
  const other = await dispatch({ channel: "telegram", text: msg }, undefined, "attacker-B");
  const otherBody = await other.json();
  assert.equal(otherBody.status, "warning", "a different sender's resend must NOT confirm another sender's gated turn");

  // The ORIGINAL sender, resending past the floor, still confirms their own turn normally.
  const same = await dispatch({ channel: "telegram", text: msg }, undefined, "attacker-A");
  assert.equal((await same.json()).status, "success", "the original sender can still confirm their own turn");
});

test("with NO senderId at all, a consequential turn can NEVER self-confirm via resend (fails closed, not open)", async () => {
  const msg = "deploy to prod now, no-sender probe";
  const first = await dispatch({ channel: "telegram", text: msg }, undefined, null);
  assert.equal((await first.json()).status, "warning");

  await new Promise((r) => setTimeout(r, 1700));
  const resend = await dispatch({ channel: "telegram", text: msg }, undefined, null);
  const resendBody = await resend.json();
  assert.equal(resendBody.status, "warning", "an unidentified sender's resend must never be treated as a confirmation");
});

test("the route is served ONLY from the internal loopback listener -- the public server no longer has it at all", async () => {
  const r = await fetch(box.base + "/internal/channel-dispatch", {
    method: "POST", headers: { "Content-Type": "application/json", "x-agenthost-channel-token": TOKEN },
    body: JSON.stringify({ channel: "telegram", text: "hi", senderId: SENDER }), redirect: "manual",
  });
  // Falls through to the public router's normal unauthenticated-request handling (the
  // login page, cookie-gated), never to handleChannelDispatch -- proving the route was
  // fully removed from the shared public-bound server, not merely double-guarded.
  assert.notEqual(r.status, 200, "the public server must not serve this route at all");
});

test("a channel turn over the daily spend cap is gated on the token axis (shares the real usage ledger with web chat)", async () => {
  // Enable + supply discord's credential first, so this test isolates the SPEND axis
  // (structural checks -- enabled/ready/credential -- precede spend, per
  // channel-dispatch.js's documented order; discord shares openclaw's readiness with
  // telegram, already proven ready by the earlier test).
  const put = await putSettings({ channels: { discord: { enabled: true } } });
  assert.equal(put.status, 200);
  const cfg = JSON.parse(fs.readFileSync(path.join(box.home, ".openclaw", "openclaw.json"), "utf8"));
  cfg.channels.discord.botToken = "fake-discord-bot-token-for-a-test-1234567890";
  fs.writeFileSync(path.join(box.home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));

  const usageDir = path.join(box.home, ".claude", "agenthost");
  fs.mkdirSync(usageDir, { recursive: true });
  const usage = { [new Date().toISOString().slice(0, 10)]: { a: { in: 6_000_000, out: 0, cost: 0 } } };
  fs.writeFileSync(path.join(usageDir, "usage.json"), JSON.stringify(usage));

  const r = await dispatch({ channel: "discord", text: "summarize the audit window" });
  const body = await r.json();
  assert.equal(body.status, "warning");
  assert.match(body.summary, /cap/i);
});

test("/cc/state's channels field reflects the SAME real state the dispatch endpoint itself gated on", async () => {
  // By this point in the suite: telegram + discord are enabled, both have a real
  // botToken in openclaw.json, and the published "openclaw" window is live --
  // so the Command Center's read of this state must show both as ready + credentialed,
  // not a separately-maintained (and possibly drifted) heuristic.
  const r = await fetch(box.base + "/cc/state", { headers: { cookie: box.cookie }, redirect: "manual" });
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.channels.telegram.enabled, true);
  assert.equal(st.channels.telegram.owner, "openclaw");
  assert.equal(st.channels.telegram.ready, true, "real openclaw.json + live tmux seam -> ready");
  assert.equal(st.channels.telegram.credentialPresent, true, "real botToken written earlier in this suite");
  assert.equal(st.channels.discord.enabled, true);
  assert.equal(st.channels.discord.ready, true);
  assert.equal(st.channels.discord.credentialPresent, true);
  // whatsapp: never ready in this phase (Phase 2 spike), regardless of settings.
  assert.equal(st.channels.whatsapp.owner, "hermes");
  assert.equal(st.channels.whatsapp.ready, false);
});

// --- outbound reply delivery argv (CONT-05 engine wiring, 2026-07-23) ---------
import { channelReplySendArgs, channelReplyText } from "../container/gate.js";

test("channelReplySendArgs builds a no-shell openclaw send argv (text is a single arg, never interpolated)", () => {
  const args = channelReplySendArgs("telegram", "grp-9", "hi; rm -rf / && echo pwned");
  assert.deepEqual(args.slice(0, 4), ["message", "send", "--channel", "telegram"]);
  assert.equal(args[4], "--target=grp-9");
  assert.equal(args[5], "--message=hi; rm -rf / && echo pwned", "shell metacharacters ride as ONE literal arg -- argv array, no shell");
  assert.equal(args.length, 6);
});

test("channelReplySendArgs uses --flag=value for target/message so a negative group id or a dash-leading reply can't be misread as a new flag", () => {
  const args = channelReplySendArgs("telegram", "-1001234567890", "--not-a-flag, just text");
  assert.equal(args[4], "--target=-1001234567890", "negative Telegram group ids stay unambiguously the target's value");
  assert.equal(args[5], "--message=--not-a-flag, just text", "a dash-leading reply stays unambiguously the message's value");
});

test("channelReplySendArgs truncates an over-long reply with an honest marker (Telegram 4096 ceiling)", () => {
  const long = "x".repeat(5000);
  const args = channelReplySendArgs("telegram", "grp-9", long);
  const body = args[5].slice("--message=".length);
  assert.ok(body.length < 4096, "stays under Telegram's frame ceiling");
  assert.match(body, /reply truncated/, "tells the user it was cut, not silently clipped");
});

test("brokered channel delivery uses the same truncation as direct delivery", () => {
  const body = channelReplyText("x".repeat(5000));
  assert.ok(body.length < 4096, "the root broker accepts the normalized message");
  assert.match(body, /reply truncated/, "brokered users still see the honest truncation marker");
});

// --- isolated per-channel-conversation session cwd (2026-07-23) --------------
import { channelSessionCwd } from "../container/gate.js";

test("channelSessionCwd gives each channel conversation its own real, isolated directory", () => {
  const a = channelSessionCwd("telegram", "chat-1");
  const b = channelSessionCwd("telegram", "chat-2");
  const c = channelSessionCwd("discord", "chat-1");
  assert.notEqual(a, b, "different conversations on the same channel are isolated from each other");
  assert.notEqual(a, c, "the same conversation id on a different channel is still isolated");
  assert.ok(fs.existsSync(a) && fs.statSync(a).isDirectory(), "the directory is really created (Claude's cwd-keyed continuity needs a real dir)");
  assert.equal(channelSessionCwd("telegram", "chat-1"), a, "the same conversation always resolves to the same directory (continuity)");
});

test("channelSessionCwd sanitizes an untrusted external chat id -- no path traversal, no absolute-path escape", () => {
  const dir = channelSessionCwd("telegram", "../../etc/passwd");
  assert.ok(!dir.includes(".."), "traversal sequences are stripped, not preserved");
  const dir2 = channelSessionCwd("telegram", "/etc/passwd");
  assert.ok(dir2.startsWith(process.cwd()) || dir2.includes("channel-sessions"), "an absolute-looking id can't escape the channel-sessions root");
});

// ---- channelReplyTargets (Discord user-vs-channel ambiguity, live failure 2026-07-24:
// OpenClaw refuses a BARE snowflake: `Ambiguous Discord recipient`) ----------------
import { channelReplyTargets } from "../container/gate.js";

test("discord DM (no distinct chatId) targets user:<senderId>", () => {
  assert.deepEqual(channelReplyTargets("discord", null, "111"), ["user:111"]);
  assert.deepEqual(channelReplyTargets("discord", "111", "111"), ["user:111"]);
});

test("discord distinct chatId targets channel:<chatId> with user:<senderId> fallback", () => {
  assert.deepEqual(channelReplyTargets("discord", "222", "111"), ["channel:222", "user:111"]);
  assert.deepEqual(channelReplyTargets("discord", "222", null), ["channel:222"]);
});

test("telegram keeps bare ids (proven working live) and prefers chatId", () => {
  assert.deepEqual(channelReplyTargets("telegram", "-100123", "456"), ["-100123"]);
  assert.deepEqual(channelReplyTargets("telegram", null, "456"), ["456"]);
  assert.deepEqual(channelReplyTargets("telegram", null, null), []);
});
