"use strict";
// Behavioural tests for the visual QA agent.
//
// These INJECT a fake chromium and a real temp filesystem rather than mocking the
// filesystem too. That is deliberate: on 2026-08-09 nine passing tests described a
// classifier that had never worked in production, because every mock was more
// cooperative than the real thing. The fixture here is allowed to FAIL the way the
// real one fails -- chromium exiting non-zero, chromium exiting 0 without writing a
// file, chromium refusing to start at all -- and each of those is asserted.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// container/*.js are CommonJS; Node ESM gives us their module.exports as default.
import qa from "../container/qa-agent.js";
import qaSandbox from "../container/qa-sandbox.js";

// __dirname does not exist in ESM.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-test-"));
}

const CONFIG = {
  baseUrl: "http://127.0.0.1:8080",
  viewports: [{ name: "phone", width: 390, height: 844 }],
  routes: [{ path: "/brand.json", name: "brand" }],
};

// A fake chromium that writes the bytes it is told to write.
function fakeChromium(bytesByCall) {
  let call = 0;
  return (bin, args) => {
    const out = args.find((a) => a.startsWith("--screenshot=")).slice("--screenshot=".length);
    const bytes = bytesByCall[Math.min(call, bytesByCall.length - 1)];
    call += 1;
    if (bytes === null) return { status: 1, stderr: "chromium: cannot open display\n" };
    fs.writeFileSync(out, bytes);
    // Real chromium emits dbus/gcm noise on stderr even when it succeeds. If the
    // code ever treats stderr as failure this fixture catches it.
    return { status: 0, stderr: "ERROR:dbus/bus.cc(405) Failed to connect to the bus\n" };
  };
}

