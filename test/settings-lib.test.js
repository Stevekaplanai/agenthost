// settings-lib -- the settings backbone store. These tests pin the two things a
// bug would silently break: (1) fail-open, a missing or corrupt file yields
// exactly the code defaults (never a behavior change on a deployed box), and
// (2) v1->v2 forward migration, a settings.json written by the Phase-1 build
// (no `services` key) still loads and gets the v2 service defaults -- the live
// box already has Phase 1 deployed, so this path is real, not hypothetical.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import settings from "../container/settings-lib.js";

const { DEFAULTS, loadSettings, getEffective, saveOverrides, resetPath } = settings;

// A throwaway settings file under the OS temp dir; each test passes its own path
// so nothing touches the real ~/.agenthost/settings.json (and the mtime cache,
// which is keyed on the real SETTINGS_FILE, is bypassed for an explicit path).
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-settings-"));
  return path.join(dir, "settings.json");
}

test("no file -> pure defaults (fail-open)", () => {
  const f = tmpFile(); // never created
  assert.deepEqual(loadSettings(f), DEFAULTS);
});

test("corrupt file -> defaults, never throws", () => {
  const f = tmpFile();
  fs.writeFileSync(f, "{ not valid json ");
  assert.deepEqual(loadSettings(f), DEFAULTS);
});

test("v1 file (no services key) migrates forward to v2 service defaults", () => {
  const f = tmpFile();
  // Exactly the shape the Phase-1 build could have written to the live box.
  fs.writeFileSync(f, JSON.stringify({ v: 1, cost: { perChainUsd: 20 } }));
  const eff = getEffective(f);
  // The user's explicit override survives...
  assert.equal(eff.settings.cost.perChainUsd, 20);
  // ...and the missing services section is filled from v2 defaults, no error.
  assert.deepEqual(eff.settings.services, DEFAULTS.services);
  assert.equal(eff.settings.services.ollama.enabled, true);
  assert.equal(eff.settings.services.openclaw.enabled, true);
  // overrides is ONLY what the file set -- not the merged defaults.
  assert.deepEqual(eff.overrides, { v: 1, cost: { perChainUsd: 20 } });
});

test("service enabled flags accept booleans and round-trip", () => {
  const f = tmpFile();
  const r = saveOverrides({ services: { ollama: { enabled: false } } }, f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.paths, ["services.ollama.enabled"]);
  assert.equal(loadSettings(f).services.ollama.enabled, false);
  // openclaw untouched -> still its default.
  assert.equal(loadSettings(f).services.openclaw.enabled, true);
});

test("non-boolean service value is rejected", () => {
  const f = tmpFile();
  const r = saveOverrides({ services: { ollama: { enabled: "yes" } } }, f);
  assert.ok(r.error, "expected an error for a non-boolean enabled value");
  assert.match(r.error, /services\.ollama\.enabled/);
});

test("unknown service name is rejected by key", () => {
  const f = tmpFile();
  const r = saveOverrides({ services: { redis: { enabled: true } } }, f);
  assert.ok(r.error, "expected an unknown-key error");
  assert.match(r.error, /unknown key: services\.redis\.enabled/);
});

test("reset a service override reverts it to default", () => {
  const f = tmpFile();
  saveOverrides({ services: { openclaw: { enabled: false } } }, f);
  assert.equal(loadSettings(f).services.openclaw.enabled, false);
  const r = resetPath("services.openclaw.enabled", f);
  assert.equal(r.ok, true);
  assert.equal(loadSettings(f).services.openclaw.enabled, true);
});

// ---- v4: dormant Moonshot provider config (CONT-01) -------------------------
// The contract adds ONE dormant subtree: providers.moonshot {enabled, modelId}.
// Migration must be free (deep-merge forward) and preserve today's behavior --
// a live v3 box gets Moonshot disabled with zero migration step and zero change
// to any existing engine or service.

