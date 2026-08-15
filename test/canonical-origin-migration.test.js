import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "migrate-canonical-box-origin.ps1");
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const OLD = "https://agenthost-steve.fly.dev";
const NEW = "https://app.agenthost.space";
const windowsTest = process.platform === "win32" ? test : test.skip;

function run(root, apply = false, options = {}) {
  const args = [
    "-NoProfile", "-File", SCRIPT,
    "-StateRoot", root,
    "-CliStatePath", path.join(root, "agenthost-steve.json"),
    "-BridgeEnvPath", path.join(root, "agenthost-steve-kanban-bridge.env"),
  ];
  if (apply) args.push("-Apply");
  if (options.failAfter) args.push("-TestFailAfterReplace", String(options.failAfter));
  if (options.crashAfter) args.push("-TestCrashAfterReplace", String(options.crashAfter));
  if (options.crashAfterForward) args.push("-TestCrashAfterForwardReplace", String(options.crashAfterForward));
  if (options.crashAfterRollback) args.push("-TestCrashAfterRollbackReplace", String(options.crashAfterRollback));
  if (options.crashAfterTemplateCreate) {
    args.push("-TestCrashAfterAclTemplateCreate", String(options.crashAfterTemplateCreate));
  }
  if (options.aclDrift) args.push("-TestDriftAclAfterReplace");
  return spawnSync(POWERSHELL, args, {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.psModulePath ? { PSModulePath: options.psModulePath } : {}),
      ...(options.failAfter || options.crashAfter || options.crashAfterForward ||
        options.crashAfterRollback || options.crashAfterTemplateCreate || options.aclDrift ?
        { AGENTHOST_MIGRATION_TEST_MODE: "1" } : {}),
    },
  });
}

