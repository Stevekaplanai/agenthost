const BASE_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
  "TEMP", "TMP", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
const HARNESS_HOME_KEYS = ["HERMES_HOME", "CODEX_HOME", "OPENCLAW_HOME"];
const FLY_AUTH_KEYS = ["FLY_API_TOKEN", "FLY_ACCESS_TOKEN", "FLY_CONFIG_DIR"];

export function minimalChildEnv({
  source = process.env,
  includeHarnessHomes = false,
  includeFlyAuth = false,
  extra = {},
} = {}) {
  const out = {};
  const keys = [
    ...BASE_KEYS,
    ...(includeHarnessHomes ? HARNESS_HOME_KEYS : []),
    ...(includeFlyAuth ? FLY_AUTH_KEYS : []),
  ];
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return { ...out, ...extra };
}