test("first run adopts a baseline and says so, rather than reporting a clean compare", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(CONFIG, { run: fakeChromium(["PNGDATA-A"]), rootDir, stamp: "1" });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].status, "baseline_created");
    assert.equal(r.changedCount, 0);
    assert.match(r.summary, /baseline created/);
    assert.ok(fs.existsSync(path.join(rootDir, "brand", "phone", "baseline.png")), "baseline written");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("identical bytes report unchanged WITHOUT calling vision", () => {
  const rootDir = tmpRoot();
  try {
    qa.runQaPass(CONFIG, { run: fakeChromium(["SAME"]), rootDir, stamp: "1" });
    const r = qa.runQaPass(CONFIG, { run: fakeChromium(["SAME"]), rootDir, stamp: "2" });
    assert.equal(r.results[0].status, "unchanged");
    assert.equal(r.changedCount, 0);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("different bytes report changed and carry both artifact paths as evidence", () => {
  const rootDir = tmpRoot();
  try {
    qa.runQaPass(CONFIG, { run: fakeChromium(["ORIGINAL"]), rootDir, stamp: "1" });
    const r = qa.runQaPass(CONFIG, { run: fakeChromium(["MUTATED"]), rootDir, stamp: "2" });
    assert.equal(r.results[0].status, "changed");
    assert.equal(r.changedCount, 1);
    assert.ok(fs.existsSync(r.results[0].baseline), "baseline path resolves to a real file");
    assert.ok(fs.existsSync(r.results[0].current), "current path resolves to a real file");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("a non-zero chromium exit is reported with its stderr, not as a clean pass", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(CONFIG, { run: fakeChromium([null]), rootDir, stamp: "1" });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /chromium exited 1/);
    assert.match(r.results[0].detail, /cannot open display/, "the real cause survives into the report");
    assert.equal(r.failedCount, 1);
    assert.match(r.summary, /1 failed \(chromium exited 1/, "the summary names the cause, not just a count");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("chromium exiting 0 without writing a file is a failure, not a success", () => {
  const rootDir = tmpRoot();
  try {
    const liar = () => ({ status: 0, stderr: "" });   // exits clean, writes nothing
    const r = qa.runQaPass(CONFIG, { run: liar, rootDir, stamp: "1" });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /exited 0 but wrote no file/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("chromium missing entirely is named, not swallowed", () => {
  const rootDir = tmpRoot();
  try {
    const absent = () => { throw new Error("spawnSync chromium ENOENT"); };
    const r = qa.runQaPass(CONFIG, { run: absent, rootDir, stamp: "1" });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /ENOENT/, "the OS error reaches the operator");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("old screenshots are pruned but the baseline never is", () => {
  const rootDir = tmpRoot();
  try {
    for (let i = 0; i < qa.KEEP_PER_TARGET + 4; i++) {
      qa.runQaPass(CONFIG, { run: fakeChromium(["SHOT" + i]), rootDir, stamp: String(1000 + i) });
    }
    const dir = path.join(rootDir, "brand", "phone");
    const names = fs.readdirSync(dir);
    const shots = names.filter((n) => n.startsWith("current-"));
    assert.ok(shots.length <= qa.KEEP_PER_TARGET, "kept " + shots.length + ", cap is " + qa.KEEP_PER_TARGET);
    assert.ok(names.includes("baseline.png"), "baseline survives pruning");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("every viewport and route is captured, and the phone viewport is first", () => {
  const rootDir = tmpRoot();
  try {
    const cfg = {
      baseUrl: "http://127.0.0.1:8080",
      viewports: [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }],
      routes: [{ path: "/a", name: "a" }, { path: "/b", name: "b" }],
    };
    const r = qa.runQaPass(cfg, { run: fakeChromium(["X"]), rootDir, stamp: "1" });
    assert.equal(r.results.length, 4, "2 routes x 2 viewports");
    assert.equal(r.results[0].target, "a@phone", "phone is captured first -- the phone view IS the product");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("the shipped qa-routes.json is valid, and every walled route is DECLARED walled", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "container", "qa-routes.json"), "utf8"));
  assert.ok(Array.isArray(cfg.routes) && cfg.routes.length > 0, "routes configured");
  assert.ok(Array.isArray(cfg.viewports) && cfg.viewports.length >= 3, "three viewports");
  assert.equal(cfg.viewports[0].width, 390, "phone first");
  assert.ok(!cfg.routes.some((route) => route.path === "/cc/legacy"), "removed recovery HTML must not remain a QA target");

  // THIS ASSERTION USED TO READ "only lists routes reachable without a session",
  // and it was right for as long as QA had no way to hold one: an authenticated
  // route would have photographed the login wall, adopted THAT as its baseline,
  // and compared clean forever while catching nothing.
  //
  // The QA render token (gate.js, mintQaRenderToken) removed that constraint, so
  // the assertion becomes the stronger invariant rather than disappearing. The
  // danger it guarded never went away -- it just moved. A walled route that is
  // not DECLARED walled gets no token, silently captures the login wall, and
  // reintroduces the poisoned baseline through the config instead of the code.
  const walled = new Set(["/", "/audit", "/2fa"]);
  for (const route of cfg.routes) {
    // The only unflagged "/" allowed is the deliberate capture of the login wall
    // itself, which is a real page worth a baseline and is named for what it is.
    if (route.path === "/" && !route.auth) {
      assert.equal(route.name, "login", 'an unflagged "/" is the login wall and must be named so');
      continue;
    }
    if (walled.has(route.path)) {
      assert.equal(route.auth, true, route.path + " sits behind the login wall and must declare auth:true");
    }
  }
  // And the retired standalone app paths answer 410 now, so they are not targets.
  for (const route of cfg.routes) {
    assert.ok(!/^\/(cc|desk|board|kanban|chat|settings)$/.test(route.path),
      route.path + " is a retired standalone route (410); the workspace is served at /");
  }
});

test("the QA runner is IN the image, and its own docs point where it lands", () => {
  // N3 shipped 100% dead and stayed that way through a merge and a deploy.
  //
  // `qa-agent.js` and `qa-routes.json` were COPYd; the RUNNER that invokes them
  // was written to the repo-root `scripts/` -- OUTSIDE this Dockerfile's build
  // context (`container/`) -- so no COPY line could ever have worked, and none was
  // written. Nothing else on the box called the module either. The Dockerfile
  // comment even NAMED `scripts/run-qa.sh` as the thing that breaks without a
  // COPY, which is the tell that was missed.
  //
  // This asserts the same thing cursor-engine.test.js and
  // channel-delivery-limiter.test.js assert for their own files. That convention
  // existed; N3 simply did not follow it.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const root = path.join(here, "..");
  const dockerfile = fs.readFileSync(path.join(root, "container", "Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY run-qa\.sh \/opt\/agenthost\/run-qa\.sh/,
    "the runner must be COPYd or the QA agent is unreachable no matter how good it is");

  // It must actually exist in the build context. A COPY of a missing file fails
  // the build, but the failure would be a docker error at deploy time rather than
  // a test failure here, and this repo deploys from a script that has lied before.
  assert.ok(fs.existsSync(path.join(root, "container", "run-qa.sh")),
    "run-qa.sh must live in container/ -- the Dockerfile build context");

  // And the invocation the script documents must match where the COPY puts it.
  // The original said `bash scripts/run-qa.sh`, which was wrong in the image even
  // if the COPY had existed: doc drift is how a reachable thing becomes unreachable
  // in practice.
  const runner = fs.readFileSync(path.join(root, "container", "run-qa.sh"), "utf8");
  assert.doesNotMatch(runner, /bash scripts\/run-qa\.sh/,
    "the documented command must match the path the Dockerfile installs it to");
  for (const file of ["qa-sandbox.js", "qa-runner.sh", "qa-sandbox-linux.test.js"]) {
    assert.match(dockerfile, new RegExp("COPY " + file.replace(".", "\\.") + " /opt/agenthost/" + file.replace(".", "\\.")),
      file + " must ship in the image or the jail path is dead");
  }
  assert.match(runner, /qa-sandbox\.js/, "every gate QA pass enters through the trusted sandbox launcher");
  assert.match(runner, /public POST \/qa\/run or the root-only agenthost-qa command/,
    "direct/manual invocation must name both supported lane-reserving triggers and refuse");
  assert.doesNotMatch(runner, /^exec .*qa-runner\.sh/m,
    "the public runner must never invoke the inner runner outside Bubblewrap");

  const releaseProof = fs.readFileSync(path.join(root, "container", "qa-sandbox-release-verify.sh"), "utf8");
  assert.match(releaseProof, /--security-opt seccomp=unconfined/,
    "the release-image proof must allow the user namespace Docker blocks but Fly permits");
  assert.match(releaseProof, /--reuid=gate --regid=gate --init-groups --no-new-privs/,
    "the release-image proof must reproduce the exact production gate privilege drop");
  assert.match(releaseProof, /node --test \/opt\/agenthost\/qa-sandbox-linux\.test\.js/,
    "the gate+NNP invocation must execute the proof copied into the final image");
});

test("the whole QA pass is composed as one fail-closed Bubblewrap allowlist jail", () => {
  let options = null;
  const command = qaSandbox.buildQaSandboxCommand("/tmp/staged-qa", ["--force", "--gate-authoritative", "--token-stdin"], {
    env: { USER: "gate", QA_SETTLE_MS: "1234", GIT_PUSH_TOKEN: "never-cross" },
    buildBwrapReadJail: (bin, args, opts) => {
      options = { bin, args, opts };
      return { bin: "/usr/bin/bwrap", args: ["sandbox"] };
    },
  });
  assert.equal(command.bin, "/usr/bin/bwrap");
  assert.deepEqual(options, {
    bin: "/bin/bash",
    args: ["/opt/qa/qa-runner.sh", "--force", "--gate-authoritative", "--token-stdin"],
    opts: {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", TMPDIR: "/tmp",
        USER: "gate", LOGNAME: "gate", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
        QA_CONFIG_PATH: "/opt/qa/qa-routes.json", QA_ROOT: "/qa-output",
        QA_GATE: "http://127.0.0.1:8080", QA_SETTLE_MS: "1234",
      },
      roBindsAt: [
        { src: "/tmp/staged-qa", dest: "/opt/qa" },
        { src: "/etc/fonts", dest: "/etc/fonts" },
        { src: "/etc/chromium.d", dest: "/etc/chromium.d" },
      ],
      requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/qa-output" }],
      closeFds: [3],
    },
  });
  assert.equal(Object.hasOwn(options.opts.env, "GIT_PUSH_TOKEN"), false);
  assert.equal(Object.hasOwn(options.opts.env, "QA_RENDER_TOKEN"), false,
    "the short-lived render token crosses stdin, never Bubblewrap argv/env");
  assert.throws(() => qaSandbox.buildQaSandboxCommand("/tmp/stage", [], {
    buildBwrapReadJail: () => ({ bin: "/usr/bin/false", args: [] }),
  }), /could not be constructed/);
});

test("only the gate's exact invocation can select protected QA evidence", () => {
  assert.equal(qaSandbox.outputRootFor(["--force", "--gate-authoritative", "--token-stdin"]),
    "/data/agenthost-gate-state/qa/evidence");
  assert.throws(() => qaSandbox.outputRootFor(["--force"]), /public POST \/qa\/run or root-only agenthost-qa/);
  assert.throws(() => qaSandbox.outputRootFor([]), /public POST \/qa\/run or root-only agenthost-qa/);
  const entrypoint = fs.readFileSync(path.join(HERE, "..", "container", "entrypoint.sh"), "utf8");
  assert.match(entrypoint, /QA_EVIDENCE_DIR="\$QA_RESULT_DIR\/evidence"/);
  assert.match(entrypoint, /"\$QA_RESULT_DIR" "\$QA_EVIDENCE_DIR"[\s\S]{0,500}install -d -o "\$artifact_review_owner"[\s\S]{0,100}-m 0700/,
    "boot creates authoritative evidence under the protected owner/mode loop");
});

test("the output mount is an opened directory inode, never an agent-swappable pathname", () => {
  const root = tmpRoot();
  const moved = root + "-moved";
  let pin = null;
  try {
    const approved = fs.statSync(root);
    pin = qaSandbox.pinOutputDirectory(root);
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    const pinned = fs.fstatSync(pin.fd);
    assert.equal(pinned.ino, approved.ino, "the descriptor still names the approved inode after pathname replacement");
    assert.notEqual(pinned.ino, fs.statSync(root).ino, "the replacement pathname is not what Bubblewrap receives");
  } finally {
    if (pin) fs.closeSync(pin.fd);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
  }
});

test("a missing Bubblewrap jail fails before any browser or runner can start", () => {
  const root = tmpRoot();
  const inputRoot = tmpRoot();
  const files = ["qa-agent.js", "qa-routes.json", "qa-runner.sh"].map((name) => {
    const source = path.join(inputRoot, name);
    fs.writeFileSync(source, name);
    return { source, name, maxBytes: 1024 };
  });
  let spawned = 0;
  try {
    assert.throws(() => qaSandbox.runQaSandbox({ outputRoot: root, files }, {
      requireRootOwner: false,
      buildBwrapReadJail: () => ({ bin: "/usr/bin/false", args: [] }),
      spawnSync: () => { spawned += 1; return { status: 0 }; },
    }), /Bubblewrap QA jail could not be constructed/);
    assert.equal(spawned, 0, "there is no unsandboxed retry when Bubblewrap is unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(inputRoot, { recursive: true, force: true });
  }
});

test("the gate-only QA runner consumes exactly one token line", () => {
  const runner = fs.readFileSync(path.join(HERE, "..", "container", "qa-runner.sh"), "utf8");
  assert.match(runner, /--token-stdin\) TOKEN_STDIN=1/);
  assert.match(runner, /IFS= read -r QA_RENDER_TOKEN/,
    "the exact gate invocation reads its pass-scoped token from stdin");
  assert.doesNotMatch(runner, /export QA_RENDER_TOKEN|process\.env\.QA_RENDER_TOKEN/,
    "the token crosses a second fixed stdin pipe and never enters Node's environment");
  assert.match(runner, /fs\.readFileSync\(0, "utf8"\)/,
    "the jailed QA Node process receives the token only from stdin");
  assert.doesNotMatch(runner, /curl[\s\S]*\/cc\/state/,
    "the inner runner never performs an unauthenticated lane probe");
});

test("a capture that wrote nothing names the DIRECTORY when that is the reason", () => {
  // Live on 2026-08-10: every capture on the box reported
  //   capture_failed  brand@phone -- chromium exited 0 but wrote no file
  // and chromium was blameless. The output ROOT was /data/qa-screenshots; /data is
  // root-owned, the agent's mkdir returned "Permission denied", and chromium handed
  // a path under a directory that cannot exist writes nothing and STILL EXITS 0.
  // The same command against /tmp wrote 5588 bytes.
  //
  // Six identical lines pointed at the browser. The fix was one path. That is the
  // whole reason this branch has to distinguish the two.
  const missingDir = path.join(os.tmpdir(), "qa-does-not-exist-" + Date.now(), "shot.png");
  const r = qa.captureOne("http://127.0.0.1:8080/brand.json", { name: "phone", width: 390, height: 844 },
    missingDir, { run: () => ({ status: 0, stdout: "", stderr: "" }) });

  assert.equal(r.ok, false);
  assert.match(r.error, /output directory does not exist/,
    "when the directory is the reason, say so -- do not blame the browser");
  assert.match(r.error, /qa-does-not-exist-/, "and name the actual path, so the fix is obvious");

  // And when the directory IS fine, the message must not pretend otherwise -- a
  // real browser failure has to stay diagnosable as a browser failure.
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-ok-"));
  const r2 = qa.captureOne("http://127.0.0.1:8080/brand.json", { name: "phone", width: 390, height: 844 },
    path.join(okDir, "shot.png"), { run: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /this one really is the browser/,
    "a writable directory means the browser really did fail, and the message must say that");
  fs.rmSync(okDir, { recursive: true, force: true });
});

test("every capture gets its own writable profile directory, and gives it back", () => {
  // THE BUG THIS LOCKS DOWN, reproduced on the live box 2026-08-11.
  //
  // POST /qa/run spawns run-qa.sh as user `gate` (uid 997) with HOME pointed at
  // the AGENT's home -- agent-owned 0755, which gate cannot write. Headless
  // Chromium derives its user-data directory from $HOME, so it died before
  // loading a page:
  //
  //   ERROR:chrome/app/chrome_main.cc:207] Failed to create a unique user data
  //   directory for headless.                                  (exit 1)
  //
  // Every by-hand check said chromium was healthy, because every by-hand check
  // ran as `agent`, for whom $HOME IS writable. The capture must not depend on
  // which user happens to invoke it.
  const seen = [];
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-profile-"));
  const outFile = path.join(okDir, "shot.png");
  try {
    const r = qa.captureOne("http://127.0.0.1:8080/brand.json", { name: "phone", width: 390, height: 844 },
      outFile, {
        run: (bin, args) => {
          const flag = args.find((a) => a.startsWith("--user-data-dir="));
          assert.ok(flag, "chromium must be told where its profile goes, never left to guess from $HOME");
          const dir = flag.slice("--user-data-dir=".length);
          seen.push(dir);
          // The directory has to be real and writable AT THE MOMENT chromium runs.
          // Passing a path that does not exist yet reproduces the same failure with
          // a different error, so assert the property, not the flag.
          assert.ok(fs.existsSync(dir), "the profile directory must exist before chromium starts");
          fs.accessSync(dir, fs.constants.W_OK);
          // THE PROPERTY THAT ACTUALLY FAILED, stated directly. A test process runs
          // as a user whose own $HOME is writable, so it can never reproduce uid
          // 997 against an agent-owned home -- a $HOME-derived profile would look
          // perfectly healthy here. What CAN be asserted from any user is where the
          // profile comes FROM: the OS temp dir, which every user on the box can
          // write, rather than whatever Chromium derives from $HOME.
          //
          // Asserted as "under tmpdir" and NOT as "outside $HOME", because on
          // Windows os.tmpdir() is C:\Users\<user>\AppData\Local\Temp -- inside the
          // home directory. An outside-$HOME assertion passes on the Linux box and
          // fails on the Windows dev machine while the code is correct on both,
          // which would make this test a liar about the thing it exists to protect.
          assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
            "the profile must come from the OS temp dir, never from $HOME -- that dependency is precisely what broke the gate-spawned pass");
          fs.writeFileSync(outFile, "PNG");
          return { status: 0, stdout: "", stderr: "" };
        },
      });

    assert.equal(r.ok, true, "a capture with a writable profile succeeds");
    assert.equal(seen.length, 1);
    assert.equal(fs.existsSync(seen[0]), false,
      "and the profile is removed afterwards -- a pass is route x viewport captures, and a leaked ~50 MB profile each is how a volume fills quietly");

    // Two captures never share a profile: a stale lock from a previous capture is
    // the other half of this failure class.
    const second = qa.captureOne("http://127.0.0.1:8080/brand.json", { name: "phone", width: 390, height: 844 },
      outFile, {
        run: (bin, args) => {
          seen.push(args.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length));
          fs.writeFileSync(outFile, "PNG");
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    assert.equal(second.ok, true);
    assert.notEqual(seen[0], seen[1], "each capture gets a fresh profile, never a reused one");
  } finally {
    fs.rmSync(okDir, { recursive: true, force: true });
  }
});

// ---- Authenticated routes and the QA render token ---------------------------

const AUTH_CONFIG = {
  baseUrl: "http://127.0.0.1:8080",
  viewports: [{ name: "phone", width: 390, height: 844 }],
  routes: [{ path: "/", name: "workspace", auth: true }],
};

const okProbe = () => ({ ok: true, code: 200 });

test("the render token is never appended to a capture URL", () => {
  const open = { path: "/brand.json", name: "brand" };
  const walled = { path: "/", name: "workspace", auth: true };
  assert.equal(qa.captureUrl("https://x.test", open, "TOK"), "https://x.test/brand.json");
  assert.equal(qa.captureUrl("https://x.test", walled, "TOK"), "https://x.test/");
  // A route-owned query remains byte-for-byte; the credential is not added.
  assert.equal(
    qa.captureUrl("https://x.test", { path: "/a?b=1", name: "q", auth: true }, "TOK"),
    "https://x.test/a?b=1",
  );
});

test("curl and Chromium receive the QA token only through private 0600 config files", () => {
  const token = "qa-token-canary-never-process-metadata";
  let curlConfig = "";
  let curlArgs = [];
  let curlEnv = {};
  const probed = qa.defaultProbe("http://127.0.0.1:8080/", token, {
    run: (_bin, args, options) => {
      curlArgs = args;
      curlEnv = options.env;
      curlConfig = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");
      if (process.platform !== "win32") assert.equal(fs.statSync(args[args.indexOf("--config") + 1]).mode & 0o777, 0o600);
      return { status: 0, stdout: "200", stderr: "" };
    },
  });
  assert.deepEqual(probed, { ok: true, code: 200 });
  assert.match(curlConfig, new RegExp(qa.QA_RENDER_HEADER + ": " + token));
  assert.equal(curlArgs.some((value) => String(value).includes(token)), false, "curl argv contains no token");
  assert.equal(Object.values(curlEnv).some((value) => String(value).includes(token)), false, "curl env contains no token");

  const root = tmpRoot();
  const out = path.join(root, "shot.png");
  let chromiumArgs = [];
  let chromiumEnv = {};
  let rules = [];
  let manifest = null;
  try {
    const result = qa.captureOne("http://127.0.0.1:8080/", { name: "phone", width: 390, height: 844 }, out, {
      masks: ["[data-qa-dynamic=team-thread]"],
      renderToken: token,
      run: (_bin, args, options) => {
        chromiumArgs = args;
        chromiumEnv = options.env;
        const extensionDir = args.find((arg) => arg.startsWith("--load-extension=")).slice("--load-extension=".length);
        manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
        rules = JSON.parse(fs.readFileSync(path.join(extensionDir, "rules.json"), "utf8"));
        if (process.platform !== "win32") assert.equal(fs.statSync(path.join(extensionDir, "rules.json")).mode & 0o777, 0o600);
        fs.writeFileSync(out, "PIXELS");
        return { status: 0, stderr: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(chromiumArgs.some((value) => String(value).includes(token)), false, "Chromium argv contains no token");
    assert.equal(Object.values(chromiumEnv).some((value) => String(value).includes(token)), false, "Chromium env contains no token");
    assert.equal(chromiumArgs.at(-1), "http://127.0.0.1:8080/", "the page URL contains no token or auth query");
    assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"], "the extension permission omits the test port as Chrome match patterns require");
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((rule) => rule.condition.resourceTypes), [
      ["main_frame"], ["script", "stylesheet", "font", "image", "other"],
    ]);
    assert.match(rules[0].condition.regexFilter, /\(\?:audit\)\?\$$/);
    assert.match(rules[1].condition.regexFilter, /\/_next\/static\//);
    assert.equal(rules.some((rule) => rule.condition.regexFilter.includes("chat/thread")), false,
      "the header cannot accompany a private data request");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an authenticated audit capture freezes motion even when the route has no masks", () => {
  const token = "qa-audit-motion-token";
  const extensionDir = qa.createRouteExtension([], token, "https://app.agenthost.space/audit", fs);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
    const contentScript = manifest.content_scripts[0];
    assert.deepEqual(contentScript.css, ["mask.css"], "render-token captures always install the QA stylesheet");

    const css = fs.readFileSync(path.join(extensionDir, "mask.css"), "utf8");
    assert.match(css, /animation:\s*none\s*!important/, "pulsing pixels cannot advance between viewports");
    assert.match(css, /transition:\s*none\s*!important/, "selected navigation cannot be caught mid-transition");
    assert.match(css, /caret-color:\s*transparent\s*!important/, "a blinking caret cannot create a false diff");
    assert.doesNotMatch(css, /data-qa-dynamic/, "audit remains fully visible because it owns no masks");

    assert.deepEqual(contentScript.js, ["fixture.js"], "the sanitized fixture remains installed");
    assert.equal(contentScript.world, "MAIN", "the fixture still intercepts the page's own fetches");
    assert.equal(
      fs.readFileSync(path.join(extensionDir, "fixture.js"), "utf8"),
      qa.qaFixtureScript("https://app.agenthost.space"),
      "motion freezing does not change fixture behavior",
    );
    const rules = JSON.parse(fs.readFileSync(path.join(extensionDir, "rules.json"), "utf8"));
    assert.deepEqual(rules.map((rule) => rule.action.requestHeaders), [
      [{ header: qa.QA_RENDER_HEADER, operation: "set", value: token }],
      [{ header: qa.QA_RENDER_HEADER, operation: "set", value: token }],
    ], "the same pass token header remains scoped to document and static assets");
  } finally {
    fs.rmSync(extensionDir, { recursive: true, force: true });
  }
});

test("authenticated workspace motion freezing keeps every route-owned mask", () => {
  const masks = [
    "[data-qa-dynamic=workspace-observed]",
    "[data-qa-dynamic=workspace-transcript-observed]",
  ];
  const extensionDir = qa.createRouteExtension(masks, "qa-workspace-motion-token", "https://app.agenthost.space/", fs);
  try {
    const css = fs.readFileSync(path.join(extensionDir, "mask.css"), "utf8");
    assert.match(css, /animation:\s*none\s*!important/);
    assert.match(css, /transition:\s*none\s*!important/);
    assert.match(css, /caret-color:\s*transparent\s*!important/);
    for (const selector of masks) {
      assert.ok(css.includes(selector + " { visibility: hidden !important; }"), selector + " remains masked");
    }
  } finally {
    fs.rmSync(extensionDir, { recursive: true, force: true });
  }
});

test("open brand and login captures never load the private QA extension", () => {
  const rootDir = tmpRoot();
  try {
    for (const route of ["/brand.json", "/"]) {
      const out = path.join(rootDir, route === "/" ? "login.png" : "brand.png");
      let seenArgs = [];
      const result = qa.captureOne("http://127.0.0.1:8080" + route,
        { name: "phone", width: 390, height: 844 }, out, {
          run: (_bin, args) => {
            seenArgs = args;
            fs.writeFileSync(out, "PIXELS");
            return { status: 0, stderr: "" };
          },
        });
      assert.equal(result.ok, true);
      assert.equal(seenArgs.some((arg) => arg.startsWith("--load-extension=")), false,
        route + " must keep production motion and carry no QA-only CSS");
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the document-start fixture hydrates representative UI data and blocks every real API call locally", async () => {
  const attrs = new Map();
  let nativeFetches = 0;
  const context = {
    URL, Request, Response, EventTarget, Event, queueMicrotask,
    location: new URL("https://app.agenthost.space/audit"),
    document: { documentElement: { setAttribute: (name, value) => attrs.set(name, value) } },
    fetch: async () => { nativeFetches += 1; throw new Error("network must remain unused"); },
    EventSource: class {},
  };
  context.window = context;
  vm.runInNewContext(qa.qaFixtureScript("https://app.agenthost.space"), context);

  const thread = await context.fetch("/chat/thread");
  assert.equal(thread.status, 200);
  assert.match(JSON.stringify(await thread.json()), /QA fixture: release evidence is ready/);
  const board = await (await context.fetch("/board")).json();
  assert.equal(board.available, true);
  assert.equal(board.columns.running[0].title, "Verify the release evidence");
  const measurement = await (await context.fetch("/measurement/status")).json();
  assert.deepEqual([...measurement.providers], ["meta_ads"]);

  const consequence = await context.fetch("/chat/stream?msg=must-not-run", { method: "POST" });
  assert.equal(consequence.status, 418, "an unfixtureable consequence is answered inside the page, not by the gate");
  assert.match(await consequence.text(), /blocked a non-render request/);
  await assert.rejects(() => context.fetch("https://outside.example/private"), /blocked a cross-origin request/);
  assert.equal(nativeFetches, 0, "no fixture or blocked request touched the original network implementation");
  assert.equal(attrs.get("data-agenthost-qa-fixture"), "ready");
  assert.ok(Number(attrs.get("data-agenthost-qa-requests")) >= 5);
});

test("an authed route with no token REFUSES rather than photographing the login wall", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["SHOULD-NEVER-BE-WRITTEN"]),
      probe: okProbe,
      renderToken: "",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /no QA render token/i, "the refusal names its cause");
    assert.match(r.results[0].detail, /qa\/run/i, "and names the trigger that mints one");
    // THE POINT: no baseline was born. A picture of the login wall adopted as a
    // baseline would compare clean forever and catch nothing.
    assert.equal(fs.existsSync(path.join(rootDir, "workspace", "phone", "baseline.png")), false,
      "no baseline is adopted from a route that could not be authenticated");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("a token the server rejects fails the capture instead of poisoning the baseline", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["LOGIN-WALL-PIXELS"]),
      probe: () => ({ ok: true, code: 401 }),
      renderToken: "expired-token",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /did not authenticate/i);
    assert.match(r.results[0].detail, /401/, "the actual status is named, not summarised away");
    assert.equal(fs.existsSync(path.join(rootDir, "workspace", "phone", "baseline.png")), false,
      "a 401 never becomes a baseline");
    assert.equal(r.failedCount, 1);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("an authed route with a working token captures and baselines normally", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["REAL-WORKSPACE-PIXELS"]),
      probe: okProbe,
      renderToken: "good-token",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "baseline_created");
    assert.equal(r.failedCount, 0);
    assert.ok(fs.existsSync(path.join(rootDir, "workspace", "phone", "baseline.png")));
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("an unreachable route is reported as unreachable, not as a visual change", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["X"]),
      probe: () => ({ ok: false, error: "curl exited 7: Failed to connect" }),
      renderToken: "good-token",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /could not be checked/i);
    assert.match(r.results[0].detail, /Failed to connect/, "curl's own words survive into the report");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("a 500 from an authed route is named as a server error, not a regression", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["X"]),
      probe: () => ({ ok: true, code: 500 }),
      renderToken: "good-token",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /500/);
    assert.match(r.results[0].detail, /error page/i);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("open routes never consult the probe at all", () => {
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(CONFIG, {
      run: fakeChromium(["OPEN"]),
      probe: () => { throw new Error("the probe must not run for an unauthenticated route"); },
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "baseline_created");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("a redirect is refused, because chromium would follow it and baseline the destination", () => {
  // Kimi's finding on PR #390. The first cut refused >= 400, so a 302 passed the
  // probe and the capture then photographed wherever the redirect landed -- the
  // poisoned baseline coming back through the one door the guard left open.
  const rootDir = tmpRoot();
  try {
    const r = qa.runQaPass(AUTH_CONFIG, {
      run: fakeChromium(["WHEREVER-THE-REDIRECT-LANDED"]),
      probe: () => ({ ok: true, code: 302 }),
      renderToken: "good-token",
      rootDir,
      stamp: "1",
    });
    assert.equal(r.results[0].status, "capture_failed");
    assert.match(r.results[0].detail, /302/);
    assert.match(r.results[0].detail, /follow that redirect/i, "the cause names why a 3xx is unsafe");
    assert.equal(fs.existsSync(path.join(rootDir, "workspace", "phone", "baseline.png")), false,
      "a redirect never becomes a baseline");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("live masks are route-scoped, layout-preserving, and cannot hide a whole surface", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "container", "qa-routes.json"), "utf8"));
  const masked = cfg.routes.filter((route) => route.mask !== undefined);
  assert.deepEqual(masked.map((route) => route.name), ["workspace"]);
  for (const route of masked) {
    const selectors = qa.routeMasks(route);
    assert.ok(selectors.length > 0);
    assert.ok(selectors.every((selector) => selector.startsWith("[data-qa-dynamic=")));
    const css = qa.maskStylesheet(selectors);
    assert.match(css, /visibility: hidden !important/, "masking preserves layout instead of reflowing the page");
    assert.doesNotMatch(css, /display\s*:\s*none/, "masked pixels must not move neighboring content");
  }
  for (const route of cfg.routes.filter((route) => !route.auth)) assert.equal(route.mask, undefined,
    "static brand/login captures must remain fully visible");
  assert.equal(cfg.routes.find((route) => route.name === "audit").mask, undefined,
    "deterministic fixture-backed audit content stays visible to regression comparison");
});

test("bad or broad mask selectors fail with the route and selector index", () => {
  const rootDir = tmpRoot();
  let captures = 0;
  try {
    const config = {
      ...CONFIG,
      routes: [{ path: "/", name: "workspace", mask: ["main"] }],
    };
    const result = qa.runQaPass(config, {
      rootDir,
      captureOne: () => { captures += 1; return { ok: true }; },
    });
    assert.equal(captures, 0, "invalid masking fails before chromium can baseline a hidden surface");
    assert.equal(result.results[0].status, "capture_failed");
    assert.match(result.results[0].detail, /workspace mask\[0\]/);
    assert.match(result.results[0].detail, /data-qa-dynamic/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("mask text stays in a disposable stylesheet and never becomes a chromium argument", () => {
  const rootDir = tmpRoot();
  const out = path.join(rootDir, "shot.png");
  let css = "";
  let seenArgs = [];
  try {
    const result = qa.captureOne("http://127.0.0.1:8080/", { name: "phone", width: 390, height: 844 }, out, {
      masks: ["[data-qa-dynamic=team-thread]"],
      run: (_bin, args) => {
        seenArgs = args;
        const extensionArg = args.find((arg) => arg.startsWith("--load-extension="));
        assert.ok(extensionArg, "a masked capture loads one disposable local extension");
        const extensionDir = extensionArg.slice("--load-extension=".length);
        css = fs.readFileSync(path.join(extensionDir, "mask.css"), "utf8");
        fs.writeFileSync(out, "PIXELS");
        return { status: 0, stderr: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.match(css, /\[data-qa-dynamic=team-thread\]/);
    assert.match(css, /visibility: hidden/);
    assert.equal(seenArgs.some((arg) => arg.includes("data-qa-dynamic")), false,
      "selectors are CSS data, never shell or chromium arguments");
    const extensionDir = seenArgs.find((arg) => arg.startsWith("--load-extension=")).slice("--load-extension=".length);
    assert.equal(fs.existsSync(extensionDir), false, "the route-scoped extension is removed after capture");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("the capture waits for the page to paint before photographing it", () => {
  // The workspace is an SPA fed by async fetches and two SSE streams, so
  // --screenshot alone photographed the pre-paint state and every authenticated
  // baseline recorded "Box is degraded / Loading the live team thread". The box
  // was healthy; the camera was early. Measured 2026-08-12: /board returns 200
  // with 22177 bytes and /activity/stream delivers events immediately.
  const rootDir = tmpRoot();
  try {
    let seen = null;
    const capturing = (bin, args) => {
      seen = args;
      fs.writeFileSync(args.find((a) => a.startsWith("--screenshot=")).slice("--screenshot=".length), "PIXELS");
      return { status: 0, stderr: "" };
    };
    qa.runQaPass(AUTH_CONFIG, { run: capturing, probe: okProbe, renderToken: "t", rootDir, stamp: "1" });
    const budget = seen.find((a) => a.startsWith("--virtual-time-budget="));
    assert.ok(budget, "the capture asks chromium to let the page settle first");
    assert.ok(Number(budget.split("=")[1]) >= 1000, "and the budget is long enough for a stream's first message");
    // Order matters: the budget must be handed to chromium before the URL, or it
    // is parsed as a positional argument rather than a flag.
    assert.ok(seen.indexOf(budget) < seen.length - 1, "the flag precedes the URL");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("a bad QA_SETTLE_MS keeps the safe default and says so, instead of silently disabling the wait", () => {
  // Kimi's finding on #393. The first cut was `Math.max(0, Number(x) || 8000)`,
  // which turned -5 into 0 -> flag omitted -> the early-screenshot bug back, with
  // no signal. A knob that quietly disables the fix it configures is worse than
  // no knob. And 0 meant 8000, so switching it off gave you the default.
  assert.equal(qa.settleBudgetMs(undefined), 8000, "unset -> default");
  assert.equal(qa.settleBudgetMs(""), 8000, "empty -> default");
  assert.equal(qa.settleBudgetMs("banana"), 8000, "nonsense -> default, never 0");
  assert.equal(qa.settleBudgetMs("-5"), 8000, "negative -> default, NOT a silent disable");
  assert.equal(qa.settleBudgetMs("12000"), 12000, "a real override is honoured");
  assert.equal(qa.settleBudgetMs("0"), 0, "0 is a deliberate opt-out and means 0");
});