function accessSddl(file) {
  const result = spawnSync(POWERSHELL, [
    "-NoProfile", "-Command",
    "$acl=[IO.File]::GetAccessControl($env:AGENTHOST_TEST_ACL_PATH); $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENTHOST_TEST_ACL_PATH: file },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function accessFingerprint(sddl) {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const helperStart = source.indexOf("function Get-BytesDigest");
  const helperEnd = source.indexOf("function New-PrivateFileSecurity");
  assert.notEqual(helperStart, -1, "fingerprint helper start remains reachable");
  assert.notEqual(helperEnd, -1, "fingerprint helper end remains reachable");
  const helpers = source.slice(helperStart, helperEnd);
  const result = spawnSync(POWERSHELL, [
    "-NoProfile", "-Command",
    `${helpers}\nGet-RawAclAccessFingerprint ([Security.AccessControl.RawSecurityDescriptor]::new($env:AGENTHOST_TEST_SDDL))`,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENTHOST_TEST_SDDL: sddl },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function accessFileFingerprint(file) {
  return accessFingerprint(accessSddl(file));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function sameExistingWindowsPath(left, right) {
  return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase();
}

function protectAccessRules(file) {
  const result = spawnSync(POWERSHELL, [
    "-NoProfile", "-Command",
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      "$accessOnly=[Security.AccessControl.FileSecurity]::new(); " +
      "$accessOnly.SetAccessRuleProtection($true,$false); " +
      "$rule=[Security.AccessControl.FileSystemAccessRule]::new(" +
        "$current,[Security.AccessControl.FileSystemRights]::FullControl," +
        "[Security.AccessControl.AccessControlType]::Allow); " +
      "[void]$accessOnly.AddAccessRule($rule); " +
      "[IO.File]::SetAccessControl($env:AGENTHOST_TEST_ACL_PATH,$accessOnly)",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENTHOST_TEST_ACL_PATH: file },
  });
  assert.equal(result.status, 0, result.stderr);
}

function brokenSecurityModulePath(root) {
  const base = path.join(root, "modules");
  const module = path.join(base, "Microsoft.PowerShell.Security");
  fs.mkdirSync(module, { recursive: true });
  fs.writeFileSync(path.join(module, "Microsoft.PowerShell.Security.psd1"), `@{
RootModule = 'Missing.psm1'
ModuleVersion = '999.0.0'
GUID = '674fbef0-6886-4b18-9bca-91acba171ad8'
CmdletsToExport = @('Get-Acl', 'Set-Acl')
}
`);
  return [base, process.env.PSModulePath].filter(Boolean).join(path.delimiter);
}

function fixture({ includeCli = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-origin-migration-"));
  const identity = {
    selfId: "desktop-self-id-must-not-change",
    boxId: "box-id-must-not-change",
    secret: "mesh-secret-must-never-print-or-change",
  };
  const bridgeKey = "bridge-key-must-never-print-or-change";
  const cliPassword = "cli-password-must-never-print-or-change";
  // The live Windows files carry a UTF-8 BOM. PowerShell 5.1's JSON parser
  // rejects that character unless the migration deliberately handles it.
  fs.writeFileSync(path.join(root, "box.json"), "\ufeff" + JSON.stringify({ origin: OLD }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "mesh.json"), "\ufeff" + JSON.stringify({ ...identity, origin: OLD }, null, 2) + "\n");
  if (includeCli) {
    fs.writeFileSync(path.join(root, "agenthost-steve.json"), JSON.stringify({
      app: "agenthost-steve",
      ttydPassword: cliPassword,
      repos: ["steve/private-repo"],
    }, null, 2) + "\n");
  }
  fs.writeFileSync(
    path.join(root, "agenthost-steve-kanban-bridge.env"),
    `AGENTHOST_BOX_URL=${OLD}\r\nAGENTHOST_BOX_KEY=${bridgeKey}\r\n`,
  );
  return { root, identity, bridgeKey, cliPassword };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff/, ""));
}

function stateBytes(root) {
  return new Map(["box.json", "mesh.json", "agenthost-steve.json", "agenthost-steve-kanban-bridge.env"]
    .map((name) => [name, fs.readFileSync(path.join(root, name))]));
}

function stateAcls(root) {
  return new Map(["box.json", "mesh.json", "agenthost-steve.json", "agenthost-steve-kanban-bridge.env"]
    .map((name) => [name, accessFileFingerprint(path.join(root, name))]));
}

function transactionArtifacts(root) {
  return fs.readdirSync(root).filter((name) =>
    name.includes("agenthost-origin-") || name.startsWith(".canonical-origin-migration"));
}

windowsTest("canonical origin migration preflights without changing or exposing credential state", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = stateBytes(root);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight only/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value));
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
});

