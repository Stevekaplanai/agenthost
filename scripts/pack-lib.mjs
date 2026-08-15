// Pure helpers extracted from pack.mjs so they're independently testable
// (test/pack-lib.test.js) and reusable by the agenthost CLI. No I/O here --
// every function takes plain values in, returns plain values out.

export const EXCLUDE_NAMES = new Set([
  ".claude.json", ".credentials.json", "credentials.json", "auth.json",
  ".npmrc", ".netrc", ".pypirc",
  "node_modules", ".git", "__pycache__",
  ".DS_Store", // macOS Finder metadata; noise that would litter ~/.claude on the box
]);
// Credential/session carrier roles are classified with the leaf type in
// pack.mjs. A role-named source file such as auth/index.ts remains safe, while
// auth/device.bin and credential-store.json do not.
export const EXCLUDE_NAME_RE =
  /(?:^|[._-])(?:api[._-]?keys?|(?:private|signing)[._-]?keys?|keystores?|auth(?:entication|orization)?|oauth2?|tokens?|sessions?|credentials?|creds?|passwords?|secrets?|keyrings?|keychains?|cookies?|history|whatsapp|pairing)(?=$|[._-])/i;
// Kept as a separate export because directory components and file leaves have
// different handling in pack.mjs.
export const EXCLUDE_DIRECTORY_NAME_RE =
  /(?:^|[._-])(?:api[._-]?keys?|(?:private|signing)[._-]?keys?|keystores?|auth(?:entication|orization)?|oauth2?|tokens?|sessions?|credentials?|creds?|passwords?|secrets?|keyrings?|keychains?|cookies?|history|whatsapp|pairing)(?=$|[._-])/i;
// Structured config/state files with a carrier term plus an environment-like
// suffix are unsafe (credentials-prod.json, oauth-state.yaml, etc.).
export const EXCLUDE_STRUCTURED_CARRIER_FILE_RE =
  /(?:^|[._-])(?:api[._-]?keys?|(?:private|signing)[._-]?keys?|keystores?|auth(?:entication|orization)?|oauth2?|tokens?|sessions?|credentials?|creds?|passwords?|secrets?|keyrings?|keychains?|cookies?|history|whatsapp|pairing)[._-][A-Za-z0-9._-]*\.(?:json|ya?ml|toml|db|sqlite3?|bin|dat|pem|key|p12|pfx)$/i;
// Agent harness snapshots are credential carriers even when their leaf files
// look harmless (for example .codex-backup/config.toml). Check this pattern on
// every ancestor, not only the copied leaf.
export const AGENT_BACKUP_NAME_RE =
  /^(?:agent[._-]?backups?|\.?(?:claude|codex|hermes|openclaw|gemini|kimi)(?:\.json)?[._-](?:backup|backups|bak|old)(?:[._-].*)?)$/i;
export const PROCESS_JSON = ["settings.json", "keybindings.json", "mcp.json"];
export const LOCALHOST_RE = /(localhost|127\.0\.0\.1|0\.0\.0\.0)/i;
// Drive-letter paths only; the lookarounds keep URL schemes (https://) from matching.
export const WINPATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?!\/)/;
// WSL mounts of Windows drives (/mnt/c/...). Like WINPATH_RE these are flagged,
// never rewritten: there is no reliable Windows-user -> cloud-home mapping.
export const WSLPATH_RE = /\/mnt\/[a-z]\//;
// Either flavor of machine-specific path that will not resolve in the cloud:
export const STALE_PATH_RE = new RegExp(`${WINPATH_RE.source}|${WSLPATH_RE.source}`);
export const SECRET_KEYNAME_RE =
  /^(?:api-keys?|(?:[a-z0-9]+-)*api-key|tokens?|secrets?|passwords?|credentials?|authorization|authentication|auth|oauth|sessions?|cookies?|pairing|(?:[a-z0-9]+-)+(?:authorization|auth)|(?:access|refresh|bearer|api|auth|oauth|client|bot|service|personal-access)-token|(?:[a-z0-9]+-)+secret|secret-key|(?:[a-z0-9]+-)*secret-access-key|(?:[a-z0-9]+-)*(?:private|signing|encryption)-key|(?:[a-z0-9]+-)*(?:private|client)-key-(?:data|value)|(?:[a-z0-9]+-)*(?:api-key|token|secret)-value|(?:auth|oauth|session|token|secret|password|credential|cookie|api-key)-(?:store|cache)|(?:database|db|user|admin)-password|session-(?:id|key|token|secret|cookie|data|state)|pairing-(?:id|code|token|secret|state|data)|(?:[a-z0-9]+-)+(?:access-token|refresh-token|bot-token|client-secret|password|credential))$/i;
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
  ["private-key", /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY(?: BLOCK)?-----/],
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
  const lower = name.toLowerCase();
  return HERMES_EXCLUDE.has(lower)
    || /\.(?:bak|backup|old|orig|save|sw[opn]|tmp|copy|rej)(?:\d+|[._-].*)?$/.test(lower)
    || lower.endsWith(".un~")
    || lower.endsWith(".lock");
}

