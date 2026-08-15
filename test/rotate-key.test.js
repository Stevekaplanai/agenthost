import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessKeyFingerprint, rotateKeyCommand } from "../src/commands/rotate-key.js";
import { resolveSecretInputs } from "../src/secret-input.js";
import { deployStagedSecrets, stageSecretsViaApi, validateSetSecretsResponse } from "../src/fly.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const require = createRequire(import.meta.url);
const { fingerprintAccessKey: rootFingerprintAccessKey } = require("../container/maintenance-auth-state.js");
const NEW_KEY = "new-access-key-fixture-24";
const OLD_KEY = "old-access-key-fixture-24";

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTHOST_ACCESS_KEY: undefined },
  });
}

test("rotate-key refuses secret values in argv and never echoes them", () => {
  const sentinel = "argv-access-key-must-not-echo";
  for (const args of [
    ["rotate-key", "--app", "fixture-app", "--access-key", sentinel],
    ["rotate-key", "--app", "fixture-app", `--access-key=${sentinel}`],
    ["rotate-key", "--app", "fixture-app", `--access-key-env=${sentinel}`],
    ["rotate-key", "--app", "fixture-app", "--access-key-env", sentinel],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret values.*command line|selector flags do not take command-line values/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
  }
});

test("rotate-key exposes missing-state recovery without a caller-controlled origin", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(
    help.stdout,
    /rotate-key \[--app <name>\].*\[--recover-missing-state\]/,
  );
  assert.doesNotMatch(help.stdout, /--origin/);

  const refused = runCli(["rotate-key", "--app", "fixture-app", "--origin", "https://attacker.example"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unknown option/i);
});

test("access-key input is consumed from its dedicated environment or hidden prompt", async () => {
  const env = { AGENTHOST_ACCESS_KEY: NEW_KEY, PATH: "kept" };
  const fromEnv = await resolveSecretInputs({ "access-key-env": true }, env);
  assert.equal(fromEnv["access-key"], NEW_KEY);
  assert.equal(env.AGENTHOST_ACCESS_KEY, undefined);
  assert.equal(env.PATH, "kept");

  const prompts = [];
  const fromPrompt = await resolveSecretInputs(
    { "access-key-env": true },
    {},
    async (prompt) => { prompts.push(prompt); return NEW_KEY; },
  );
  assert.equal(fromPrompt["access-key"], NEW_KEY);
  assert.deepEqual(prompts, ["Enter the new AgentHost access key (or set AGENTHOST_ACCESS_KEY)"]);
});

test("CLI and root transition helper use the exact same access-key fingerprint contract", () => {
  assert.equal(accessKeyFingerprint(OLD_KEY), rootFingerprintAccessKey(OLD_KEY));
  const helper = fs.readFileSync(path.join(ROOT, "container", "maintenance-auth-state.js"), "utf8");
  assert.match(helper, /const MAX_RETIRED_KEYS = 64;/);
});

test("Fly failure names its cause and leaves local state unchanged", async () => {
  let saved = false;
  await assert.rejects(
    () => rotateKeyCommand(
      { app: "fixture-app", "access-key": NEW_KEY },
      {
        loadState: () => ({ ttydPassword: OLD_KEY }),
        stageSecrets: async () => {},
        deployStagedSecrets: () => ({ code: 1, stderr: `release failed near ${NEW_KEY}` }),
        saveState: () => { saved = true; },
      },
    ),
    (error) => {
      assert.match(error.message, /release failed/);
      assert.match(error.message, /local saved key was not changed/i);
      assert.doesNotMatch(error.message, new RegExp(NEW_KEY));
      return true;
    },
  );
  assert.equal(saved, false);
});

test("an unconfirmed Fly API stage stops before deploy or local save", async () => {
  for (const [status, body] of [
    [401, { error: `unauthorized near ${NEW_KEY}` }],
    [200, { data: { setSecrets: null } }],
  ]) {
    const calls = [];
    let state = { ttydPassword: OLD_KEY };
    await assert.rejects(
      () => rotateKeyCommand(
        { app: "fixture-app", "access-key": NEW_KEY },
        {
          loadState: () => structuredClone(state),
          stageSecrets: async (app, secrets) => {
            calls.push("stage");
            validateSetSecretsResponse(app, status, JSON.stringify(body), Object.values(secrets));
          },
          deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
          saveState: (_app, update) => { calls.push("save"); state = { ...state, ...update }; },
        },
      ),
      (error) => {
        assert.match(error.message, /Fly could not stage the new access key/i);
        assert.match(error.message, status === 401 ? /HTTP 401.*unauthorized/i : /did not confirm setSecrets/i);
        assert.match(error.message, /Local saved key was not changed/i);
        assert.doesNotMatch(error.message, new RegExp(NEW_KEY));
        return true;
      },
    );
    assert.deepEqual(calls, ["stage"]);
    assert.deepEqual(state, { ttydPassword: OLD_KEY });
  }
});

test("an interrupted Fly API response rejects rotation before deploy or local save", async () => {
  const calls = [];
  let state = { ttydPassword: OLD_KEY };
  const request = (_url, _options, onResponse) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = (error) => outgoing.emit("error", error);
    outgoing.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      response.emit("data", Buffer.from('{"data":'));
      response.emit("aborted");
      response.emit("error", new Error(`socket reset near ${NEW_KEY}`));
      response.emit("close");
    };
    return outgoing;
  };

  await assert.rejects(
    () => rotateKeyCommand(
      { app: "fixture-app", "access-key": NEW_KEY },
      {
        loadState: () => structuredClone(state),
        stageSecrets: async (app, secrets) => {
          calls.push("stage");
          await stageSecretsViaApi(app, secrets, {
            getAuthToken: () => "fly-token-fixture",
            request,
          });
        },
        deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
        saveState: (_app, update) => { calls.push("save"); state = { ...state, ...update }; },
      },
    ),
    (error) => {
      assert.match(error.message, /response was aborted before completion/i);
      assert.match(error.message, /Local saved key was not changed/i);
      assert.doesNotMatch(error.message, new RegExp(NEW_KEY));
      return true;
    },
  );
  assert.deepEqual(calls, ["stage"]);
  assert.deepEqual(state, { ttydPassword: OLD_KEY });
});