windowsTest("canonical origin migration changes only all four persisted origins and is idempotent", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const applied = run(root, true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /migrated and verified/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(applied.stdout + applied.stderr, new RegExp(value));
  }

  const box = readJson(path.join(root, "box.json"));
  const mesh = readJson(path.join(root, "mesh.json"));
  const cli = readJson(path.join(root, "agenthost-steve.json"));
  const bridge = fs.readFileSync(path.join(root, "agenthost-steve-kanban-bridge.env"), "utf8");
  assert.deepEqual(box, { origin: NEW });
  assert.deepEqual(mesh, { ...identity, origin: NEW });
  assert.deepEqual(cli, {
    origin: NEW,
    app: "agenthost-steve",
    ttydPassword: cliPassword,
    repos: ["steve/private-repo"],
  });
  assert.equal(bridge, `AGENTHOST_BOX_URL=${NEW}\r\nAGENTHOST_BOX_KEY=${bridgeKey}\r\n`);

  const replay = run(root, true);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /already uses/i);
  assert.deepEqual(readJson(path.join(root, "mesh.json")), mesh);
  assert.deepEqual(readJson(path.join(root, "agenthost-steve.json")), cli);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("canonical origin migration preserves ACLs when Security module autoload is broken", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boxPath = path.join(root, "box.json");
  const beforeAcl = accessFileFingerprint(boxPath);
  const applied = run(root, true, { psModulePath: brokenSecurityModulePath(root) });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(accessFileFingerprint(boxPath), beforeAcl);
  assert.equal(readJson(boxPath).origin, NEW);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("canonical origin migration reapplies exact source ACLs after Windows replacement drift", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const beforeAcls = stateAcls(root);
  const applied = run(root, true, { aclDrift: true });
  assert.equal(applied.status, 0, applied.stderr);
  for (const [name, acl] of beforeAcls) {
    assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  }
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("Windows ACL comparison tolerates only automatic-inheritance control canonicalization", () => {
  const baseline = accessFingerprint("D:P(A;;FR;;;SY)");
  assert.equal(accessFingerprint("D:PAI(A;;FR;;;SY)"), baseline);
  assert.equal(accessFingerprint("D:PAR(A;;FR;;;SY)"), baseline);
  assert.equal(accessFingerprint("D:PARAI(A;;FR;;;SY)"), baseline);
  assert.notEqual(
    accessFingerprint("D:PNO_ACCESS_CONTROL"),
    accessFingerprint("D:P"),
    "a null DACL must never compare equal to an empty DACL",
  );

  const accessChanges = [
    ["principal", "D:P(A;;FR;;;BA)"],
    ["rights", "D:P(A;;FW;;;SY)"],
    ["type", "D:P(D;;FR;;;SY)"],
    ["inheritance", "D:P(A;CI;FR;;;SY)"],
    ["propagation", "D:P(A;CINP;FR;;;SY)"],
    ["inherited state", "D:P(A;ID;FR;;;SY)"],
    ["protection", "D:(A;;FR;;;SY)"],
  ];
  for (const [label, sddl] of accessChanges) {
    assert.notEqual(accessFingerprint(sddl), baseline, `${label} must remain fail-closed`);
  }
});

windowsTest("canonical origin migration refuses an unexpected origin without changing any file", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "box.json"), JSON.stringify({ origin: "https://unexpected.example" }) + "\n");
  const before = stateBytes(root);
  const result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected origin[\s\S]*nothing was changed/i);
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
});

windowsTest("canonical origin migration validates mesh state before changing box state", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meshPath = path.join(root, "mesh.json");
  const mesh = readJson(meshPath);
  fs.writeFileSync(meshPath, JSON.stringify({ ...mesh, origin: "https://unexpected.example" }) + "\n");
  const before = stateBytes(root);
  const result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected origin[\s\S]*nothing was changed/i);
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
});

windowsTest("canonical origin migration validates the AgentGlass bridge URL before changing desktop state", (t) => {
  const { root, identity, bridgeKey } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "agenthost-steve-kanban-bridge.env"),
    `AGENTHOST_BOX_URL=https://unexpected.example\nAGENTHOST_BOX_KEY=${bridgeKey}\n`,
  );
  const before = stateBytes(root);
  const result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected origin[\s\S]*nothing was changed/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(bridgeKey));
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
});