// ---- Codex (~/.codex) --------------------------------------------------------
// Names never packed from ~/.codex, ON TOP of the global EXCLUDE_NAMES: the auth
// file (the real OpenAI API key / ChatGPT OAuth -- excluded exactly like
// .claude's .credentials.json), plus session / history / log / cache runtime
// state. The global auth/token/session filename pattern still applies on top.
export const CODEX_EXCLUDE = new Set([
  "auth.json",            // OpenAI API key / ChatGPT OAuth tokens -- NEVER migrate
  "config.toml",          // may contain arbitrary provider auth; reconfigure on the box
  "history.jsonl", "history", "sessions", "log", "logs", "tmp", "cache",
  "version.json", "internal_storage",
]);
export function matchesCodexExclude(name) {
  const lower = name.toLowerCase();
  return CODEX_EXCLUDE.has(lower)
    || /\.(?:bak|backup|old|orig|save|sw[opn]|tmp|copy|rej)(?:\d+|[._-].*)?$/.test(lower)
    || lower.endsWith(".un~")
    || lower.endsWith(".lock");
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

function normalizeKeyName(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SAFE_TOKEN_SEMANTIC_RE =
  /^(?:(?:max|min|input|output|prompt|completion|total|cached-input|reasoning)-tokens?|tokens?-(?:budget|count|limit|type|usage)|tokenizer(?:-.*)?)$/i;
const STANDARD_CLOUD_SECRET_KEY_RE =
  /^(?:(?:[a-z0-9]+-)*secret-(?:string|binary|data)|(?:[a-z0-9]+-)*(?:account|shared-access|subscription|function|master)-key|(?:[a-z0-9]+-)*connection-string|(?:[a-z0-9]+-)*passphrase|(?:[a-z0-9]+-)*(?:pfx|pkcs12|keystore|key-store)-data|(?:[a-z0-9]+-)*key-material|shared-access-signature|cloudfront-signature|client-assertion|jwt|pwd)$/i;
const OPAQUE_CREDENTIAL_STATE_KEY_RE =
  /^(?:(?:auth|authorization|oauth|pkce|session|pairing|credentials?|secrets?|cookies?|passwords?|tokens?|api-key|client-secret|private-key|access-token|refresh-token|bearer-token|id-token|api-token|client-token|bot-token|service-token|personal-access-token)(?:-(?:blob|bundle|envelope|jar|vault|cache|store|payload|record|response|state|data|material|verifier|hash|digest|snapshot|backup|pem|cipher|ciphertext|encrypted|sealed|serialized|encoded|raw|code|ticket|assertion|proof|jwe|jwt))+s?(?:-v\d+)?|keys?(?:-(?:blob|envelope|vault|cache|store|payload|state|data|material|hash|digest|snapshot|backup|pem|cipher|ciphertext|encrypted|sealed|serialized|encoded|raw))+s?(?:-v\d+)?|(?:encrypted|sealed|serialized|encoded|cipher|ciphertext)-(?:access-|refresh-|bearer-|id-|api-|auth-|oauth-|client-|bot-|service-)?token)$/i;

function isSecretKeyName(key) {
  const normalized = normalizeKeyName(key);
  if (SAFE_TOKEN_SEMANTIC_RE.test(normalized)) return false;
  return SECRET_KEYNAME_RE.test(normalized)
    || STANDARD_CLOUD_SECRET_KEY_RE.test(normalized)
    || OPAQUE_CREDENTIAL_STATE_KEY_RE.test(normalized)
    || /(?:^|-)[a-z0-9][a-z0-9-]*-tokens?$/i.test(normalized);
}

function isSecretCarrierKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "env"
    || normalized === "envvars"
    || normalized === "environment"
    || normalized === "environmentvariables"
    || normalized.endsWith("header")
    || normalized.endsWith("headers");
}

function isHighConfidenceSecretKeyName(key) {
  const normalized = normalizeKeyName(key);
  if (["auth", "authentication", "oauth", "session", "pairing"].includes(normalized.toLowerCase())) {
    return false;
  }
  return isSecretKeyName(normalized);
}

function isCredentialScalar(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === REDACTED) return false;
  return !/^(?:<[^>]+>|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|(?:process\.)?env[.:][A-Z_][A-Z0-9_]*)$/i.test(trimmed);
}

