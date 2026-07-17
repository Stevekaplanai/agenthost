// Leak-regression tests: every scenario the adversarial verify pass flagged as
// a real secret escaping the Hermes packer. Each must show REAL secret material
// is gone from the redacted output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactEnvFile, redactHermesConfigYaml } from "../scripts/pack-lib.mjs";

const rep = () => ({ redactedSecrets: [], mcp: [], flags: [] });
const noSecret = (out, needle) => assert.ok(!out.includes(needle), `LEAK: "${needle}" survived`);
// Fake Google-key prefix, split so secret scanners don't flag this test file
// itself (the runtime value is a normal Google-shaped string exercising the regex).
const AIZA = "AIza" + "Sy";

test(".env: CRLF file still redacts (Windows-authored .env)", () => {
  const r = rep();
  const { text } = redactEnvFile('TELEGRAM_BOT_TOKEN=771234:AA-real-secret\r\nFOO=bar\r\n', r);
  noSecret(text, "771234:AA-real-secret");
  noSecret(text, "bar");
  assert.equal(r.redactedSecrets.length, 2);
});

test(".env: multi-line quoted PEM value fully redacted", () => {
  const r = rep();
  const env = 'GCP_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvREALONE+/x\nMIIEvREALTWO+/y\n-----END PRIVATE KEY-----"\nNEXT=ok\n';
  const { text } = redactEnvFile(env, r);
  noSecret(text, "MIIEvREALONE");
  noSecret(text, "MIIEvREALTWO");
  noSecret(text, "BEGIN PRIVATE KEY");
  noSecret(text, "ok"); // NEXT value also redacted
  assert.ok(text.includes("GCP_KEY="));
});

test("config.yaml: multi-line block-scalar Authorization redacted (not just the indicator)", () => {
  const r = rep();
  const yaml = "headers:\n    Authorization: >-\n      Bearer REALTOKENVALUE123\n";
  const out = redactHermesConfigYaml(yaml, r);
  noSecret(out, "REALTOKENVALUE123");
  noSecret(out, "Bearer REAL");
});

test("config.yaml: vision api_key as block scalar redacted", () => {
  const r = rep();
  const yaml = "vision:\n  provider: gemini\n  api_key: >-\n    " + AIZA + "REALVISIONKEYvalue1234567890abcd\n";
  const out = redactHermesConfigYaml(yaml, r);
  noSecret(out, AIZA + "REALVISIONKEY");
});

test("config.yaml: colon-form secrets in env blocks + keyname fields redacted", () => {
  const r = rep();
  const yaml = [
    "mcp_servers:",
    "  notion:",
    "    env:",
    "      NOTION_TOKEN: ntn_REALNOTIONTOKENvalue1234567890abcdef",
    "      GENERIC_VAR: also-secret-by-block-rule",
    "llm:",
    "  api_key: " + AIZA + "TOPLEVELREALKEYvalue1234567890abc",
  ].join("\n");
  const out = redactHermesConfigYaml(yaml, r);
  noSecret(out, "ntn_REALNOTIONTOKEN");
  noSecret(out, "also-secret-by-block-rule"); // env-block leaf redacted regardless of name
  noSecret(out, AIZA + "TOPLEVELREALKEY");
});

test("config.yaml: GITHUB PAT survives no quoting variant", () => {
  for (const item of [
    "      - GITHUB_PERSONAL_ACCESS_TOKEN=ghp_REALbareTOKEN1234567890",
    '      - GITHUB_PERSONAL_ACCESS_TOKEN="ghp_REALquotedTOKEN1234"',
  ]) {
    const r = rep();
    const out = redactHermesConfigYaml("args:\n" + item + "\n", r);
    noSecret(out, "REALbareTOKEN");
    noSecret(out, "REALquotedTOKEN");
  }
});

test("config.yaml: leftover Gemini/OpenRouter keys caught by shape sweep", () => {
  const r = rep();
  const yaml = "weird_field: " + AIZA + "LOOSEKEYvalue1234567890abcdefghij\nother: sk-or-v1-realopenrouterkeyvalue123456\n";
  const out = redactHermesConfigYaml(yaml, r);
  noSecret(out, AIZA + "LOOSEKEY");
  noSecret(out, "sk-or-v1-realopenrouter");
});