test("an oversized UTF-8 key fails before any Fly or local-state call", async () => {
  const calls = [];
  await assert.rejects(
    () => rotateKeyCommand(
      { app: "fixture-app", "access-key": "🔐".repeat(65) },
      {
        loadState: () => ({ ttydPassword: OLD_KEY }),
        stageSecrets: async () => { calls.push("stage"); },
        deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
        saveState: () => { calls.push("save"); },
      },
    ),
    /at most 256 UTF-8 bytes/i,
  );
  assert.deepEqual(calls, []);
});

test("an untypeable control character fails before Fly or a local-state write", async () => {
  for (const accessKey of [`${NEW_KEY}\nunsafe`, `${NEW_KEY}\u007f`]) {
    const calls = [];
    await assert.rejects(
      () => rotateKeyCommand(
        { app: "fixture-app", "access-key": accessKey },
        {
          loadState: () => ({ ttydPassword: OLD_KEY }),
          stageSecrets: async () => { calls.push("stage"); },
          deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
          saveState: () => { calls.push("save"); },
        },
      ),
      /cannot contain control characters or line breaks/i,
    );
    assert.deepEqual(calls, []);
  }
});

test("reusing the saved key fails before Fly because it cannot clear rotation-required", async () => {
  const calls = [];
  await assert.rejects(
    () => rotateKeyCommand(
      { app: "fixture-app", "access-key": OLD_KEY },
      {
        loadState: () => ({ ttydPassword: OLD_KEY }),
        stageSecrets: async () => { calls.push("stage"); },
        deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
        saveState: () => { calls.push("save"); },
      },
    ),
    /matches the saved key; choose a different key/i,
  );
  assert.deepEqual(calls, []);
});

