// Wraps scripts/pack.mjs as a subprocess rather than importing its internals.
// pack.mjs is the reference implementation. The CLI shells out to the same
// script the security regression suite exercises, then verifies the audited
// archive hash before returning it to deploy/sync.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sha256File } from "./file-hash.js";
import { minimalChildEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PACK_SCRIPT = path.join(__dirname, "..", "scripts", "pack.mjs");
const require = createRequire(import.meta.url);
const modeValidate = require("../container/mode-validate.js");

// A mode pack is executable configuration, not just a bundle of skills. Sync
// and deploy can replace a pack while that mode is already active, so the full
// source contract has to pass before either command creates an archive. Ordinary
// skills-only packs keep their existing packer path.
export function validateRequestedModePacks(requested, {
  repoRoot = REPO_ROOT,
  harnessDir = path.join(os.homedir(), ".claude"),
  taxonomyFile = process.env.AGENTHOST_CHANNEL_TAXONOMY || undefined,
} = {}) {
  const checked = [];
  for (const rawName of requested || []) {
    const name = String(rawName);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
    const packDir = path.join(repoRoot, "packs", name);
    let isDirectory = false;
    try { isDirectory = fs.statSync(packDir).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) continue;
    const isModePack = ["pack.json", "mode.toml", "coverage.json", "agents"]
      .some((entry) => fs.existsSync(path.join(packDir, entry)));
    if (!isModePack) continue;
    const result = modeValidate.validatePack(packDir, { harnessDir, taxonomyFile });
    if (!result.ok) {
      throw new Error(
        `pack failed: mode pack '${name}' does not satisfy its safety contract, so it was NOT shipped.\n` +
        result.errors.map((error) => `  ${error}`).join("\n")
      );
    }
    checked.push(name);
  }
  return checked;
}

export function packFailureMessage(outDir, error) {
  const output = (error.stdout || "") + (error.stderr || "");
  let preservedFindings = "";
  try {
    const failureManifest = JSON.parse(
      fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    );
    const findings = [...new Set(failureManifest.possibleSecrets || [])];
    if (findings.length) {
      preservedFindings = [
        "",
        "Security findings (paths preserved because the temporary report may be cleaned up):",
        ...findings.map((finding) => `- ${finding}`),
      ].join("\n");
    }
  } catch {
    // A failure before manifest creation is already explained by stderr.
  }
  return `pack failed:\n${output || error.message}${preservedFindings}`;
}

// The packer's own pack complaints, out of the flag pile it shares with
// everything else. Every one it writes is prefixed with the pack it is about:
// `--pack '<name>': ...` for the ones raised while loading, `pack '<name>': ...`
// for the ones raised after.
export function packFlags(manifest) {
  return (manifest?.flags || []).filter((f) => /^(--)?pack '/.test(String(f)));
}

// Packs the operator asked for that produced no entry in the manifest at all --
// nothing staged, nothing to ship, no line in the "Preloaded pack" summary that
// would have told them.
export function missingPacks(requested, manifest) {
  const loaded = new Set((manifest?.packs || []).map((p) => p.name));
  return (requested || []).filter((name) => !loaded.has(name));
}

export function packHarness({
  outDir, dryRun = false, include = [], agent, withKanban = false,
  hermesOnly = false, noHermes = false, noCodex = false, noOpenclaw = false,
  packs = [],
} = {}) {
  validateRequestedModePacks(packs);
  const args = [PACK_SCRIPT, "--out", outDir];
  if (dryRun) args.push("--dry-run");
  for (const inc of include) args.push("--include", inc);
  if (agent) args.push("--agent", agent);
  if (withKanban) args.push("--with-kanban");
  if (hermesOnly) args.push("--hermes-only");
  if (noHermes) args.push("--no-hermes");
  if (noCodex) args.push("--no-codex");
  if (noOpenclaw) args.push("--no-openclaw");
  for (const p of packs) args.push("--pack", p);
  try {
    execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalChildEnv({ includeHarnessHomes: true }),
    });
  } catch (e) {
    throw new Error(packFailureMessage(outDir, e));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  // Every --pack problem the packer reported, said out loud. pack.mjs writes
  // these into manifest.flags and exits 0 -- a missing packs/<name>, a typo, a
  // name it refused, or content the security audit dropped -- and this CLI runs
  // it with piped stdio that is only surfaced on a NONZERO exit. So an operator
  // asking for a department that isn't there used to see "Packed N files ...
  // Synced." and nothing else, then a green `agenthost mode growth` on a box
  // with no hats, no MODE.md and no charter (the local pack validates; the box
  // is never asked). Printed for real runs and dry runs alike.
  const packProblems = packFlags(manifest);
  if (packProblems.length) {
    console.log(`*** ${packProblems.length} pack problem(s):`);
    for (const flag of packProblems) console.log(`***   ${flag}`);
  }
  // A pack that produced NOTHING is not a warning: the operator named it on the
  // command line and it did not ship. Failing here is what keeps "Synced." from
  // meaning "the department shipped" when it didn't.
  const missing = missingPacks(packs, manifest);
  if (missing.length) {
    throw new Error(
      `pack failed: --pack ${missing.join(", ")} produced nothing, so the harness was NOT shipped.\n` +
      packProblems.map((f) => `  ${f}`).join("\n")
    );
  }
  if (manifest.securityOmissions?.length) {
    console.log(
      `*** ${manifest.securityOmissions.length} local file(s) were intentionally left behind for security:`
    );
    for (const omission of manifest.securityOmissions) {
      console.log(`***   ${omission.path}: ${omission.reason}`);
    }
  }
  if (manifest.tarball) {
    const actual = sha256File(manifest.tarball);
    if (!manifest.archiveSha256 || actual !== manifest.archiveSha256) {
      throw new Error("pack failed: harness.tar.gz no longer matches its post-audit SHA-256");
    }
  }
  const compatReport = fs.readFileSync(path.join(outDir, "compat-report.md"), "utf8");
  return { manifest, compatReport };
}
