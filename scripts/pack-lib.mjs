// Pure helpers extracted from pack.mjs so they're independently testable
// (test/pack-lib.test.js) and reusable by the agenthost CLI. No I/O here --
// every function takes plain values in, returns plain values out.
// Behavior-preserving extraction: logic is unchanged from pack.mjs.

export const EXCLUDE_NAMES = new Set([
  ".credentials.json", "credentials.json", // never migrate auth material
  "node_modules", ".git", "__pycache__",
]);
// Cardinal invariant hardening (2026-07-12): exact-name matching let a
// ".credentials.json.bak-supabase" backup ride a real harness tarball onto a
// box. ANY filename containing "credential" is auth material until proven
// otherwise -- never migrate it, list it in the report. Over-matching is the
// safe direction here.
export const EXCLUDE_NAME_RE = /credential/i;
export const PROCESS_JSON = ["settings.json", "mcp.json"]; // plus every *.json in mcp-configs/
export const LOCALHOST_RE = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/i;
// Drive-letter paths only; the lookarounds keep URL schemes (https://) from matching.
export const WINPATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?!\/)/;
// WSL mounts of Windows drives (/mnt/c/...). Like WINPATH_RE these are flagged,
// never rewritten: there is no reliable Windows-user -> cloud-home mapping.
export const WSLPATH_RE = /\/mnt\/[a-z]\//;
// Either flavor of machine-specific path that will not resolve in the cloud:
export const STALE_PATH_RE = new RegExp(`${WINPATH_RE.source}|${WSLPATH_RE.source}`);
export const SECRET_KEYNAME_RE = /(api[-_]?key|token|secret|password|credential|authorization)/i;
// High-confidence secret shapes for the generic scan of non-config files:
export const SECRET_SHAPES = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-style-key", /\bsk-[A-Za-z0-9]{32,}/],
  ["openai-project-key", /\bsk-(?:proj|or|svcacct)-[A-Za-z0-9_-]{20,}/], // hyphens break the plain sk- shape
  ["github-pat", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["github-fine-grained-pat", /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["slack-token", /\bxox[bapr]-[A-Za-z0-9-]{10,}/],
  ["aws-access-key", /\bAKIA[A-Z0-9]{16}\b/],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{35}\b/],           // Gemini / Google
  ["telegram-bot-token", /\b\d{6,}:AA[A-Za-z0-9_-]{30,}/],
  ["notion-token", /\b(?:ntn|secret)_[A-Za-z0-9]{36,}/],
  ["elevenlabs-key", /\bsk_[a-f0-9]{40,}/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{15,}=*/], // gateway/JWT auth values
];
export const REDACTED = "<REDACTED_BY_AGENTHOST_REPROVIDE_VIA_FLY_SECRETS>";

// ---- Hermes (Manifest v2) ----------------------------------------------------
// Names never packed from ~/.hermes, ON TOP of the global EXCLUDE_NAMES:
// runtime state, caches, session material, lockfiles, process bookkeeping.
export const HERMES_EXCLUDE = new Set([
  "hermes-agent", "state.db", "state.db-shm", "state.db-wal", "lsp", "node",
  "cache", "sessions", "audio_cache", "image_cache", "images", "logs",
  "pastes", "state-snapshots", "sandboxes", "disk-cleanup",
  "gateway.pid", "gateway.lock", "processes.json", ".hermes_history",
]);

export function matchesHermesExclude(name) {
  return HERMES_EXCLUDE.has(name) || /\.bak-/.test(name) || name.endsWith(".lock");
}

const indentOf = (l) => l.length - l.trimStart().length;

// Redact a mapping value that may be a YAML block scalar or multi-line quoted
// string: replace the value in place and blank every continuation line that is
// more-indented than the key line, so no part of the real value survives.
// Mutates `lines`; returns nothing.
function redactYamlValueAt(lines, i, keyPrefix) {
  const keyIndent = indentOf(lines[i]);
  lines[i] = keyPrefix + REDACTED;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") { lines[j] = ""; continue; } // keep blank spacer
    if (indentOf(lines[j]) <= keyIndent) break;              // out of the value block
    lines[j] = "";
  }
}