const DEPENDENCY_MAP_KEYS = new Set([
  "dependencies", "devdependencies", "optionaldependencies", "overrides",
  "peerdependencies", "resolutions",
]);
const PUBLIC_AUTH_DESCRIPTOR_KEYS = new Set([
  "audience", "authorizationendpoint", "clientid", "description", "enabled",
  "issuer", "mode", "required", "scopes", "tokenendpoint", "type",
]);

function isPublicAuthMetadata(key, value) {
  const normalized = normalizeKeyName(key).toLowerCase();
  if (!["auth", "authentication", "oauth"].includes(normalized)) return false;
  if (typeof value === "boolean" || value === null) return true;
  if (typeof value === "string") {
    return /^(?:none|optional|required|basic|bearer|oauth2?|oidc|enabled|disabled)$/i.test(value.trim());
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((childKey) =>
    PUBLIC_AUTH_DESCRIPTOR_KEYS.has(childKey.replace(/[^A-Za-z0-9]/g, "").toLowerCase())
  );
}

function carrierSubtreeHasCredentialValue(node) {
  if (Array.isArray(node)) return node.some(carrierSubtreeHasCredentialValue);
  if (node !== null && typeof node === "object") {
    return Object.values(node).some(carrierSubtreeHasCredentialValue);
  }
  return isCredentialScalar(node);
}

// Audit-only predicate for arbitrary JSON assets. Unlike scrubAndTranslate it
// never mutates schema/package/data files: callers can omit a suspicious file
// whole and explain why. Direct dependency-map keys and schema descriptions are
// deliberately not treated as credentials.
export function jsonContainsCredentialValues(
  node,
  context = { inDependencyMap: false, allowDependencyMaps: false },
) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length - 1; i++) {
      if (
        typeof node[i] === "string"
        && (
          isSensitiveCliOption(node[i].trim())
          || SENSITIVE_SHORT_CLI_OPTION_RE.test(node[i].trim())
        )
        && carrierSubtreeHasCredentialValue(node[i + 1])
      ) {
        return true;
      }
    }
    return node.some((value) => jsonContainsCredentialValues(value, context));
  }
  if (typeof node === "string") {
    if (SECRET_SHAPES.some(([, shape]) => shape.test(node))) return true;
    return scrubSensitiveString(
      node,
      "structured-json-audit",
      "",
      { redactedSecrets: [] },
    ) !== node;
  }
  if (node === null || typeof node !== "object") return false;
  for (const [key, value] of Object.entries(node)) {
    const compactKey = key.replace(/[^A-Za-z0-9$]/g, "").toLowerCase();
    const childContext = {
      inDependencyMap: context.inDependencyMap
        || (context.allowDependencyMaps && DEPENDENCY_MAP_KEYS.has(compactKey)),
      allowDependencyMaps: context.allowDependencyMaps,
    };
    if (
      !context.inDependencyMap
      && isHighConfidenceSecretKeyName(key)
      && carrierSubtreeHasCredentialValue(value)
    ) {
      return true;
    }
    if (
      !context.inDependencyMap
      && ["auth", "authentication", "oauth", "session", "pairing"]
        .includes(normalizeKeyName(key).toLowerCase())
      && !isPublicAuthMetadata(key, value)
      && carrierSubtreeHasCredentialValue(value)
    ) {
      return true;
    }
    if (
      !context.inDependencyMap
      && isSecretCarrierKey(key)
      && carrierSubtreeHasCredentialValue(value)
    ) {
      return true;
    }
    if (jsonContainsCredentialValues(value, childContext)) return true;
  }
  return false;
}