windowsTest("a failure after Windows replacement ACL drift restores exact bytes and ACLs", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = stateBytes(root);
  const beforeAcls = stateAcls(root);
  const result = run(root, true, { failAfter: 1, aclDrift: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every changed file was rolled back[\s\S]*injected migration failure/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value));
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  for (const [name, acl] of beforeAcls) assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("an abrupt process stop leaves a durable marker that the next run recovers", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crashed = run(root, true, { crashAfter: 1 });
  assert.notEqual(crashed.status, 0);
  assert.ok(fs.existsSync(path.join(root, ".canonical-origin-migration.json")), "crash leaves recovery marker");
  assert.ok(transactionArtifacts(root).length > 0, "crash leaves the restricted transaction artifacts");

  const recovered = run(root, true);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  for (const name of ["box.json", "mesh.json", "agenthost-steve.json"]) {
    assert.equal(readJson(path.join(root, name)).origin, NEW, name);
  }
  assert.match(fs.readFileSync(path.join(root, "agenthost-steve-kanban-bridge.env"), "utf8"),
    new RegExp(`^AGENTHOST_BOX_URL=${NEW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("a crash immediately after forward File.Replace recovers from the non-secret ACL template", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = stateBytes(root);
  const beforeAcls = stateAcls(root);

  const crashed = run(root, true, { aclDrift: true, crashAfterForward: 1 });
  assert.notEqual(crashed.status, 0);
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".canonical-origin-migration.json"), "utf8"));
  for (const [name, acl] of beforeAcls) {
    const template = path.join(root, `${name}.agenthost-origin-acl-template`);
    const entry = marker.targets.find((target) => sameExistingWindowsPath(target.path, path.join(root, name)));
    assert.ok(entry, `${name} marker entry remains addressable`);
    assert.equal(fs.statSync(template).size, 32, `${name} ACL template contains only its ownership token`);
    assert.match(entry.aclTemplateSha, /^[A-F0-9]{64}$/);
    assert.equal(sha256(fs.readFileSync(template)), entry.aclTemplateSha, `${name} ACL template is owned`);
    assert.equal(accessFileFingerprint(template), acl, `${name} ACL template is exact`);
  }

  // Force the retry itself to roll back so the test can observe the exact
  // original bytes and ACLs after recovery, not only the later migration.
  const recovered = run(root, true, { aclDrift: true, failAfter: 1 });
  assert.notEqual(recovered.status, 0);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  assert.match(recovered.stderr, /every changed file was rolled back[\s\S]*injected migration failure/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(recovered.stdout + recovered.stderr, new RegExp(value));
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  for (const [name, acl] of beforeAcls) assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("a pre-existing ACL template collision is preserved byte-for-byte and fails closed", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = stateBytes(root);
  const beforeAcls = stateAcls(root);
  const template = path.join(root, "box.json.agenthost-origin-acl-template");
  const sentinel = Buffer.from("unowned-sentinel-must-not-be-read-or-deleted\n");
  fs.writeFileSync(template, sentinel);
  const sentinelAcl = accessFileFingerprint(template);

  const refused = run(root, true);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(fs.readFileSync(template), sentinel, "unowned collision bytes are preserved");
  assert.equal(accessFileFingerprint(template), sentinelAcl, "unowned collision ACL is preserved");
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  for (const [name, acl] of beforeAcls) assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  assert.equal(fs.existsSync(path.join(root, ".canonical-origin-migration.json")), false,
    "stable collision is rejected before the marker is written");
  assert.deepEqual(transactionArtifacts(root), [path.basename(template)]);
});

windowsTest("a crash after ACL template token creation cleans it when the original is untouched", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boxPath = path.join(root, "box.json");
  protectAccessRules(boxPath);
  const before = stateBytes(root);
  const beforeAcls = stateAcls(root);

  const crashed = run(root, true, { crashAfterTemplateCreate: 1 });
  assert.notEqual(crashed.status, 0);
  const template = `${boxPath}.agenthost-origin-acl-template`;
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".canonical-origin-migration.json"), "utf8"));
  const entry = marker.targets.find((target) => sameExistingWindowsPath(target.path, boxPath));
  assert.ok(entry, "box.json marker entry remains addressable");
  assert.equal(fs.statSync(template).size, 32, "crash leaves only a non-secret ownership token");
  assert.equal(sha256(fs.readFileSync(template)), entry.aclTemplateSha, "marker proves template ownership");
  assert.notEqual(accessFileFingerprint(template), beforeAcls.get("box.json"),
    "crash occurs before the source ACL is applied");

  const recovered = run(root);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(recovered.stdout + recovered.stderr, new RegExp(value));
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  for (const [name, acl] of beforeAcls) assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("a crash immediately after rollback File.Replace repairs from the surviving ACL template", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = stateBytes(root);
  const beforeAcls = stateAcls(root);

  const crashed = run(root, true, {
    aclDrift: true,
    failAfter: 1,
    crashAfterRollback: 1,
  });
  assert.notEqual(crashed.status, 0);
  const boxPath = path.join(root, "box.json");
  assert.ok(fs.existsSync(`${boxPath}.agenthost-origin-acl-template`), "rollback crash leaves ACL template");
  assert.ok(fs.existsSync(`${boxPath}.agenthost-origin-discard`), "rollback crash leaves owned discard");
  assert.equal(accessFileFingerprint(`${boxPath}.agenthost-origin-acl-template`), beforeAcls.get("box.json"));

  const recovered = run(root);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  for (const [name, acl] of beforeAcls) assert.equal(accessFileFingerprint(path.join(root, name)), acl, name);
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("recovery accepts schema-v2 markers that stored exact Windows Access SDDL", (t) => {
  const { root, identity, bridgeKey, cliPassword } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crashed = run(root, true, { crashAfter: 1 });
  assert.notEqual(crashed.status, 0);

  const markerPath = path.join(root, ".canonical-origin-migration.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.schemaVersion, 2);
  for (const entry of marker.targets) {
    assert.equal(entry.isWsl, false, "this compatibility fixture uses Windows files only");
    assert.match(entry.beforeSecurity, /^win:[PU]:(?:NULL|[A-F0-9]{64})$/, "new markers expose only a digest");
    const backup = `${entry.path}.agenthost-origin-backup`;
    entry.beforeSecurity = accessSddl(fs.existsSync(backup) ? backup : entry.path);
    delete entry.aclTemplate;
    delete entry.aclTemplateSha;
    fs.rmSync(`${entry.path}.agenthost-origin-acl-template`, { force: true });
  }
  fs.writeFileSync(markerPath, JSON.stringify(marker));

  const recovered = run(root, true);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  for (const value of [...Object.values(identity), bridgeKey, cliPassword]) {
    assert.doesNotMatch(recovered.stdout + recovered.stderr, new RegExp(value));
  }
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("recovery removes the secret-bearing discard left by a crash during rollback", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crashed = run(root, true, { crashAfter: 1 });
  assert.notEqual(crashed.status, 0);

  const boxPath = path.join(root, "box.json");
  const backupPath = `${boxPath}.agenthost-origin-backup`;
  const discardPath = `${boxPath}.agenthost-origin-discard`;
  fs.renameSync(boxPath, discardPath);
  fs.renameSync(backupPath, boxPath);
  assert.equal(readJson(boxPath).origin, OLD, "rollback destination already contains original bytes");
  assert.equal(readJson(discardPath).origin, NEW, "discard contains the secret-bearing candidate bytes");

  const recovered = run(root, true);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  assert.equal(fs.existsSync(discardPath), false, "recovery removes the owned secret-bearing discard");
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("an absent CLI state is preflighted without creation, then created with only the canonical identity", (t) => {
  const { root } = fixture({ includeCli: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cliPath = path.join(root, "agenthost-steve.json");
  const preflight = run(root);
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(fs.existsSync(cliPath), false, "preflight never creates local state");

  const applied = run(root, true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(readJson(cliPath), { app: "agenthost-steve", origin: NEW });
  assert.deepEqual(transactionArtifacts(root), []);
});

windowsTest("a crash after creating absent CLI state rolls it back before retry", (t) => {
  const { root } = fixture({ includeCli: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cliPath = path.join(root, "agenthost-steve.json");
  const crashed = run(root, true, { crashAfter: 3 });
  assert.notEqual(crashed.status, 0);
  assert.ok(fs.existsSync(cliPath), "the injected crash occurs after the new state is moved into place");

  const recovered = run(root, true);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /interrupted canonical-origin migration was rolled back before retry/i);
  assert.deepEqual(readJson(cliPath), { app: "agenthost-steve", origin: NEW });
  assert.deepEqual(transactionArtifacts(root), []);
});