// Redact secrets from Hermes config.yaml -- no YAML dependency (zero-dep
// invariant), but robust against the ways line-surgery leaks:
//   * multi-line block scalars / quoted values (redact the whole value block),
//   * env:/headers: mappings (redact EVERY leaf, like the JSON scrubber's
//     Rule 1 -- generic var names carry secrets too),
//   * any key matching SECRET_KEYNAME_RE (api_key/token/secret/password/
//     credential/authorization) anywhere -- covers vision.api_key, Bearer
//     Authorization, colon-form NOTION_TOKEN, etc.,
//   * GITHUB_PERSONAL_ACCESS_TOKEN=<value> inline in MCP args (any quoting),
//   * a final SECRET_SHAPES sweep for anything still slipping through.
export function redactHermesConfigYaml(text, report) {
  const lines = text.split(/\r?\n/);
  let secretBlockIndent = -1; // inside an env:/headers: mapping while >= 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = indentOf(line);

    if (secretBlockIndent >= 0 && indent <= secretBlockIndent) secretBlockIndent = -1;

    // Inline GITHUB PAT in an args list item -- redact through end of value,
    // including a quoted value (the quote must be inside the redacted span).
    if (line.includes("GITHUB_PERSONAL_ACCESS_TOKEN=")) {
      const next = line.replace(/(GITHUB_PERSONAL_ACCESS_TOKEN=)(?:"[^"]*"|'[^']*'|[^\]\s,'"]*)/g, `$1${REDACTED}`);
      if (next !== line) { lines[i] = next; report.redactedSecrets.push("config.yaml: GITHUB_PERSONAL_ACCESS_TOKEN (mcp args)"); }
    }

    const kv = lines[i].match(/^(\s*(?:-\s*)?([A-Za-z0-9_.-]+):\s*)(.*)$/);
    if (!kv) continue;
    const [, keyPrefix, keyName, value] = kv;

    // Entering an env:/headers: block with no inline value -> redact all leaves.
    if ((keyName === "env" || keyName === "headers") && startsMultilineYaml(value)) {
      secretBlockIndent = indent;
      continue;
    }

    const inSecretBlock = secretBlockIndent >= 0 && indent > secretBlockIndent;
    const keyIsSecret = SECRET_KEYNAME_RE.test(keyName);
    if (inSecretBlock || keyIsSecret) {
      if (value === "" || value === REDACTED) continue; // nothing on this line
      redactYamlValueAt(lines, i, keyPrefix);
      report.redactedSecrets.push(`config.yaml: ${keyName}${inSecretBlock ? " (env/headers block)" : ""}`);
    }
  }

  // Final net: any high-confidence secret shape the structural rules missed.
  let out = lines.join("\n");
  for (const [shapeName, re] of SECRET_SHAPES) {
    out = out.replace(new RegExp(re.source, "g"), () => {
      report.redactedSecrets.push(`config.yaml: secret shape (${shapeName})`);
      return REDACTED;
    });
  }
  return out;
}