test("DEFAULTS is v6 with the seven-engine roster, DeepSeek limits, Moonshot dormant, and channels off", () => {
  assert.equal(DEFAULTS.v, 6);
  assert.deepEqual(Object.keys(DEFAULTS.llm.roster), ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"]);
  assert.deepEqual(DEFAULTS.llm.roster.deepseek, { active: true, inChat: true });
  assert.deepEqual(DEFAULTS.llm.roster.kimi, { active: true, inChat: true });
  assert.deepEqual(DEFAULTS.llm.roster.cursor, { active: true, inChat: true });
  assert.deepEqual(DEFAULTS.agents.deepseek, {
    role: "Engineering",
    limits: { perRunUsd: 1, perDayUsd: 5 },
  });
  assert.deepEqual(DEFAULTS.providers.moonshot, { enabled: false, modelId: "kimi-k3" });
  assert.deepEqual(DEFAULTS.channels, {
    // confirmGate defaults TRUE (fail-safe): a stored file without the key
    // deep-merges forward to gated -- an operator must explicitly opt out.
    // boardContext defaults FALSE (the "secret reporter" is opt-in, and gate.js
    // additionally requires the transport allowFrom-lock before honoring it).
    telegram: { enabled: false, owner: "openclaw", confirmGate: true, boardContext: false },
    discord:  { enabled: false, owner: "openclaw", confirmGate: true, boardContext: false },
    whatsapp: { enabled: false, owner: "hermes", confirmGate: true, boardContext: false },
  });
});

test("v5 settings migrate forward to DeepSeek and Kimi roster defaults without rewriting overrides", () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({
    v: 5,
    llm: { roster: { cursor: { inChat: false } } },
    agents: { kimi: { role: "Research lead" } },
  }));
  const eff = getEffective(f);
  assert.deepEqual(eff.settings.llm.roster.deepseek, { active: true, inChat: true });
  assert.deepEqual(eff.settings.llm.roster.kimi, { active: true, inChat: true });
  assert.equal(eff.settings.llm.roster.cursor.inChat, false);
  assert.equal(eff.settings.agents.kimi.role, "Research lead");
  assert.deepEqual(eff.settings.agents.deepseek.limits, { perRunUsd: 1, perDayUsd: 5 });
  assert.deepEqual(eff.overrides, {
    v: 5,
    llm: { roster: { cursor: { inChat: false } } },
    agents: { kimi: { role: "Research lead" } },
  });
});

test("DeepSeek roster, role, and nonzero spending limits validate and round-trip", () => {
  const f = tmpFile();
  const ok = saveOverrides({
    llm: { roster: { deepseek: { active: false, inChat: false } } },
    agents: { deepseek: { role: "Code review", limits: { perRunUsd: 2.5, perDayUsd: 12 } } },
  }, f);
  assert.equal(ok.ok, true);
  assert.deepEqual(loadSettings(f).llm.roster.deepseek, { active: false, inChat: false });
  assert.deepEqual(loadSettings(f).agents.deepseek, {
    role: "Code review",
    limits: { perRunUsd: 2.5, perDayUsd: 12 },
  });
  for (const limits of [
    { perRunUsd: 0 },
    { perRunUsd: 101 },
    { perDayUsd: 0 },
    { perDayUsd: 1001 },
  ]) {
    const bad = saveOverrides({ agents: { deepseek: { limits } } }, f);
    assert.ok(bad.error, `invalid DeepSeek limit rejected: ${JSON.stringify(limits)}`);
  }
});

test("settings writes never follow the old predictable temporary-file path", (t) => {
  const f = tmpFile();
  const victim = path.join(path.dirname(f), "victim.json");
  const predictable = f + ".tmp";
  fs.writeFileSync(victim, "do-not-touch\n");
  try {
    fs.symlinkSync(victim, predictable);
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("Windows symlink creation requires Developer Mode");
      return;
    }
    throw error;
  }
  const result = saveOverrides({ llm: { roster: { deepseek: { active: false } } } }, f);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(victim, "utf8"), "do-not-touch\n");
  assert.equal(fs.lstatSync(predictable).isSymbolicLink(), true);
});

