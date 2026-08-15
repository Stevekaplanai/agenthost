// Converts already-consumed repo secret inputs into the ENVF_<i>__<KEY> secret
// names start.sh expects (container/start.sh's env contract: index into REPOS).
// The public CLI accepts only --env-from references; raw values reach this pure
// helper in memory after their source environment variables have been deleted.
//
// envFlags entries look like "owner/repo:KEY=VALUE".
export function buildEnvSecrets(repos, envFlags = []) {
  const secrets = {};
  for (const raw of envFlags) {
    const sep = raw.indexOf(":");
    if (sep === -1) throw new Error("internal repo secret input must be owner/repo:KEY=VALUE");
    const repo = raw.slice(0, sep);
    const kv = raw.slice(sep + 1);
    const eq = kv.indexOf("=");
    if (eq === -1) throw new Error("internal repo secret input must be owner/repo:KEY=VALUE");
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    const idx = repos.indexOf(repo);
    if (idx === -1) throw new Error("repo secret target must reference a repo listed in --repos");
    secrets[`ENVF_${idx}__${key}`] = value;
  }
  return secrets;
}