// Inside mcp_servers:, any server block whose command: line contains a Windows
// or WSL-mount path (STALE_PATH_RE) gets its 'enabled: true' line rewritten to
// 'enabled: false' (inserted if the block has no enabled: line) + a DISABLED
// report.mcp entry. Portable servers (command npx / type http with remote url)
// get PORTABLE entries. Line surgery only -- everything else is untouched.
export function disableWindowsMcpBlocks(text, report) {
  const lines = text.split("\n");
  const indentOf = (l) => l.length - l.trimStart().length;
  const unquote = (s) => s.replace(/^(['"])(.*)\1$/, "$2");

  let msIdx = -1, msIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)mcp_servers:\s*$/);
    if (m) { msIdx = i; msIndent = m[1].length; break; }
  }
  if (msIdx < 0) return text;

  let end = lines.length;
  for (let i = msIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= msIndent) { end = i; break; }
  }

  // Segment the block into per-server sub-blocks (keys at the first child indent).
  let serverIndent = -1;
  const blocks = [];
  for (let i = msIdx + 1; i < end; i++) {
    if (lines[i].trim() === "") continue;
    const ind = indentOf(lines[i]);
    if (serverIndent < 0) serverIndent = ind;
    if (ind === serverIndent) {
      const key = lines[i].match(/^\s*([^\s:#][^:]*):\s*$/);
      if (key) {
        if (blocks.length) blocks[blocks.length - 1].end = i;
        blocks.push({ name: key[1].trim(), start: i, end });
      }
    }
  }

  const insertions = []; // [lineIndex, text] -- applied last so indices stay valid
  for (const b of blocks) {
    let command = "", url = "", type = "", commandLine = "", enabledIdx = -1, contentIndent = -1;
    for (let i = b.start + 1; i < b.end; i++) {
      const l = lines[i];
      if (l.trim() === "") continue;
      if (contentIndent < 0) contentIndent = indentOf(l);
      let m;
      if ((m = l.match(/^\s*command:\s*(.*)$/))) { command = unquote(m[1].trim()); commandLine = l; }
      else if ((m = l.match(/^\s*url:\s*(.*)$/))) url = unquote(m[1].trim());
      else if ((m = l.match(/^\s*type:\s*(.*)$/))) type = unquote(m[1].trim());
      else if (/^\s*enabled:\s*true\s*$/.test(l)) enabledIdx = i;
    }
    if (commandLine && STALE_PATH_RE.test(commandLine)) {
      if (enabledIdx >= 0) lines[enabledIdx] = lines[enabledIdx].replace(/enabled:\s*true/, "enabled: false");
      else insertions.push([b.start + 1, " ".repeat(contentIndent >= 0 ? contentIndent : serverIndent + 2) + "enabled: false"]);
      report.mcp.push({ source: "hermes config.yaml", name: b.name, verdict: "DISABLED: Windows path, unreachable from the cloud" });
    } else if (command.split(/\s+/)[0] === "npx") {
      report.mcp.push({ source: "hermes config.yaml", name: b.name, verdict: "PORTABLE (package-managed)" });
    } else if (type === "http" && url && !LOCALHOST_RE.test(url)) {
      report.mcp.push({ source: "hermes config.yaml", name: b.name, verdict: "PORTABLE (remote URL)" });
    }
  }
  for (const [idx, l] of insertions.sort((a, b) => b[0] - a[0])) lines.splice(idx, 0, l);
  return lines.join("\n");
}

// Replace EVERY non-comment KEY=value value in a Hermes .env with the REDACTED
// sentinel. Each key pushes a re-provide pointer (Fly secret HERMESENV_<KEY>)
// to report.redactedSecrets. Returns redacted text + key list so callers can
// stage secrets without printing values.
// Handles the ways real .env files leak past naive line-surgery: CRLF endings
// (Windows-authored files), and multi-line QUOTED values (PEM keys, JSON blobs)
// whose continuation lines would otherwise survive verbatim.
export function redactEnvFile(text, report) {
  const keys = [];
  const lines = text.split(/\r?\n/); // CRLF-safe; container wants LF anyway
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) { out.push(line); continue; }
    const [, prefix, key, rawValue] = m;
    keys.push(key);
    report.redactedSecrets.push(`hermes .env: ${key} (re-provide as Fly secret HERMESENV_${key})`);
    out.push(`${prefix}${key}=${REDACTED}`);
    // Multi-line quoted value: consume continuation lines up to the closing
    // quote so none of the real value survives.
    const q = rawValue.trim()[0];
    if ((q === '"' || q === "'") && !closesOnSameLine(rawValue.trim(), q)) {
      while (i + 1 < lines.length) {
        i++;
        if (lines[i].includes(q)) break; // the line bearing the closing quote (dropped too)
      }
    }
  }
  return { text: out.join("\n"), keys };
}

// True if a quoted scalar opened with `q` also closes on the same string.
function closesOnSameLine(s, q) {
  return s.length > 1 && s.indexOf(q, 1) !== -1;
}

// YAML block-scalar / unclosed-quote detector: does this value (text after the
// "key:") start a value that continues onto more-indented following lines?
function startsMultilineYaml(value) {
  const v = value.trim();
  if (v === "" || v[0] === "#") return true;            // empty or comment-only: value is below
  if (/^[|>][+-]?\d*\s*(#.*)?$/.test(v)) return true;    // block scalar: | > |- >- |2 etc.
  const q = v[0];
  if ((q === '"' || q === "'") && !closesOnSameLine(v, q)) return true; // unclosed quote
  return false;
}

export function translateValue(v, homeVariants, cloudHome, stats) {
  let hit = false;
  for (const variant of homeVariants) {
    if (v.includes(variant)) { v = v.split(variant).join(cloudHome); hit = true; }
  }
  if (hit) {
    v = v.replace(/\\/g, "/"); // this value is a path; normalize separators
    stats.translated += 1;
  } else if (STALE_PATH_RE.test(v)) {
    stats.nonHome.push(v.length > 120 ? v.slice(0, 120) + "..." : v);
  }
  return v;
}

// report is mutated (redactedSecrets) to match pack.mjs's existing call shape.
export function scrubAndTranslate(node, label, jsonPath, stats, homeVariants, cloudHome, report) {
  if (Array.isArray(node)) {
    return node.map((v, i) => scrubAndTranslate(v, label, `${jsonPath}[${i}]`, stats, homeVariants, cloudHome, report));
  }
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const p = jsonPath ? `${jsonPath}.${k}` : k;
      // Rule 1: env/header blocks are secret carriers by convention. Redact all leaves.
      if ((k === "env" || k === "headers") && v !== null && typeof v === "object" && !Array.isArray(v)) {
        const redacted = {};
        for (const [ek, ev] of Object.entries(v)) {
          if (typeof ev === "string" && ev.length > 0) {
            redacted[ek] = REDACTED;
            report.redactedSecrets.push(`${label}: ${p}.${ek}`);
          } else {
            redacted[ek] = ev;
          }
        }
        out[k] = redacted;
        continue;
      }
      // Rule 2: key-shaped field names with substantial string values.
      if (typeof v === "string" && SECRET_KEYNAME_RE.test(k) && v.length >= 12) {
        out[k] = REDACTED;
        report.redactedSecrets.push(`${label}: ${p}`);
        continue;
      }
      out[k] = scrubAndTranslate(v, label, p, stats, homeVariants, cloudHome, report);
    }
    return out;
  }
  if (typeof node === "string") {
    // Rule 3: high-confidence secret shapes anywhere in config strings.
    for (const [shapeName, re] of SECRET_SHAPES) {
      if (re.test(node)) {
        report.redactedSecrets.push(`${label}: ${jsonPath} (${shapeName})`);
        return REDACTED;
      }
    }
    return translateValue(node, homeVariants, cloudHome, stats);
  }
  return node;
}

