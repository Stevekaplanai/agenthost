import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fly from "../fly.js";
import { appOrigin, loadOriginState } from "../state.js";
import { packHarness } from "../pack.js";
import { detectHarness } from "../util.js";
import { stageDeployFiles, cleanupDeployFiles } from "../deploy-container.js";
import { resolveApp } from "./resolve-app.js";
import { enforceLegalMode } from "../legal-mode.js";

const CONTAINER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "container");

// Re-packs the harness and redeploys just that layer -- for the day-to-day
// "push my updated skills/CLAUDE.md/memory to the cloud box" loop, without
// touching the app, volume, or secrets that deploy already set up.
export async function syncCommand(flags) {
  const app = resolveApp(flags);
  const state = loadOriginState(app);
  const origin = appOrigin(app, state);
  const runtimeEnv = state?.origin
    ? { AGENTHOST_CANONICAL_HOST: new URL(origin).hostname }
    : {};
  const dryRun = Boolean(flags["dry-run"]);

  // Legal Mode on sync: same gate as deploy (--legal implies the legal pack;
  // subscription tokens are attested via the sync'd account's existing auth,
  // so only the checklist + LEGAL_MODE marker apply here).
  const legalSecrets = await enforceLegalMode(flags);
  const packs = [...(flags.pack || []), ...(flags.legal && !(flags.pack || []).includes("legal") ? ["legal"] : [])];

  // --hermes-only packs only ~/.hermes (or $HERMES_HOME); the ~/.claude harness
  // is irrelevant, so skip the Claude-harness precondition. pack.mjs validates
  // the Hermes home itself.
  if (!flags["hermes-only"]) detectHarness();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-"));
  try {
  console.log("Packing harness...");
  const { manifest } = packHarness({
    outDir,
    dryRun,
    include: flags.include || [],
    agent: flags.agent,
    withKanban: Boolean(flags["with-kanban"]),
    hermesOnly: Boolean(flags["hermes-only"]),
    noHermes: Boolean(flags["no-hermes"]),
    noCodex: Boolean(flags["no-codex"]),
    noOpenclaw: Boolean(flags["no-openclaw"]),
    packs,
  });
  if (manifest.hookGaps?.length) {
    console.log(`*** ${manifest.hookGaps.length} hook(s) reference paths not being migrated:`);
    for (const gap of manifest.hookGaps) console.log(`***   ${gap}`);
  }
  console.log(`Packed ${manifest.files} files (${(manifest.bytes / 1024 / 1024).toFixed(1)} MB). Secrets redacted: ${manifest.redactedSecrets.length}.`);
  // sync is how a mode pack reaches a box that already exists, so it owes the
  // operator the same confirmation deploy prints: which hats and mode files
  // actually shipped. Without it the CLI never names the pack at all.
  for (const p of manifest.packs || []) {
    const parts = [`${p.skills.length} skill(s) (${p.skills.join(", ") || "none"})`];
    if (p.agents?.length) parts.push(`${p.agents.length} agent(s) (${p.agents.join(", ")})`);
    if (p.modeFiles?.length) parts.push(`mode files: ${p.modeFiles.join(", ")}`);
    console.log(`Preloaded pack '${p.name}': ${parts.join(", ")}.`);
  }
  if (manifest.flags.some((flag) => /Hermes config\.yaml not migrated/i.test(flag))) {
    console.log("*** Local Hermes config was intentionally not included; any existing box-local config is preserved.");
    console.log("*** On first setup only, create /data/home/agent/.hermes/config.yaml from the box terminal.");
    console.log(`*** Then run \`agenthost restart --app ${app}\` so Hermes starts with that config.`);
  }
  if (manifest.flags.some((flag) => /Hermes \.env not migrated/i.test(flag))) {
    console.log("*** Local Hermes .env was intentionally not included; existing Fly secrets are preserved.");
    console.log(`*** Add any missing HERMESENV_<KEY> in the Fly dashboard for '${app}' (Secrets).`);
  }

  const syncSecrets = {};
  // --github-token-env: set the GitHub PAT the box uses for git AND the github MCP
  // (start.sh maps it to GITHUB_PERSONAL_ACCESS_TOKEN). Laptop -> Fly secret,
  // never in the tarball; the low-friction way to fix a "github MCP not
  // authenticated" box without a full deploy.
  if (flags["github-token"]) syncSecrets.GITHUB_TOKEN = flags["github-token"];
  Object.assign(syncSecrets, legalSecrets);

  if (dryRun) {
    console.log(`[dry-run] would redeploy '${app}' with the freshly packed harness`);
    console.log("[dry-run] would inspect Fly and, only if found, remove the retired credential-file secret and stage its one-time volume purge");
    if (flags["github-token"]) console.log("[dry-run] would stage GITHUB_TOKEN (used for git + the github MCP)");
    if (flags.legal) console.log("[dry-run] would stage LEGAL_MODE and preload the legal skill pack");
    return { app, dryRun: true };
  }

  const legacyCredentialCleanup = fly.retiredCredentialSecretExists(app);
  if (legacyCredentialCleanup) {
    syncSecrets.AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS = "1";
  }
  if (Object.keys(syncSecrets).length) {
    if (flags["github-token"]) console.log("Staging GITHUB_TOKEN (git + github MCP) as a Fly secret.");
    await fly.stageSecrets(app, syncSecrets);
  }
  if (legacyCredentialCleanup) fly.removeRetiredCredentialSecret(app);

  const staged = stageDeployFiles({
    containerDir: CONTAINER_DIR,
    app,
    harnessTarball: manifest.tarball,
    harnessSha256: manifest.archiveSha256,
  });
  try {
    const code = await fly.deploy(app, staged.flyTomlDeploy, runtimeEnv);
    if (code !== 0) throw new Error(`flyctl deploy exited ${code}`);
  } finally {
    cleanupDeployFiles(staged);
  }
  console.log(`Synced. ${origin}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