test("channels.<ch>.boardContext is settable (bool) and rejects non-bools", () => {
  const f = tmpFile();
  const ok = saveOverrides({ channels: { telegram: { boardContext: true } } }, f);
  assert.equal(ok.ok, true);
  assert.equal(loadSettings(f).channels.telegram.boardContext, true);
  assert.equal(loadSettings(f).channels.discord.boardContext, false, "other channels stay off");
  const bad = saveOverrides({ channels: { telegram: { boardContext: "yes" } } }, f);
  assert.ok(bad.error, "non-bool rejected");
  assert.match(bad.error, /channels\.telegram\.boardContext/);
});

test("channels.<ch>.confirmGate is settable (bool) and rejects non-bools", () => {
  const f = tmpFile();
  const ok = saveOverrides({ channels: { telegram: { confirmGate: false } } }, f);
  assert.equal(ok.ok, true);
  assert.equal(loadSettings(f).channels.telegram.confirmGate, false);
  assert.equal(loadSettings(f).channels.discord.confirmGate, true, "other channels stay gated");
  const bad = saveOverrides({ channels: { discord: { confirmGate: "off" } } }, f);
  assert.ok(bad.error, "string 'off' is rejected -- bools only");
  assert.match(bad.error, /channels\.discord\.confirmGate/);
});

test("v3 file (no providers key) migrates forward to v4 Moonshot defaults", () => {
  const f = tmpFile();
  // A real v3 box: git section present, no providers section.
  fs.writeFileSync(f, JSON.stringify({ v: 3, git: { autonomyLevel: 4 } }));
  const eff = getEffective(f);
  // git override preserved...
  assert.equal(eff.settings.git.autonomyLevel, 4);
  // ...and the missing providers section is filled from v4 defaults, no error.
  assert.deepEqual(eff.settings.providers.moonshot, { enabled: false, modelId: "kimi-k3" });
  // The stored override is NOT rewritten just because it was read.
  assert.deepEqual(eff.overrides, { v: 3, git: { autonomyLevel: 4 } });
});

test("all current engines/services unchanged after v4 migration (no behavior drift)", () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ v: 3 }));
  const s = loadSettings(f);
  // Every pre-v4 default still exactly as before.
  assert.equal(s.cost.perChainUsd, 15);
  assert.equal(s.services.ollama.enabled, true);
  assert.equal(s.services.openclaw.enabled, true);
  assert.equal(s.llm.roster.claude.inChat, true);
  assert.equal(s.llm.roster.cursor.inChat, true);
  assert.equal(s.git.autonomyLevel, 0);
  // Moonshot is present but dormant.
  assert.equal(s.providers.moonshot.enabled, false);
});

test("Cursor roster controls validate and round-trip", () => {
  const f = tmpFile();
  const result = saveOverrides({ llm: { roster: { cursor: { active: false, inChat: false } } } }, f);
  assert.equal(result.ok, true);
  assert.deepEqual(loadSettings(f).llm.roster.cursor, { active: false, inChat: false });
  assert.ok(saveOverrides({ llm: { roster: { cursor: { active: "no" } } } }, f).error);
});

test("providers.moonshot.enabled accepts a boolean and round-trips", () => {
  const f = tmpFile();
  const r = saveOverrides({ providers: { moonshot: { enabled: true } } }, f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.paths, ["providers.moonshot.enabled"]);
  assert.equal(loadSettings(f).providers.moonshot.enabled, true);
});

test("providers.moonshot.modelId accepts only the allowlisted model", () => {
  const f = tmpFile();
  assert.equal(saveOverrides({ providers: { moonshot: { modelId: "kimi-k3" } } }, f).ok, true);
  const bad = saveOverrides({ providers: { moonshot: { modelId: "gpt-4" } } }, f);
  assert.ok(bad.error);
  assert.match(bad.error, /providers\.moonshot\.modelId/);
});

