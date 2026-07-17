// Converts --repos + repeatable --env flags into the ENVF_<i>__<KEY> secret
// names start.sh expects (container/start.sh's env contract: index into REPOS
// so repo names with any characters work). Pure function -- no I/O.
//
// envFlags entries look like "owner/repo:KEY=VALUE".
export function buildEnvSecrets(repos, envFlags = []) {
  const secrets = {};
  for (const raw of envFlags) {
    const sep = raw.indexOf(":");
    if (sep === -1) throw new Error(`--env value must be "owner/repo:KEY=VALUE", got: ${raw}`);
    const repo = raw.slice(0, sep);
    const kv = raw.slice(sep + 1);
    const eq = kv.indexOf("=");
    if (eq === -1) throw new Error(`--env value must be "owner/repo:KEY=VALUE", got: ${raw}`);
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    const idx = repos.indexOf(repo);
    if (idx === -1) throw new Error(`--env references '${repo}', which isn't in --repos (${repos.join(", ") || "none given"})`);
    secrets[`ENVF_${idx}__${key}`] = value;
  }
  return secrets;
}
