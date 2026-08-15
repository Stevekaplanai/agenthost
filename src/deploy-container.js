// Stages the per-deploy Dockerfile/fly.toml the same way scripts/spike-deploy.ps1
// did by hand: stamp the app name into fly.toml, point it at a throwaway
// Dockerfile.deploy, and -- because `fly ssh sftp shell` ignores piped stdin on
// Windows -- bake the harness tarball in as an image layer instead of uploading
// it separately. Pure file staging; the actual `flyctl deploy` call lives in fly.js.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sha256File } from "./file-hash.js";

function removeOwnedBuildContext(buildContextRoot) {
  if (!buildContextRoot) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(buildContextRoot);
  const relative = path.relative(tempRoot, resolved);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(".." + path.sep)
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
    || !path.basename(relative).startsWith("agenthost-deploy-")
  ) {
    throw new Error(`refusing to remove unowned deploy context: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function stageDeployFiles({ containerDir, app, harnessTarball, harnessSha256 }) {
  const buildContextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-deploy-"));
  const buildContextDir = path.join(buildContextRoot, "container");
  const flyTomlDeploy = path.join(buildContextDir, "fly.toml.deploy");
  const dockerfileDeploy = path.join(buildContextDir, "Dockerfile.deploy");
  let harnessCopy = null;

  try {
    fs.cpSync(containerDir, buildContextDir, {
      recursive: true,
      filter: (source) => !/^(?:fly\.toml\.deploy(?:\..*)?|Dockerfile\.deploy(?:\..*)?|harness.*\.tar\.gz)$/i
        .test(path.basename(source)),
    });
    const flyToml = fs.readFileSync(path.join(buildContextDir, "fly.toml"), "utf8");
    const stampedToml = flyToml
      .replace("AGENTHOST_APP_NAME", app)
      .replace('dockerfile = "Dockerfile"', 'dockerfile = "Dockerfile.deploy"');
    fs.writeFileSync(flyTomlDeploy, stampedToml);
    let dockerfile = fs.readFileSync(path.join(buildContextDir, "Dockerfile"), "utf8");
    if (harnessTarball) {
      if (!fs.existsSync(harnessTarball)) {
        throw new Error(`audited harness tarball is missing: ${harnessTarball}`);
      }
      if (!/^[a-f0-9]{64}$/.test(harnessSha256 || "")) {
        throw new Error("audited harness SHA-256 is required before deploy staging");
      }
      harnessCopy = path.join(buildContextDir, "harness.tar.gz");
      fs.copyFileSync(harnessTarball, harnessCopy);
      if (sha256File(harnessCopy) !== harnessSha256) {
        throw new Error("staged harness copy does not match its audited SHA-256");
      }
      dockerfile +=
        "\nCOPY harness.tar.gz /opt/agenthost/harness.tar.gz\n"
        + `RUN echo "${harnessSha256}  /opt/agenthost/harness.tar.gz" | sha256sum -c -\n`;
    }
    fs.writeFileSync(dockerfileDeploy, dockerfile);
  } catch (error) {
    removeOwnedBuildContext(buildContextRoot);
    throw error;
  }

  return {
    buildContextRoot,
    buildContextDir,
    flyTomlDeploy,
    dockerfileDeploy,
    harnessCopy,
    harnessAttached: Boolean(harnessCopy),
  };
}

export function cleanupDeployFiles({ buildContextRoot }) {
  removeOwnedBuildContext(buildContextRoot);
}
