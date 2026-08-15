// Agent profiles. Steve, 2026-07-26: "build them please".
//
// The backend for this shipped long ago and nothing ever rendered it:
// /profiles/data assembled a full payload, but the old surface contained zero
// references to profiles. The generated Agents room consumes that payload.
//
// Two bugs found while wiring it up, both invisible until something consumed
// the endpoint:
//   1. the handler read `profiles.artifacts.find(p => p.agentId === id)` but
//      buildAgentProfiles returns a flat ARRAY of {type,id,data}, so `profile`
//      was always {} and every card's provider/fallback rendered null.
//   2. those fields live under data.providerRoute, not data.primary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAgentProfiles } from "../container/providers-lib.js";

const CONTAINER = path.join(import.meta.dirname, "..", "container");
const gate = fs.readFileSync(path.join(CONTAINER, "gate.js"), "utf8");
const DASHBOARD = path.join(import.meta.dirname, "..", "dashboard");
const agentsView = fs.readFileSync(path.join(DASHBOARD, "components", "agenthost", "agents-view.tsx"), "utf8");
const commandCenter = fs.readFileSync(path.join(DASHBOARD, "components", "agenthost", "command-center.tsx"), "utf8");
const navigation = fs.readFileSync(path.join(DASHBOARD, "components", "agenthost", "navigation.ts"), "utf8");
const api = fs.readFileSync(path.join(DASHBOARD, "lib", "api.ts"), "utf8");
const live = fs.readFileSync(path.join(DASHBOARD, "lib", "live.ts"), "utf8");

// ---- the endpoint contract -------------------------------------------------

test("buildAgentProfiles returns a flat array keyed by id (not {artifacts})", () => {
  const p = buildAgentProfiles({});
  assert.ok(Array.isArray(p), "it is an array");
  assert.ok(!p.artifacts, "there is no .artifacts wrapper; the old lookup invented one");
  assert.ok(p.length >= 5, "every known agent is present (" + p.length + ")");
  for (const item of p) {
    assert.ok(item.id, "each item is keyed by .id");
    assert.ok(!("agentId" in item), "not .agentId; the old lookup used a field that never existed");
    assert.ok(item.data, "each item carries a .data payload");
  }
});

test("the gate looks profiles up the way they are actually shaped", () => {
  // Slice to the end of the handler (the next route), not a fixed byte count:
  // a comment added inside the handler must not push assertions out of range.
  const start = gate.indexOf('"/profiles/data"');
  const handler = gate.slice(start, gate.indexOf('url.pathname === "/cc"', start));
  assert.ok(!/profiles\.artifacts/.test(handler), "the phantom .artifacts lookup is gone");
  assert.match(handler, /profiles\.find\(p => p && p\.id === a\.id\)/, "it finds by id");
  assert.match(handler, /\.data \|\| \{\}/, "and unwraps .data");
  assert.match(handler, /providerRoute && profile\.providerRoute\.primary/, "provider comes from providerRoute.primary");
  assert.match(handler, /providerRoute\.fallbackProvider/, "fallback too");
  // Capabilities are not taken from the profile builder: buildOneProfile
  // hardcodes every one to unavailable/NOT_WIRED (a stub). They are computed
  // in the gate from live box state instead.
  assert.match(handler, /capabilities: agentCapabilities\(a, eng, tmuxNames\)/,
    "capabilities come from live box state, not the builder's placeholders");
});

test("capability verdicts carry a machine-readable reason when unavailable", () => {
  const claude = buildAgentProfiles({}).find((p) => p.id === "claude").data;
  for (const key of ["chat", "terminal", "unattended", "review"]) {
    const cap = claude.capabilities[key];
    assert.ok(cap && cap.state, key + " has a state");
    if (cap.state !== "available") {
      assert.ok(cap.reasonCode, key + " explains WHY it is unavailable; a card must never just say 'no'");
    }
  }
});

// ---- the generated Agents room --------------------------------------------

