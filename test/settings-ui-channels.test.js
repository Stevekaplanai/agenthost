// CONT-05: the generated Settings Channels panel must agree with the server (settings-lib).
// A UI toggle pointing at a path the server rejects is a dead control -- these tests pin
// the UI<->server contract without needing a browser or a running gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import settings from "../container/settings-lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(HERE, "..", "dashboard", "components", "agenthost", "settings.tsx"), "utf8");
const settingsPaths = source.slice(source.indexOf("const SETTINGS_PATHS"), source.indexOf("] as const", source.indexOf("const SETTINGS_PATHS")));
const channelsPane = source.slice(source.indexOf('pane === "channels-title"'), source.indexOf('pane === "cost-title"'));

function nest(dotPath, value) {
  const out = {};
  const keys = dotPath.split(".");
  keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), out);
  return out;
}

test("every writable channel in generated Settings is a path the server accepts", () => {
  const paths = [...new Set([...settingsPaths.matchAll(/"(channels\.[a-z]+\.enabled)"/g)].map((m) => m[1]))];
  assert.deepEqual(paths, ["channels.telegram.enabled", "channels.discord.enabled"],
    "Telegram + Discord are the exact writable channel enable paths");
  for (const p of paths) {
    const r = settings.validateSet(nest(p, true));
    assert.equal(r.ok, true, `${p} must be accepted by the server (got: ${r.error || "ok"})`);
  }
});

test("the generated channel cards save through those same two paths", () => {
  assert.match(channelsPane, /\(\["telegram", "discord"\] as const\)\.map\(\(channel\) =>/,
    "the visible channel cards are built from Telegram and Discord");
  assert.match(channelsPane, /change\(`channels\.\$\{channel\}\.enabled`, value\)/,
    "each Enabled switch writes the matching SETTINGS_PATHS key");
});

test("WhatsApp is HELD: shown as a row, but no writable toggle (it can't be gated yet)", () => {
  assert.doesNotMatch(settingsPaths, /channels\.whatsapp\.enabled/,
    "WhatsApp is absent from the saveable paths -- shipping one would enable an ungoverned channel");
  const whatsapp = channelsPane.slice(channelsPane.indexOf('<SettingsCard title="WhatsApp"'));
  assert.ok(whatsapp.length > 0, "WhatsApp still appears (held) so the story is complete");
  assert.doesNotMatch(whatsapp, /InlineToggle/, "the held WhatsApp card exposes no writable switch");
  assert.match(whatsapp, /cannot pass the box consequence gate yet/i, "the held state is labeled on screen");
});

test("channel toggles ride OpenClaw: the UI disables them when OpenClaw is off", () => {
  assert.match(source, /const openclawOn = draft\.services\.openclaw\.enabled/,
    "the dependency reads the actual OpenClaw setting");
  assert.match(channelsPane, /disabled=\{!openclawOn\}/,
    "channel switches cannot be changed while OpenClaw is off");
  assert.match(channelsPane, /Turn on OpenClaw in Box Services before changing this channel/,
    "the disabled state names its cause");
});