function redactCarrierSubtree(node, label, jsonPath, report) {
  if (Array.isArray(node)) {
    return node.map((value, index) =>
      redactCarrierSubtree(value, label, `${jsonPath}[${index}]`, report)
    );
  }
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = redactCarrierSubtree(
        value,
        label,
        jsonPath ? `${jsonPath}.${key}` : key,
        report,
      );
    }
    return out;
  }
  report.redactedSecrets.push(`${label}: ${jsonPath}`);
  return REDACTED;
}

function redactStringsBelowSecretKey(node, label, jsonPath, report) {
  if (Array.isArray(node)) {
    return node.map((value, index) =>
      redactStringsBelowSecretKey(value, label, `${jsonPath}[${index}]`, report)
    );
  }
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = redactStringsBelowSecretKey(
        value,
        label,
        jsonPath ? `${jsonPath}.${key}` : key,
        report,
      );
    }
    return out;
  }
  if (
    (typeof node === "string" && node.length > 0)
    || (typeof node === "number" && Number.isFinite(node))
    || typeof node === "bigint"
  ) {
    report.redactedSecrets.push(`${label}: ${jsonPath}`);
    return REDACTED;
  }
  return node;
}

const SENSITIVE_SHORT_CLI_OPTION_RE = /^(?:-H|-u|-e)$/;
const SENSITIVE_SHORT_CLI_VALUE_RE =
  /((?:^|\s)-(?:H|u|e)\s+)(?:"[^"]*"|'[^']*'|\S+)/g;
const SENSITIVE_ATTACHED_SHORT_CLI_VALUE_RE =
  /(^|\s)(-(?:H|u)\S+|-e[A-Za-z_][A-Za-z0-9_]*=\S+)/g;
