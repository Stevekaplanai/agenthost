import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fly from "../fly.js";
import { packHarness } from "../pack.js";
import { appOrigin, saveAppState, loadOriginState } from "../state.js";
import { detectHarness, randomPassword } from "../util.js";
import { stageDeployFiles, cleanupDeployFiles } from "../deploy-container.js";
import { detectAgents, describeAgent } from "../detect.js";
import { buildEnvSecrets } from "../env-secrets.js";
import { enforceLegalMode } from "../legal-mode.js";

const CONTAINER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "container");

export async function deployCommand(flags) {
  const app = flags.app || `agenthost-${os.userInfo().username}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const existing = loadOriginState(app);
  const url = appOrigin(app, existing);
  const runtimeEnv = existing?.origin
    ? { AGENTHOST_CANONICAL_HOST: new URL(url).hostname }
    : {};
  const org = flags.org || existing?.org;
  const region = flags.region || existing?.region || "iad";
  const repos = (flags.repos || "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = Boolean(flags["dry-run"]);

  if (!org) throw new Error("--org is required the first time you deploy an app (your Fly org slug: `flyctl orgs list`)");

  // Legal Mode gates BEFORE any expensive work: --legal implies the legal skill
  // pack and (on a subscription token) the training-opt-out attestation.
  const legalSecrets = await enforceLegalMode(flags);
  const packs = [...(flags.pack || []), ...(flags.legal && !(flags.pack || []).includes("legal") ? ["legal"] : [])];

  detectHarness();
  for (const line of detectAgents().map(describeAgent).filter(Boolean)) console.log(line);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-"));
  try {
  console.log("Packing harness...");
  const { manifest } = packHarness({
    outDir,
    dryRun,
    include: flags.include || [],
    agent: flags.agent,
    withKanban: Boolean(flags["with-kanban"]),
    noHermes: Boolean(flags["no-hermes"]),
    noCodex: Boolean(flags["no-codex"]),
    noOpenclaw: Boolean(flags["no-openclaw"]),
    packs,
  });
  console.log(`Packed ${manifest.files} files (${(manifest.bytes / 1024 / 1024).toFixed(1)} MB). Secrets redacted: ${manifest.redactedSecrets.length}.`);
  if (manifest.flags.some((flag) => /Hermes config\.yaml not migrated/i.test(flag))) {
    console.log("*** Hermes setup required: open the box terminal and create /data/home/agent/.hermes/config.yaml there.");
    console.log("*** AgentHost intentionally never reads or copies the local config because it can contain credentials.");
    console.log(`*** After creating it, run \`agenthost restart --app ${app}\` so Hermes starts with that config.`);
  }
  if (manifest.flags.some((flag) => /Hermes \.env not migrated/i.test(flag))) {
    console.log(`*** Hermes secrets required: add each HERMESENV_<KEY> in the Fly dashboard for '${app}' (Secrets).`);
    console.log("*** AgentHost intentionally never reads the local Hermes .env file.");
  }
  for (const p of manifest.packs || []) {
    const parts = [`${p.skills.length} skill(s) (${p.skills.join(", ") || "none"})`];
    if (p.agents?.length) parts.push(`${p.agents.length} agent(s) (${p.agents.join(", ")})`);
    if (p.modeFiles?.length) parts.push(`mode files: ${p.modeFiles.join(", ")}`);
    console.log(`Preloaded pack '${p.name}': ${parts.join(", ")}.`);
  }
  const disabled = manifest.mcp.filter((m) => m.verdict.startsWith("DISABLED")).length;
  if (disabled) console.log(`${disabled} MCP server(s) disabled (localhost-only, unreachable from the cloud).`);
  if (manifest.hookGaps?.length) {
    console.log(`\n*** ${manifest.hookGaps.length} hook(s) reference paths that will NOT exist on the box:`);
    for (const h of manifest.hookGaps) console.log(`***   ${h}`);
  }
  let ttydPassword = existing?.ttydPassword;
  if (!ttydPassword) {
    ttydPassword = randomPassword();
    console.log(`\nTerminal login (save this now): agent / ${ttydPassword}`);
  }

  const envSecrets = buildEnvSecrets(repos, flags.env || []);
  const secrets = {
    TTYD_PASSWORD: ttydPassword,
    CLAUDE_CODE_OAUTH_TOKEN: flags["oauth-token"],
    ANTHROPIC_API_KEY: flags["oauth-token"] ? undefined : flags["anthropic-key"],
    GITHUB_TOKEN: flags["github-token"],
    REPOS: repos.length ? repos.join(",") : undefined,
    ...envSecrets,
    ...legalSecrets,
  };

  if (dryRun) {
    console.log(`\n[dry-run] would create/reuse app '${app}' in org '${org}' (${region})`);
    console.log(`[dry-run] would create/reuse volume 'data' (3GB, ${region})`);
    console.log("[dry-run] would inspect Fly and, only if found, remove the retired credential-file secret and stage its one-time volume purge");
    console.log(`[dry-run] would stage secrets: ${Object.keys(secrets).filter((k) => secrets[k] !== undefined).join(", ")}`);
    console.log(`[dry-run] would run: flyctl deploy -a ${app} -c container/fly.toml.deploy --remote-only`);
    console.log("[dry-run] no changes made to Fly.io");
    return { app, dryRun: true, manifest };
  }

  console.log(`\n== 1/5 app '${app}' (org ${org}) ==`);
  fly.createApp(app, org);

  console.log("== 2/5 volume 'data' ==");
  if (!fly.volumeExists(app)) fly.createVolume(app, region);
  else console.log("volume 'data' already exists, continuing");

  console.log("== 3/5 secrets (staged; apply on deploy) ==");
  const legacyCredentialCleanup = fly.retiredCredentialSecretExists(app);
  if (legacyCredentialCleanup) {
    secrets.AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS = "1";
  }
  await fly.stageSecrets(app, secrets);
  if (legacyCredentialCleanup) fly.removeRetiredCredentialSecret(app);
  if (!secrets.CLAUDE_CODE_OAUTH_TOKEN && !secrets.ANTHROPIC_API_KEY) {
    console.log("note: no Claude auth passed; container boots a shell. Activate later with:");
    console.log(`  agenthost deploy --app ${app} --oauth-token-env`);
    console.log("  (the CLI prompts with input hidden, or reads AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN)");
  }

  console.log("== 4/5 deploy (remote build; harness rides along as an image layer) ==");
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

  console.log("== 5/5 verify the harness landed ==");
  // -a: start.sh deletes the tarball once extracted, so on a fast boot the
  // proof it landed is the dotfile marker, not the tarball itself.
  const listing = fly.sshConsoleOutput(app, "ls -la /data/ /data/home/agent/");
  console.log(listing);
  if (staged.harnessAttached && !listing.includes("harness.tar.gz") && !listing.includes(".harness-extracted")) {
    console.log("WARNING: harness not visible on the volume (no tarball, no .harness-extracted marker); check `flyctl logs -a " + app + "`");
  }

  saveAppState(app, { org, region, ttydPassword, repos });

  console.log(`\nURL:   ${url}`);
  console.log(`Open:  ${url}  (enter the access key above; credentials never enter the URL)`);
  return { app, url, manifest };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
