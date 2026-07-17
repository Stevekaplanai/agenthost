import https from "node:https";
import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";

// `agenthost doctor` -- a read-only health checklist for a deployed box. Every
// check is non-mutating (secret NAMES only, ssh read commands, an HTTP GET).
// The pure interpreters below are exported so the logic is unit-tested without
// a live Fly account.

const AUTH_SECRETS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

// True if Claude auth is configured (either the subscription token or an API key).
export function hasAuthSecret(names) {
  if (!Array.isArray(names)) return false;
  return AUTH_SECRETS.some((s) => names.includes(s));
}

// A responding gate returns 200 (already authed), 302 (?key redirect), or 401
// (login page) -- all mean "the box is up and serving". Anything else (or a
// network error, status 0) is a fail.
export function gateReachable(status) {
  return status === 200 || status === 301 || status === 302 || status === 401;
}

// Parse `df -h /data` (or df -P) output -> { avail, usePct } from the data row.
// Tolerates the header line and either -h ("1.2G") or plain sizes.
export function parseDiskFree(dfOutput) {
  const lines = String(dfOutput || "").trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (/^Filesystem\b/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // Filesystem Size Used Avail Use% Mounted-on  (Avail = col 3, Use% = col 4)
    const usePct = cols.find((c) => /^\d+%$/.test(c));
    if (!usePct) continue;
    const at = cols.indexOf(usePct);
    return { avail: cols[at - 1] || "?", usePct: parseInt(usePct, 10) };
  }
  return null;
}

// Disk is healthy under 90% used.
export function diskOk(disk) {
  return disk != null && Number.isFinite(disk.usePct) && disk.usePct < 90;
}

function httpStatus(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s) => { if (!done) { done = true; resolve(s); } };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        finish(res.statusCode || 0);
        res.destroy();
      });
      req.on("timeout", () => { req.destroy(); finish(0); });
      req.on("error", () => finish(0));
    } catch { finish(0); }
  });
}

const GREEN = "✓"; // ✓
const RED = "✗";   // ✗
function line(ok, label, detail) {
  const mark = ok ? GREEN : RED;
  return `  ${mark} ${label}${detail ? "  — " + detail : ""}`;
}

export async function doctorCommand(flags) {
  const app = resolveApp(flags);
  const url = `https://${app}.fly.dev`;
  console.log(`agenthost doctor — ${app}\n`);

  const results = [];

  // 1. Harness present on the volume.
  const lsHome = fly.sshConsoleOutput(app, "ls -a /data/home/agent/.claude 2>/dev/null");
  const harnessOk = /CLAUDE\.md|skills|settings\.json/.test(lsHome);
  results.push(line(harnessOk, "harness on the volume",
    harnessOk ? "~/.claude restored" : "not found under /data/home/agent/.claude"));

  // 2. Claude auth configured (secret NAMES only).
  const names = fly.secretNames(app);
  const authOk = hasAuthSecret(names);
  results.push(line(authOk, "Claude auth secret set",
    names == null ? "couldn't read secrets" : authOk ? AUTH_SECRETS.find((s) => names.includes(s)) : "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY"));

  // 3. ttyd password set (terminal login works).
  const pwOk = Array.isArray(names) && names.includes("TTYD_PASSWORD");
  results.push(line(pwOk, "terminal password set", pwOk ? "TTYD_PASSWORD" : "no TTYD_PASSWORD secret"));

  // 4. Gate reachable over HTTPS.
  const status = await httpStatus(url);
  const gateOk = gateReachable(status);
  results.push(line(gateOk, "gate reachable", gateOk ? `HTTP ${status}` : status ? `HTTP ${status}` : "no response"));

  // 5. Disk headroom on the data volume.
  const disk = parseDiskFree(fly.sshConsoleOutput(app, "df -h /data 2>/dev/null"));
  const dOk = diskOk(disk);
  results.push(line(dOk, "disk headroom", disk ? `${disk.usePct}% used, ${disk.avail} free` : "couldn't read df"));

  console.log(results.join("\n"));
  const allOk = harnessOk && authOk && gateOk && dOk;
  console.log(`\n${allOk ? GREEN + " all green" : RED + " some checks failed — see above"}`);
  console.log(`   ${url}`);
  return allOk ? 0 : 1;
}
