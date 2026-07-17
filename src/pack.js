// Wraps scripts/pack.mjs as a subprocess rather than importing its internals.
// pack.mjs is the validated reference implementation (rerun against Steve's
// real harness: 2,248 files, 12 secrets redacted) -- the CLI shells out to it
// unchanged so a refactor here can never silently drift its redaction behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACK_SCRIPT = path.join(__dirname, "..", "scripts", "pack.mjs");

export function packHarness({ outDir, dryRun = false, include = [], agent, withWhatsapp = false, withKanban = false, hermesOnly = false, packs = [] } = {}) {
  const args = [PACK_SCRIPT, "--out", outDir];
  if (dryRun) args.push("--dry-run");
  for (const inc of include) args.push("--include", inc);
  if (agent) args.push("--agent", agent);
  if (withWhatsapp) args.push("--with-whatsapp");
  if (withKanban) args.push("--with-kanban");
  if (hermesOnly) args.push("--hermes-only");
  for (const p of packs) args.push("--pack", p);
  try {
    execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    throw new Error(`pack failed:\n${out || e.message}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  const compatReport = fs.readFileSync(path.join(outDir, "compat-report.md"), "utf8");
  return { manifest, compatReport };
}