test("the generated Agents room consumes the observed profile payload", () => {
  assert.match(api, /export function fetchAgentProfiles[\s\S]*getJson\("\/profiles\/data"\)/,
    "the dashboard API reads the live profile endpoint");
  assert.match(live, /export function useAgentProfiles[\s\S]*usePolled\(fetchAgentProfiles, 30000\)/,
    "profiles are refreshed from the box rather than copied into the client");
  assert.match(commandCenter, /profiles=\{agentProfiles\.agents\}/,
    "the shell hands the observed payload to AgentsView");
  assert.match(agentsView, /profiles\?\.find\(\(item\) => item\.id === agent\.id\)/,
    "the selected roster row is joined to its observed profile by id");
  assert.match(agentsView, /<CapabilityPanel profile=\{profile\} capabilities=\{capabilities\}/,
    "the current profile feeds the rendered capability panel");
});

test("the generated route selects the Agents room without a standalone page", () => {
  assert.match(navigation, /agents:\s*\[[\s\S]*key: "profile"[\s\S]*route: "systems\/agents"/,
    "Agents has a stable in-shell route");
  assert.match(commandCenter, /activeRoom === "agents"[\s\S]*<AgentsView/,
    "that route renders AgentsView inside the one generated shell");
});

test("a capability card reports the payload verdict, never local engine guesswork", () => {
  const block = agentsView.slice(agentsView.indexOf("const capabilities:"), agentsView.indexOf("const availableCapabilityCount"));
  assert.match(block, /const capability = profile \? profile\.capabilities\[key\] : undefined/,
    "reads each server capability by its declared key");
  assert.match(block, /capability\?\.reasonCode[\s\S]*capabilityReason\(capability\.reasonCode, brand\.name\)/,
    "uses the server reason code for unavailable states");
  assert.doesNotMatch(block, /chat-only|no terminal window/i,
    "the generated view does not hardcode engine-specific capability claims");
});

test("an unavailable capability shows both its machine code and plain-English cause", () => {
  assert.match(agentsView, /const CAPABILITY_REASONS: Record<Exclude<CapabilityReason, "NOT_WIRED">, string> = \{/,
    "reason codes map to plain English");
  assert.match(agentsView, /if \(reason === "NOT_WIRED"\) return `\$\{brandName\} has no working route for this capability\.`/,
    "the brand-specific route failure is translated without inventing a static product name");
  for (const code of ["NOT_WIRED", "NOT_APPROVED", "NOT_INSTALLED", "NO_CREDENTIAL"]) {
    assert.ok(agentsView.includes(code), code + " is translated for the operator");
  }
  assert.match(agentsView, /capability\.capability\?\.reasonCode[\s\S]*\{capability\.capability\.reasonCode\}/,
    "the card keeps the machine-readable reason visible");
  assert.match(agentsView, /<span className="font-mono text-dim">Cause:<\/span> \{capability\.cause\}/,
    "and renders the derived plain-English cause");
});

test("profile actions use the generated shell's real thread and terminal callbacks", () => {
  assert.match(agentsView, /onOpenThread=\{\(\) => onOpenThread\(agent\.id\)\}/,
    "the selected profile can open its team thread");
  assert.match(agentsView, /onOpenTerminal=\{\(\) => onOpenTerminal\(agent\.id\)\}/,
    "the selected profile can open its Work terminal");
  assert.match(commandCenter, /onOpenThread=\{openAgentThread\}/,
    "thread actions stay inside the generated shell");
  assert.match(commandCenter, /onOpenTerminal=\{openAgentTerminal\}/,
    "terminal actions stay inside the generated shell");
});

test("the Agents room is reachable from primary navigation (Rule 11)", () => {
  assert.match(navigation, /\{ key: "agents", label: "Agents", description: "onboard and control" \}/,
    "Agents is a named primary room");
  assert.match(navigation, /if \(room === "agents"\) return mode === "dev"/,
    "the room is reachable in the Dev mode where these engine controls apply");
});

test("empty and unreachable profile states carry a visible cause", () => {
  assert.match(agentsView, /Waiting for the box to report its development roster/,
    "an empty roster is explicit");
  assert.match(commandCenter, /profilesProblem=\{agentProfiles\.problem\}/,
    "profile transport failures reach the view");
  assert.match(agentsView, /controlsProblem=\{controlProblem \|\| profilesProblem \|\| settingsProblem\}/,
    "the profile failure participates in the visible degraded state");
  assert.match(agentsView, /Agent controls degraded:/,
    "the failed fetch cannot become a blank screen");
});