test("A to B to C permanently rejects retired A before Fly or local mutation", async () => {
  let state = { app: "fixture-app", ttydPassword: "access-key-A-fixture" };
  const calls = [];
  const dependencies = {
    loadState: () => structuredClone(state),
    stageSecrets: async () => { calls.push("stage"); },
    deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
    saveState: (_app, update) => { calls.push("save"); state = { ...state, ...update }; },
    log: () => {},
  };

  await rotateKeyCommand({ app: "fixture-app", "access-key": "access-key-B-fixture" }, dependencies);
  await rotateKeyCommand({ app: "fixture-app", "access-key": "access-key-C-fixture" }, dependencies);
  assert.deepEqual(state.retiredAccessKeyFingerprints, [
    accessKeyFingerprint("access-key-A-fixture"),
    accessKeyFingerprint("access-key-B-fixture"),
  ]);
  assert.doesNotMatch(JSON.stringify(state.retiredAccessKeyFingerprints), /access-key-[AB]-fixture/);

  calls.length = 0;
  const before = structuredClone(state);
  await assert.rejects(
    () => rotateKeyCommand({ app: "fixture-app", "access-key": "access-key-A-fixture" }, dependencies),
    /previously retired.*never been used/i,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(state, before);
});

test("corrupt retired-key history fails closed before Fly or local mutation", async () => {
  const valid = accessKeyFingerprint("retired-fixture");
  for (const retiredAccessKeyFingerprints of [
    null,
    "not-an-array",
    ["not-a-fingerprint"],
    [valid, valid],
    [accessKeyFingerprint(OLD_KEY)],
  ]) {
    const calls = [];
    await assert.rejects(
      () => rotateKeyCommand(
        { app: "fixture-app", "access-key": NEW_KEY },
        {
          loadState: () => ({ ttydPassword: OLD_KEY, retiredAccessKeyFingerprints }),
          stageSecrets: async () => { calls.push("stage"); },
          deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
          saveState: () => { calls.push("save"); },
        },
      ),
      /saved retired access-key history is invalid/i,
    );
    assert.deepEqual(calls, []);
  }
});

test("full retired-key history fails closed and never evicts an older fingerprint", async () => {
  const history = Array.from({ length: 64 }, (_, index) => accessKeyFingerprint(`retired-key-${index}`));
  const calls = [];
  await assert.rejects(
    () => rotateKeyCommand(
      { app: "fixture-app", "access-key": NEW_KEY },
      {
        loadState: () => ({ ttydPassword: OLD_KEY, retiredAccessKeyFingerprints: history }),
        stageSecrets: async () => { calls.push("stage"); },
        deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
        saveState: () => { calls.push("save"); },
      },
    ),
    /history is full; refusing to forget an older key/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(history.length, 64);
});

test("missing trusted local key fails closed before cross-machine rotation", async () => {
  for (const existing of [null, { app: "fixture-app" }]) {
    const calls = [];
    await assert.rejects(
      () => rotateKeyCommand(
        { app: "fixture-app", "access-key": NEW_KEY },
        {
          loadState: () => existing,
          stageSecrets: async () => { calls.push("stage"); },
          deployStagedSecrets: () => { calls.push("deploy"); return { code: 0 }; },
          saveState: () => { calls.push("save"); },
        },
      ),
      /no trusted saved access key.*machine that deployed this box/i,
    );
    assert.deepEqual(calls, []);
  }
});

test("success applies one staged-secret release, saves afterward, and never outputs the value", async () => {
  const calls = [];
  const output = [];
  let saved;
  const result = await rotateKeyCommand(
    { app: "fixture-app", "access-key": NEW_KEY },
    {
      loadState: () => ({ ttydPassword: OLD_KEY }),
      stageSecrets: async (app, secrets) => {
        calls.push("stage");
        assert.equal(app, "fixture-app");
        assert.deepEqual(secrets, { TTYD_PASSWORD: NEW_KEY });
      },
      deployStagedSecrets: (app) => {
        calls.push("deploy");
        assert.equal(app, "fixture-app");
        return { code: 0, stdout: "release complete", stderr: "" };
      },
      saveState: (app, state) => {
        calls.push("save");
        saved = { app, state };
      },
      log: (line) => output.push(line),
    },
  );
  assert.deepEqual(result, { app: "fixture-app" });
  assert.deepEqual(calls, ["stage", "deploy", "save"]);
  assert.deepEqual(saved, {
    app: "fixture-app",
    state: {
      ttydPassword: NEW_KEY,
      retiredAccessKeyFingerprints: [accessKeyFingerprint(OLD_KEY)],
    },
  });
  assert.doesNotMatch(output.join("\n"), new RegExp(NEW_KEY));
});

test("rotation preserves parser-sensitive values through the JSON staging boundary", async () => {
  for (const accessKey of [
    " access-key-leading-space",
    "access-key#not-a-comment",
    'access-key-with-"quotes"',
  ]) {
    let staged;
    await rotateKeyCommand(
      { app: "fixture-app", "access-key": accessKey },
      {
        loadState: () => ({ ttydPassword: OLD_KEY }),
        stageSecrets: async (app, secrets) => { staged = { app, secrets }; },
        deployStagedSecrets: () => ({ code: 0 }),
        saveState: () => {},
        log: () => {},
      },
    );
    assert.deepEqual(staged, { app: "fixture-app", secrets: { TTYD_PASSWORD: accessKey } });
  }
});

test("the apply step uses Fly's supported staged-secret deploy once", () => {
  const calls = [];
  const result = deployStagedSecrets("fixture-app", (args) => {
    calls.push(args);
    return { code: 0, stdout: "release complete", stderr: "" };
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [["secrets", "deploy", "-a", "fixture-app"]]);
});

test("the saved rotated key is the value an ordinary deploy stages next", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-rotate-state-"));
  try {
    const script = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { updateAppState, loadAppState } from './src/state.js';",
      `updateAppState('fixture-app', { org: 'fixture-org', ttydPassword: ${JSON.stringify(OLD_KEY)} });`,
      `updateAppState('fixture-app', { ttydPassword: ${JSON.stringify(NEW_KEY)}, retiredAccessKeyFingerprints: [${JSON.stringify(accessKeyFingerprint(OLD_KEY))}] });`,
      "const saved = loadAppState('fixture-app');",
      `if (saved.ttydPassword !== ${JSON.stringify(NEW_KEY)} || saved.org !== 'fixture-org' || saved.retiredAccessKeyFingerprints[0] !== ${JSON.stringify(accessKeyFingerprint(OLD_KEY))}) process.exit(2);`,
      "const files = fs.readdirSync(path.join(process.env.HOME, '.agenthost'));",
      "if (files.some((name) => name.endsWith('.tmp'))) process.exit(3);",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const deploySource = fs.readFileSync(path.join(ROOT, "src", "commands", "deploy.js"), "utf8");
  assert.match(deploySource, /let ttydPassword = existing\?\.ttydPassword/);
  assert.match(deploySource, /TTYD_PASSWORD:\s*ttydPassword/);
});

test("post-rename fsync failure reports the installed record and forbids a same-key retry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-state-fsync-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { rotateKeyCommand, accessKeyFingerprint } from './src/commands/rotate-key.js';",
    "import { updateAppState, loadAppState, appStatePath } from './src/state.js';",
    "const parent = path.join(process.env.HOME, '.agenthost');",
    `const oldKey = ${JSON.stringify(OLD_KEY)}, newKey = ${JSON.stringify(NEW_KEY)};`,
    "updateAppState('fixture-app', { ttydPassword: oldKey });",
    "const realOpen = fs.openSync, realFsync = fs.fsyncSync, realClose = fs.closeSync;",
    "let parentFd, parentClosed = false;",
    "fs.openSync = (target, ...args) => { const fd = realOpen(target, ...args); if (target === parent) parentFd = fd; return fd; };",
    "fs.fsyncSync = (fd) => { if (fd === parentFd) { const error = new Error('injected parent fsync failure'); error.code = 'EIO'; throw error; } return realFsync(fd); };",
    "fs.closeSync = (fd) => { if (fd === parentFd) parentClosed = true; return realClose(fd); };",
    "let message = '';",
    "try { await rotateKeyCommand({ app: 'fixture-app', 'access-key': newKey }, { stageSecrets: async () => {}, deployStagedSecrets: () => ({ code: 0 }), log: () => {} }); } catch (error) { message = error.message; }",
    "fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.closeSync = realClose;",
    "const saved = loadAppState('fixture-app');",
    "const exact = saved.ttydPassword === newKey && saved.retiredAccessKeyFingerprints.length === 1 && saved.retiredAccessKeyFingerprints[0] === accessKeyFingerprint(oldKey);",
    "const named = message.includes(\"Fly applied the new access key for 'fixture-app', and the local record contains it\") && message.includes('crash-safe durability could not be confirmed because injected parent fsync failure') && message.includes('Do not run rotate-key again') && message.includes(`copy '${appStatePath('fixture-app')}' to a safe local location`);",
    "if (!exact || !named || message.includes(newKey) || !parentClosed) process.exit(2);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