test("no writable provider endpoint, credential, header, or tool path exists", () => {
  const f = tmpFile();
  for (const attack of [
    { providers: { moonshot: { origin: "https://evil.example" } } },
    { providers: { moonshot: { credentialRef: "OPENAI_API_KEY" } } },
    { providers: { moonshot: { apiKey: "sk-leak" } } },
    { providers: { moonshot: { headers: { Authorization: "Bearer x" } } } },
    { providers: { moonshot: { allowsTools: true } } },
    { providers: { openai: { enabled: true } } },
  ]) {
    const r = saveOverrides(attack, f);
    assert.ok(r.error, "attack must be rejected: " + JSON.stringify(attack));
    assert.match(r.error, /unknown key/);
  }
});

// ---- v5 channels (CONT-05) ---------------------------------------------------

test("v4 file (no channels key) migrates forward to v5 channels-off defaults", () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ v: 4, git: { autonomyLevel: 4 } }));
  const eff = getEffective(f);
  assert.equal(eff.settings.git.autonomyLevel, 4, "prior override preserved");
  assert.deepEqual(eff.settings.channels, DEFAULTS.channels, "missing channels filled from v5 defaults");
  assert.deepEqual(eff.overrides, { v: 4, git: { autonomyLevel: 4 } }, "stored file not rewritten on read");
});

test("channel enabled flags accept booleans and round-trip", () => {
  const f = tmpFile();
  const r = saveOverrides({ channels: { telegram: { enabled: true } } }, f);
  assert.equal(r.ok, true);
  assert.equal(loadSettings(f).channels.telegram.enabled, true);
  // Discord + whatsapp stay at their defaults (off) -- one channel's change is isolated.
  assert.equal(loadSettings(f).channels.discord.enabled, false);
});

test("owner is PINNED to the one capable transport per channel (single-owner invariant)", () => {
  const f = tmpFile();
  // The capable owner is accepted...
  assert.equal(saveOverrides({ channels: { telegram: { owner: "openclaw" } } }, f).ok, true);
  assert.equal(saveOverrides({ channels: { whatsapp: { owner: "hermes" } } }, f).ok, true);
  // ...an incapable owner is REJECTED (this is how "two engines can't own one channel"
  // is enforced at the settings layer -- there is exactly one eligible owner).
  const t = saveOverrides({ channels: { telegram: { owner: "hermes" } } }, f);
  assert.ok(t.error); assert.match(t.error, /telegram can only be owned by openclaw/);
  const w = saveOverrides({ channels: { whatsapp: { owner: "openclaw" } } }, f);
  assert.ok(w.error); assert.match(w.error, /whatsapp can only be owned by hermes/);
  const bogus = saveOverrides({ channels: { discord: { owner: "claude" } } }, f);
  assert.ok(bogus.error); assert.match(bogus.error, /discord can only be owned by openclaw/);
});

test("channelOwnerEligible is the one source of truth used by the validators", () => {
  const { channelOwnerEligible, CHANNEL_OWNERS } = settings;
  assert.equal(channelOwnerEligible("telegram", "openclaw"), true);
  assert.equal(channelOwnerEligible("telegram", "hermes"), false);
  assert.equal(channelOwnerEligible("whatsapp", "hermes"), true);
  assert.equal(channelOwnerEligible("whatsapp", "openclaw"), false);
  assert.equal(channelOwnerEligible("slack", "openclaw"), false, "unknown channel is not eligible for anyone");
  // Every default owner is itself eligible -- the defaults can't encode an impossible pin.
  for (const [ch, cfg] of Object.entries(DEFAULTS.channels)) {
    assert.ok(CHANNEL_OWNERS[ch].includes(cfg.owner), `${ch} default owner must be eligible`);
  }
});

test("an unknown channel name is rejected by key", () => {
  const f = tmpFile();
  const r = saveOverrides({ channels: { slack: { enabled: true } } }, f);
  assert.ok(r.error); assert.match(r.error, /unknown key/);
});