export function classifyMcpServer(cfg) {
  const url = cfg.url ?? "";
  const command = cfg.command ?? "";
  if (LOCALHOST_RE.test(url)) return "DISABLED: points at localhost, unreachable from the cloud";
  if (WINPATH_RE.test(command)) return "FLAGGED: absolute Windows command path";
  if (url) return "PORTABLE (remote URL)";
  if (["npx", "uvx", "node", "python", "python3"].includes(command)) return "PORTABLE (package-managed)";
  if (command) return `REVIEW: command '${command}'`;
  return "PORTABLE";
}

// Collect every cloud-home path referenced by hook command strings. Walks the
// hooks object generically (any event key, nested matcher/hooks arrays) so new
// hook event types don't need code changes here.
export function extractCloudHomePaths(hooksObj, cloudHome) {
  const found = new Set();
  const re = new RegExp(`${cloudHome.replace(/\//g, "\\/")}\\/[^\\s"']+`, "g");
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node !== null && typeof node === "object") return Object.values(node).forEach(walk);
    if (typeof node === "string") {
      for (const m of node.match(re) || []) found.add(m);
    }
  };
  walk(hooksObj || {});
  return [...found];
}

// ---- hook portability ---------------------------------------------------------
// Launch-night incident (2026-07-10): Windows settings.json hooks -- C:/Program
// Files node paths, %APPDATA% expansions, scripts that were never migrated --
// re-delivered on every sync and can never run on the Linux box, flooding every
// agent turn with Stop-hook errors. Same class of problem as localhost-only MCP
// servers (which get enabled:false in the cloud copy); unportable hooks get
// REMOVED from the CLOUD copy of settings.json. The user's local file is never
// touched.

