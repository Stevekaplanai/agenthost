import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fly from "../fly.js";
import { packHarness } from "../pack.js";
import { detectHarness } from "../util.js";
import { stageDeployFiles, cleanupDeployFiles } from "../deploy-container.js";
import { resolveApp } from "./resolve-app.js";
import { readLocalCredentials } from "./deploy.js";
import { enforceLegalMode } from "../legal-mode.js";

const CONTAINER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "container");

// Re-packs the harness and redeploys just that layer -- for the day-to-day
// "push my updated skills/CLAUDE.md/memory to the cloud box" loop, without
// touching the app, volume, or secrets that deploy already set up.
export async function syncCommand(flags) {
  const app = resolveApp(flags);
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
  console.log("Packing harness...");
  const { manifest } = packHarness({
    outDir,
    dryRun,
    include: flags.include || [],
    agent: flags.agent,
    withWhatsapp: Boolean(flags["with-whatsapp"]),
    withKanban: Boolean(flags["with-kanban"]),
    hermesOnly: Boolean(flags["hermes-only"]),
    packs,
  });
  if (manifest.hookGaps?.length) {
    console.log(`*** ${manifest.hookGaps.length} hook(s) reference paths not being migrated -- see compat-report.md`);
  }
  console.log(`Packed ${manifest.files} files (${(manifest.bytes / 1024 / 1024).toFixed(1)} MB). Secrets redacted: ${manifest.redactedSecrets.length}.`);

  // --migrate-auth: carry ~/.claude/.credentials.json (MCP OAuth tokens + agent
  // auth) up as the CLAUDE_CREDENTIALS Fly secret -- laptop -> Fly encrypted
  // store directly, never in the tarball. Unlike deploy, sync leaves every other
  // secret (password, tokens) untouched, so it's the low-friction path to add auth.
  const authSecrets = flags["migrate-auth"] ? readLocalCredentials() : {};
  // --github-token: set the GitHub PAT the box uses for git AND the github MCP
  // (start.sh maps it to GITHUB_PERSONAL_ACCESS_TOKEN). Laptop -> Fly secret,
  // never in the tarball; the low-friction way to fix a "github MCP not
  // authenticated" box without a full deploy.
  if (flags["github-token"]) authSecrets.GITHUB_TOKEN = flags["github-token"];
  Object.assign(authSecrets, legalSecrets);

  if (dryRun) {
    console.log(`[dry-run] would redeploy '${app}' with the freshly packed harness`);
    if (flags["migrate-auth"]) console.log("[dry-run] would stage CLAUDE_CREDENTIALS (from ~/.claude/.credentials.json)");
    if (flags["github-token"]) console.log("[dry-run] would stage GITHUB_TOKEN (used for git + the github MCP)");
    if (flags.legal) console.log("[dry-run] would stage LEGAL_MODE and preload the legal skill pack");
    return { app, dryRun: true };
  }

  if (Object.keys(authSecrets).length) {
    if (flags["migrate-auth"]) console.log("Staging ~/.claude/.credentials.json (MCP OAuth tokens + agent auth) as the CLAUDE_CREDENTIALS Fly secret. Some host-bound tokens may still need re-auth on the box.");
    if (flags["github-token"]) console.log("Staging GITHUB_TOKEN (git + github MCP) as a Fly secret.");
    await fly.stageSecrets(app, authSecrets);
  }

  const staged = stageDeployFiles({ containerDir: CONTAINER_DIR, app, harnessTarball: manifest.tarball });
  try {
    const code = await fly.deploy(app, staged.flyTomlDeploy);
    if (code !== 0) throw new Error(`flyctl deploy exited ${code}`);
  } finally {
    cleanupDeployFiles(staged);
  }
  console.log(`Synced. https://${app}.fly.dev`);
}
