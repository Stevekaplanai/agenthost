const FIXED_SECRET_INPUTS = [
  {
    selector: "oauth-token-env",
    target: "oauth-token",
    envName: "AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN",
  },
  {
    selector: "anthropic-key-env",
    target: "anthropic-key",
    envName: "AGENTHOST_ANTHROPIC_API_KEY",
  },
  {
    selector: "github-token-env",
    target: "github-token",
    envName: "AGENTHOST_GITHUB_TOKEN",
  },
  {
    selector: "token-env",
    target: "token",
    envName: "AGENTHOST_BRIDGE_TOKEN",
  },
  {
    selector: "access-key-env",
    target: "access-key",
    envName: "AGENTHOST_ACCESS_KEY",
    prompt: "Enter the new AgentHost access key (or set AGENTHOST_ACCESS_KEY)",
  },
];

function envFromParts(spec) {
  const raw = typeof spec === "string" ? spec : "";
  const colon = raw.indexOf(":");
  const equals = raw.indexOf("=", colon + 1);
  if (colon <= 0 || equals <= colon + 1 || equals === raw.length - 1) {
    throw new Error(
      "--env-from must be owner/repo:KEY=AGENTHOST_SECRET_NAME; no secret value belongs in the command",
    );
  }
  const repo = raw.slice(0, colon);
  const key = raw.slice(colon + 1, equals);
  const envName = raw.slice(equals + 1);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    || !/^AGENTHOST_SECRET_[A-Z0-9_]+$/.test(envName)
  ) {
    throw new Error(
      "--env-from must be owner/repo:KEY=AGENTHOST_SECRET_NAME; the source variable must start AGENTHOST_SECRET_",
    );
  }
  return { repo, key, envName };
}

export function readHiddenSecret(prompt, {
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(`${prompt}; set the dedicated environment variable for noninteractive use`);
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused?.() ?? false;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };
    const finish = () => {
      output.write("\n");
      cleanup();
      if (value.length === 0) reject(new Error(`${prompt} cannot be empty`));
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          output.write("\n");
          cleanup();
          reject(new Error("secret input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    output.write(`${prompt}: `);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function resolveSecretInputs(
  flags,
  env = process.env,
  promptSecret = readHiddenSecret,
) {
  const resolved = { ...flags };
  const captured = new Map();
  const names = new Set([
    ...FIXED_SECRET_INPUTS.map(({ envName }) => envName),
    ...Object.keys(env).filter((name) => name.startsWith("AGENTHOST_SECRET_")),
  ]);
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      captured.set(name, env[name]);
      delete env[name];
    }
  }

  for (const { selector, target, envName, prompt } of FIXED_SECRET_INPUTS) {
    if (resolved[selector]) {
      let value = captured.get(envName);
      if (typeof value !== "string" || value.length === 0) {
        value = await promptSecret(prompt || `Enter secret for ${selector} (or set ${envName})`);
      }
      if (typeof value !== "string" || value.length === 0) throw new Error(`${selector} received no secret`);
      resolved[target] = value;
    }
    delete resolved[selector];
  }

  const envFrom = resolved["env-from"] === undefined
    ? []
    : Array.isArray(resolved["env-from"])
      ? resolved["env-from"]
      : [resolved["env-from"]];
  if (envFrom.length) {
    resolved.env = [...(resolved.env || [])];
    for (const spec of envFrom) {
      const { repo, key, envName } = envFromParts(spec);
      let value = captured.get(envName);
      if (typeof value !== "string" || value.length === 0) {
        value = await promptSecret(`Enter secret for ${repo}:${key} (or set ${envName})`);
      }
      if (typeof value !== "string" || value.length === 0) throw new Error("--env-from received no secret");
      resolved.env.push(`${repo}:${key}=${value}`);
    }
  }
  delete resolved["env-from"];
  return resolved;
}