// Windows %VAR% env syntax -- never expands on Linux. Name must be 2+ chars so
// strftime tokens in portable hooks ("date +%H%M%S") don't false-positive.
export const WINDOWS_ENV_RE = /%[A-Za-z_][A-Za-z0-9_()]+%/;
// powershell/pwsh as a command token: bare, pathed, or .exe-suffixed -- but not
// a substring of a longer word ("my-pwsh-tool" stays portable).
export const POWERSHELL_RE = /(?:^|[\s"'\\/;&|=])(?:powershell|pwsh)(?:\.exe)?(?=$|[\s"'])/i;

// 2026-07-13 incident: "edgee statusline claude doctor --warn-only" re-clobbered
// the box on every sync. It isn't a Windows path, PowerShell, or a %VAR% -- it's
// an ordinary-looking command that simply isn't installed on the box, so none of
// the regexes above catch it. We can't ask the box (packing runs on the user's
// machine), so we check the command's leading binary against what
// container/Dockerfile actually installs. Keep this list in sync with that file
// (apt-get installs + node:22-bookworm-slim's coreutils/bash).
const PORTABLE_BINARIES = new Set([
  // shell + control flow
  "sh", "bash", "env", "true", "false", "test", "[", "exec", "eval", "source", ".",
  // coreutils / base Debian image
  "echo", "printf", "cat", "grep", "egrep", "fgrep", "sed", "awk", "cut", "head",
  "tail", "wc", "tr", "xargs", "find", "mkdir", "rm", "cp", "mv", "ls", "pwd",
  "dirname", "basename", "date", "sleep", "touch", "ln", "diff", "sort", "uniq",
  "uname", "hostname", "id", "whoami", "du", "df", "chmod", "chown", "tar",
  "gzip", "gunzip", "zcat", "base64", "mktemp", "which", "type", "command", "seq",
  "readlink", "realpath", "tee", "yes", "nohup", "timeout", "kill",
  // container/Dockerfile apt-get installs
  "git", "tmux", "curl", "jq", "ssh", "scp", "sftp", "ssh-agent", "ssh-add",
  "python3", "python", "pip", "pip3", "rg", "gh", "ttyd",
  "ps", "top", "pkill", "pgrep", "free", "uptime", "flock", "setsid", "setpriv", "logger", "watch",
  // node toolchain (npm install -g @anthropic-ai/claude-code)
  "node", "npm", "npx", "claude",
]);

// The command's leading binary token, quote-stripped, skipping a single
// VAR=value env-assignment prefix if present ("FOO=bar mytool" -> "mytool").
function firstCommandToken(command) {
  const m = command.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)/);
  return m ? m[1].replace(/^["']|["']$/g, "") : "";
}

// Classify one hook command string for the cloud box. Returns null when
// portable, else { reason, missingRel? }:
//   reason     -- human text for the compat report;
//   missingRel -- home-relative path of the unmigrated target (missing-target
//                 verdicts only) so the caller can build the --include fix.
// existsInStaging(rel) answers "will this home-relative path exist on the box
// after this pack?" -- injected as a callback so this module stays I/O-free.
export function classifyHookCommand(command, cloudHome, existsInStaging) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (WINPATH_RE.test(command)) return { reason: "references a Windows drive-letter path" };
  if (WSLPATH_RE.test(command)) return { reason: "references a WSL /mnt/<drive> mount" };
  if (POWERSHELL_RE.test(command)) return { reason: "invokes PowerShell (powershell/pwsh), which is not on the box" };
  if (WINDOWS_ENV_RE.test(command)) return { reason: "uses Windows %VAR% environment syntax, which never expands on Linux" };
  // Bare binary not on the box: a name with no path separator that isn't in the
  // portable set can't be verified to exist on the container, so it's dropped
  // rather than shipped as a guaranteed "not found" on every session start.
  const bin = firstCommandToken(command);
  if (bin && !bin.includes("/") && !PORTABLE_BINARIES.has(bin)) {
    return { reason: `invokes \`${bin}\`, which is not installed on the box` };
  }
  // Missing target: the same rule hook-gap detection has always applied --
  // cloud-home paths outside .claude/ must exist in the staged tree after
  // path translation (.claude/ itself is migrated wholesale).
  for (const cloudPath of extractCloudHomePaths(command, cloudHome)) {
    const rel = cloudPath.slice(cloudHome.length + 1);
    if (rel.startsWith(".claude/")) continue;
    if (!existsInStaging(rel)) {
      return { reason: `references ${cloudPath}, which is not being migrated`, missingRel: rel };
    }
  }
  return null;
}

// Walk a settings.json `hooks` object ({ Event: [{ matcher?, hooks: [{ type,
// command }] }] }) and return { hooks, removed }: a COPY with every unportable
// command hook removed, plus the removal record ({ event, matcher, command,
// reason, missingRel? } each). The input is never mutated -- callers write the
// returned copy to the STAGED settings.json only. Matcher groups left with zero
// hooks (and events left with zero groups) are dropped so the cloud file
// carries no dead scaffolding; shapes this walker doesn't recognize pass
// through untouched.
export function pruneUnportableHooks(hooksObj, cloudHome, existsInStaging) {
  const removed = [];
  if (hooksObj === null || typeof hooksObj !== "object" || Array.isArray(hooksObj)) {
    return { hooks: hooksObj, removed };
  }
  const out = {};
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const keptGroups = [];
    for (const group of groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = [];
      for (const hook of group.hooks) {
        const command = hook !== null && typeof hook === "object" ? hook.command : undefined;
        const verdict = classifyHookCommand(command, cloudHome, existsInStaging);
        if (verdict) removed.push({ event, matcher: group.matcher, command, ...verdict });
        else keptHooks.push(hook);
      }
      // Drop a group only if WE emptied it; a group that was already empty
      // locally is the user's business and ships as-is.
      if (keptHooks.length > 0 || group.hooks.length === 0) keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length > 0 || groups.length === 0) out[event] = keptGroups;
  }
  return { hooks: out, removed };
}

export function scanMcpConfig(label, obj, report) {
  const servers = obj?.mcpServers ?? obj ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (typeof cfg !== "object" || cfg === null) continue;
    report.mcp.push({ source: label, name, verdict: classifyMcpServer(cfg) });
  }
}