const SENSITIVE_CLI_VALUE_RE =
  /((?:^|\s)--?([A-Za-z][A-Za-z0-9_-]*)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/g;
const SENSITIVE_QUERY_RE =
  /([?&#]([^?=&#\s"'<>]+)=)([^&#\s"']*)/g;
const SENSITIVE_ASSIGNMENT_RE =
  /((?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)=)(?:"[^"]*"|'[^']*'|[^\s;,]*)/g;
const SENSITIVE_HEADER_LITERAL_RE =
  /^(?:authorization|proxy-authorization|x-api-key|x-private|cookie|set-cookie)\s*:/i;
const URI_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+(@)/g;
const QUERY_PARAMETER_RE = /(?:^|[?&#])([^?=&#\s"'<>]+)=/g;
const PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;
const MAX_QUERY_DECODE_DEPTH = 3;
const MAX_QUERY_NAME_LENGTH = 1024;
const MAX_ENCODED_STRING_LENGTH = 64 * 1024;

function decodePercentLayer(value, plusAsSpace = false) {
  const candidate = plusAsSpace ? value.replace(/\+/g, "%20") : value;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return code <= 0x7f ? String.fromCharCode(code) : match;
    });
  }
}

function normalizeQueryParameterName(name) {
  let normalized = String(name);
  if (normalized.length > MAX_QUERY_NAME_LENGTH) return "credential";
  for (let depth = 0; depth < MAX_QUERY_DECODE_DEPTH; depth++) {
    const decoded = decodePercentLayer(normalized, true);
    if (decoded === normalized) break;
    normalized = decoded;
  }
  // More encoding layers than the bounded scanner permits fail closed. A
  // deliberately over-encoded key must not become a bypass.
  if (PERCENT_ESCAPE_RE.test(normalized)) return "credential";
  return normalized.toLowerCase();
}

function redactMatchingQueryParameters(value, shouldRedact) {
  return value.replace(SENSITIVE_QUERY_RE, (match, prefix, name) =>
    shouldRedact(normalizeQueryParameterName(name))
      ? `${prefix}${REDACTED}`
      : match
  );
}

function scrubSignedQueryCredentials(value) {
  const names = new Set(
    [...value.matchAll(QUERY_PARAMETER_RE)].map((match) =>
      normalizeQueryParameterName(match[1])
    ),
  );
  let cleaned = value;
  if (
    names.has("sv")
    && names.has("se")
    && names.has("sig")
    && ["sp", "sr", "ss", "srt"].some((name) => names.has(name))
  ) {
    cleaned = redactMatchingQueryParameters(cleaned, (name) => name === "sig");
  }
  if (
    names.has("expires")
    && names.has("signature")
    && names.has("key-pair-id")
  ) {
    cleaned = redactMatchingQueryParameters(cleaned, (name) => name === "signature");
  }
  for (const prefix of ["x-amz", "x-goog"]) {
    if (
      names.has(`${prefix}-algorithm`)
      && names.has(`${prefix}-credential`)
      && names.has(`${prefix}-signature`)
    ) {
      cleaned = redactMatchingQueryParameters(
        cleaned,
        (name) => name === `${prefix}-credential` || name === `${prefix}-signature`,
      );
    }
  }
  if (
    names.has("expires")
    && names.has("signature")
    && (names.has("awsaccesskeyid") || names.has("googleaccessid"))
  ) {
    cleaned = redactMatchingQueryParameters(
      cleaned,
      (name) => ["awsaccesskeyid", "googleaccessid", "signature"].includes(name),
    );
  }
  return cleaned;
}

function scrubDirectSensitiveString(value) {
  return scrubSignedQueryCredentials(value
    .replace(SENSITIVE_SHORT_CLI_VALUE_RE, `$1${REDACTED}`)
    .replace(SENSITIVE_ATTACHED_SHORT_CLI_VALUE_RE, `$1${REDACTED}`)
    .replace(SENSITIVE_CLI_VALUE_RE, (match, prefix, name) =>
      isSensitiveCliCarrierName(name) ? `${prefix}${REDACTED}` : match
    )
    .replace(SENSITIVE_QUERY_RE, (match, prefix, name) =>
      isSensitiveCliCarrierName(normalizeQueryParameterName(name))
        ? `${prefix}${REDACTED}`
        : match
    )
    .replace(SENSITIVE_ASSIGNMENT_RE, (match, prefix, name) =>
      isSensitiveCliCarrierName(name) ? `${prefix}${REDACTED}` : match
    )
    .replace(URI_USERINFO_RE, `$1${REDACTED}$2`));
}

function encodeURIComponentFailClosed(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return REDACTED;
  }
}

function scrubEncodedString(value, depth) {
  if (!PERCENT_ESCAPE_RE.test(value)) return value;
  if (value.length > MAX_ENCODED_STRING_LENGTH) return REDACTED;
  if (depth >= MAX_QUERY_DECODE_DEPTH) return REDACTED;

  const decoded = decodePercentLayer(value);
  if (decoded === value) return value;
  let cleaned = scrubDirectSensitiveString(decoded);
  cleaned = scrubNestedEncodedQueryValues(cleaned, depth + 1);
  cleaned = scrubEncodedString(cleaned, depth + 1);
  return cleaned === decoded ? value : encodeURIComponentFailClosed(cleaned);
}

function scrubNestedEncodedQueryValues(value, depth = 0) {
  return value.replace(SENSITIVE_QUERY_RE, (match, prefix, _name, queryValue) => {
    if (!queryValue || queryValue === REDACTED) return match;
    const cleaned = scrubEncodedString(queryValue, depth);
    return cleaned === queryValue ? match : `${prefix}${cleaned}`;
  });
}

function isSensitiveCliCarrierName(name) {
  const normalized = normalizeKeyName(name).toLowerCase();
  return isSecretKeyName(normalized)
    || /^(?:headers?|user|env(?:ironment)?(?:-file)?|(?:token|secret|password|credential|private-key)-file)$/.test(normalized);
}

function isSensitiveCliOption(value) {
  const match = value.match(/^--?([A-Za-z][A-Za-z0-9_-]*)$/);
  return Boolean(match && isSensitiveCliCarrierName(match[1]));
}

function isSensitiveAttachedShortOption(value) {
  return /^-(?:H|u).+/.test(value)
    || /^-e[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function scrubSensitiveString(value, label, jsonPath, report) {
  if (SENSITIVE_HEADER_LITERAL_RE.test(value)) {
    report.redactedSecrets.push(`${label}: ${jsonPath} (header literal)`);
    return REDACTED;
  }
  if (isSensitiveAttachedShortOption(value)) {
    report.redactedSecrets.push(`${label}: ${jsonPath} (attached credential option)`);
    return REDACTED;
  }
  const cleaned = scrubEncodedString(
    scrubNestedEncodedQueryValues(scrubDirectSensitiveString(value)),
    0,
  );
  if (cleaned !== value) {
    report.redactedSecrets.push(`${label}: ${jsonPath} (inline credential carrier)`);
  }
  return cleaned;
}

// report is mutated (redactedSecrets) to match pack.mjs's existing call shape.
export function scrubAndTranslate(node, label, jsonPath, stats, homeVariants, cloudHome, report) {
  if (Array.isArray(node)) {
    let redactNext = false;
    return node.map((v, i) => {
      const p = `${jsonPath}[${i}]`;
      if (redactNext) {
        redactNext = false;
        return redactCarrierSubtree(v, label, p, report);
      }
      if (
        typeof v === "string"
        && (
          isSensitiveCliOption(v.trim())
          || SENSITIVE_SHORT_CLI_OPTION_RE.test(v.trim())
        )
      ) {
        redactNext = true;
        return v;
      }
      return scrubAndTranslate(v, label, p, stats, homeVariants, cloudHome, report);
    });
  }
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const p = jsonPath ? `${jsonPath}.${k}` : k;
      // Rule 1: carrier keys are case-insensitive and may contain arbitrarily
      // nested maps/arrays. Every scalar below them is treated as secret.
      if (isSecretCarrierKey(k)) {
        out[k] = redactCarrierSubtree(v, label, p, report);
        continue;
      }
      // Rule 2: secret-named keys have no safe minimum length. Redact every
      // non-empty string, including strings nested beneath arrays/objects.
      if (isSecretKeyName(k) && !isPublicAuthMetadata(k, v)) {
        out[k] = redactStringsBelowSecretKey(v, label, p, report);
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
    return translateValue(
      scrubSensitiveString(node, label, jsonPath, report),
      homeVariants,
      cloudHome,
      stats,
    );
  }
  return node;
}

// ---- OpenClaw (~/.openclaw/config.json) migration -----------------------------
// CONT-05. The generic scrubAndTranslate above recursively redacts known carrier
// and secret-named keys plus high-confidence value shapes. That is still not
// enough for OpenClaw, whose WhatsApp linked-device
// SESSION material lives at channels.whatsapp.session / linkedNumber -- key names
// that match no secret regex and values that match no secret shape. Run through
// scrubAndTranslate alone those would migrate in CLEARTEXT, unflagged (proven by a
// failing-today assertion in test/continuity-channels-fixtures.test.js) -- a direct
// violation of security invariants #2 (session material never migrates) and #3.
//
// The fix is what the contract requires: an ALLOWLIST, not a blocklist. We migrate
// ONLY known-safe structure and DROP everything else (fail-closed) -- so a future
// OpenClaw version that adds a new secret-bearing key leaks nothing until this spec
// is deliberately widened. scrubAndTranslate then runs as a SECOND net over what
// survived (a token pasted into an allowlisted field is still redacted; a home path
// in a workspace is still translated).
//
// SECURITY direction (drop-by-default) is correct and complete. COMPLETENESS of the
// allowlist (does a real channel need more than enabled/type to work?) must be
// validated against a real ~/.openclaw before ~/.openclaw migration is enabled --
// invariant #3's "rerun against the real harness". Widen the spec from evidence,
// never by loosening to "keep what doesn't look secret".
// NOTE the allowlist rule this spec obeys after the 2026-07-23 red-team: NEVER put `true`
// over an OBJECT subtree. `true` means "keep this node wholesale (scrub runs after)", and the
// scrub only recognizes known carrier/key/value patterns -- so `true` over an arbitrary
// object re-opens the keep-unknown hole (a base64 session blob under an unlisted key would
// ride through). `true` is used ONLY on scalar leaves whose KEY is known non-secret. Every
// object node is an explicit key map; unknown keys drop fail-closed.
export const OPENCLAW_MIGRATE_SPEC = {
  version: true,
  // Agent roster: names / model id / workspace are structure, not secrets. systemPrompt,
  // description (free-form text), and anything else DROP fail-closed until evidence says keep.
  agents: { entries: { "[]": { name: true, model: true, workspace: true } } },
  // Per-channel: enumerated by name (not a "*" wildcard) so an OpenClaw channel type this
  // box does not support (anything other than telegram/discord/whatsapp -- the exact set
  // settings-lib.js's CHANNEL_OWNERS knows) drops ENTIRELY, fail-closed, rather than
  // surviving with a bare enabled/type shell for a channel nothing here will ever route to.
  //
  // Fields grounded in OpenClaw's OWN documented config-examples.md (2026-07-23, verified
  // against real examples, not guessed) -- this CLOSES the "completeness" gap the contract
  // flagged: a real Telegram/Discord channel needs more than enabled/type to actually
  // reconnect (an allowlist of who may message it, group/guild policy), and those fields
  // are genuinely non-secret (access-control IDs, not credentials) so scrubAndTranslate's
  // second net correctly leaves them untouched too. botToken/token/session/linkedNumber
  // still DROP here -- re-supplied on the box via Fly secrets, never carried in the config.
  channels: {
    telegram: {
      enabled: true, type: true,
      allowFrom: { "[]": true },       // Telegram user IDs allowed to message the bot
      groupPolicy: true,                // e.g. "allowlist" -- a policy string, not a secret
      groupAllowFrom: { "[]": true },   // group IDs allowed, same shape as allowFrom
      groups: { "*": { requireMention: true } },
    },
    discord: {
      enabled: true, type: true,
      dmPolicy: true,
      allowFrom: { "[]": true },        // Discord user IDs allowed to DM the bot
      guilds: { "*": { slug: true, requireMention: true,
        channels: { "*": { enabled: true, requireMention: true } } } },
    },
    // WhatsApp deliberately stays enabled/type ONLY. Two reasons, not one: (a) its
    // equivalent access-control field (allowFrom) holds PHONE NUMBERS -- more sensitive PII
    // than Telegram/Discord's opaque numeric platform IDs -- and (b) this box's broker
    // decision pins WhatsApp to Hermes, never OpenClaw (CONT-05-RUNTIME-PLAN), so an
    // OpenClaw-native whatsapp block is dead structure here regardless; widening it would
    // add exposure for a code path nothing on this box actually uses.
    whatsapp: { enabled: true, type: true },
  },
  // Binding = which agent handles which channel. Pure structure.
  bindings: { "[]": { agent: true, channel: true } },
  // Gateway TRANSPORT shape only -- never gateway.auth / gateway.token.
  gateway: { bind: true, port: true, host: true },
  // Display prefs: an EXPLICIT key map, not `true` -- keep only known non-secret leaves.
  // Widen from evidence (audit a real ~/.openclaw's ui block before enabling migration).
  ui: { theme: true, density: true, locale: true },
};

// Recursively keep only what OPENCLAW_MIGRATE_SPEC permits; DROP (not redact)
// everything else and record the dropped path in report.openclawDropped. Spec DSL:
//   true            -> preserve this node wholesale (scrub runs over it afterwards)
//   { key: subspec} -> object: only listed keys survive, each by its subspec
//   { "[]": subspec}-> array: apply subspec to every element
//   { "*": subspec }-> object map with arbitrary keys: apply subspec to every value
// A shape mismatch (spec wants structure, node is a scalar, or vice-versa) drops the
// node -- fail-closed, never migrate something we can't account for. Never mutates input.
export function applyAllowlist(node, spec, path, report) {
  if (spec === true) {
    // `true` means "keep this SCALAR leaf wholesale". Every `true` in the spec
    // targets a scalar (ids, names, ports, flags). If the input smuggles an
    // object/array where a scalar was allowlisted (red-team 2026-07-24: an object
    // element inside `allowFrom: {"[]": true}` would otherwise ride through with
    // scrubAndTranslate as the only net), DROP + record -- fail-closed, so the DSL
    // never keeps an unexpected subtree wholesale.
    if (node !== null && typeof node === "object") {
      report.openclawDropped.push(`${path || "(root)"} (dropped: allowlisted as a scalar but got ${Array.isArray(node) ? "an array" : "an object"})`);
      return undefined;
    }
    return node;
  }
  if (node === null || typeof node !== "object") {
    report.openclawDropped.push(`${path || "(root)"} (dropped: expected structure, got a value)`);
    return undefined;
  }
  if (Array.isArray(node)) {
    const elemSpec = spec["[]"];
    if (!elemSpec) { report.openclawDropped.push(`${path || "(root)"} (dropped: array not allowlisted)`); return undefined; }
    return node
      .map((v, i) => applyAllowlist(v, elemSpec, `${path}[${i}]`, report))
      .filter((v) => v !== undefined);
  }
  const mapSpec = spec["*"];
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    // Own-property lookup only: a JSON-parsed "__proto__"/"constructor"/"toString" input key
    // must DROP (and be recorded), not resolve to an inherited Object.prototype member.
    const sub = mapSpec !== undefined ? mapSpec
      : (Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : undefined);
    const childPath = path ? `${path}.${k}` : k;
    if (sub === undefined) { report.openclawDropped.push(childPath); continue; }
    const kept = applyAllowlist(v, sub, childPath, report);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

// Migrate a parsed ~/.openclaw/config.json for the cloud box: allowlist first
// (drops session material + any unlisted subtree), then scrubAndTranslate as a
// second net over the survivors. report gains .openclawDropped (paths removed by
// the allowlist) on top of the usual .redactedSecrets. Pure: returns the migrated
// object, never touches the input.
export function packOpenclawConfig(config, stats, homeVariants, cloudHome, report) {
  if (!Array.isArray(report.openclawDropped)) report.openclawDropped = [];
  const allowlisted = applyAllowlist(config, OPENCLAW_MIGRATE_SPEC, "", report) ?? {};
  return scrubAndTranslate(allowlisted, "openclaw", "", stats, homeVariants, cloudHome, report);
}

export function classifyMcpServer(cfg) {
  const url = cfg.url ?? "";
  const command = cfg.command ?? "";
  if (LOCALHOST_RE.test(url)) return "DISABLED: points at localhost, unreachable from the cloud";
  if (WINPATH_RE.test(command)) return "FLAGGED: absolute Windows command path";
  if (url) return "PORTABLE (remote URL)";
  if (["npx", "uvx", "node", "python", "python3"].includes(command)) return "PORTABLE (package-managed)";
  if (command) return "REVIEW: command is not a recognized package-managed launcher";
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
    const safeSource = String(label ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[^A-Za-z0-9._@() ~:/\\-]/g, "_")
      .trim()
      .slice(0, 240);
    const safeName = String(name ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[^A-Za-z0-9._@() /-]/g, "_")
      .trim()
      .slice(0, 120) || "(unnamed)";
    report.mcp.push({
      source: safeSource,
      name: safeName,
      verdict: classifyMcpServer(cfg),
    });
  }
}
