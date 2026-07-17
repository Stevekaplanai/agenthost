// Stages the per-deploy Dockerfile/fly.toml the same way scripts/spike-deploy.ps1
// did by hand: stamp the app name into fly.toml, point it at a throwaway
// Dockerfile.deploy, and -- because `fly ssh sftp shell` ignores piped stdin on
// Windows -- bake the harness tarball in as an image layer instead of uploading
// it separately. Pure file staging; the actual `flyctl deploy` call lives in fly.js.
import fs from "node:fs";
import path from "node:path";

export function stageDeployFiles({ containerDir, app, harnessTarball }) {
  const flyToml = fs.readFileSync(path.join(containerDir, "fly.toml"), "utf8");
  const stampedToml = flyToml
    .replace("AGENTHOST_APP_NAME", app)
    .replace('dockerfile = "Dockerfile"', 'dockerfile = "Dockerfile.deploy"');
  const flyTomlDeploy = path.join(containerDir, "fly.toml.deploy");
  fs.writeFileSync(flyTomlDeploy, stampedToml);

  let dockerfile = fs.readFileSync(path.join(containerDir, "Dockerfile"), "utf8");
  let harnessCopy = null;
  if (harnessTarball && fs.existsSync(harnessTarball)) {
    harnessCopy = path.join(containerDir, "harness.tar.gz");
    fs.copyFileSync(harnessTarball, harnessCopy);
    dockerfile += "\nCOPY harness.tar.gz /opt/agenthost/harness.tar.gz\n";
  }
  const dockerfileDeploy = path.join(containerDir, "Dockerfile.deploy");
  fs.writeFileSync(dockerfileDeploy, dockerfile);

  return { flyTomlDeploy, dockerfileDeploy, harnessCopy, harnessAttached: Boolean(harnessCopy) };
}

export function cleanupDeployFiles({ flyTomlDeploy, dockerfileDeploy, harnessCopy }) {
  for (const f of [flyTomlDeploy, dockerfileDeploy, harnessCopy]) {
    if (f) fs.rmSync(f, { force: true });
  }
}
