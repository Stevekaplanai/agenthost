import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  GRAPHIFY_IDENTITY,
  GRAPHIFY_LIMITS,
  buildGraphifyCommand,
  prepareGraphifyResultRoot,
  runBoundedCommand,
  runGraphifyCodeMap,
} = require("../container/graphify-lib.js");
const {
  hasCredentialShape,
  hasSecretAssignment,
  isSecretKey,
  redactCredentialShapes,
  redactSecretAssignments,
} = require("../container/graphify-secrets.js");

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-test-"));
}

function writeSource(root, relative, content = "export function example() { return 1; }\n") {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeGraphifyArtifacts(scratchDir, {
  sourceFile = "container/gate.js",
  report = "# Graph Report\n\nOne useful seam.\n",
} = {}) {
  const output = path.join(scratchDir, "graphify-out");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "GRAPH_REPORT.md"), report);
  fs.writeFileSync(path.join(output, "graph.json"), JSON.stringify({
    directed: true,
    multigraph: true,
    graph: {},
    nodes: [{ id: "gate_run", label: "run()", source_file: sourceFile }],
    links: [{ source: "gate_run", target: "gate_run", relation: "calls", source_file: sourceFile }],
    hyperedges: [],
  }));
  fs.writeFileSync(path.join(output, "graph.html"), "<script src='https://unpkg.com'></script>");
  fs.writeFileSync(path.join(output, ".graphify_root"), "C:\\Users\\operator\\repo");
  fs.writeFileSync(path.join(output, "manifest.json"), "{}");
}

test("the Graphify runner is exact-versioned, networkless, code-only and single-worker", () => {
  assert.deepEqual(GRAPHIFY_IDENTITY, {
    distribution: "graphifyy",
    version: "0.9.42",
    wheelSha256: "d87bec57d5dbca1203ce719f4b4afb83ae5eb6cea1b4af2d62d0c10c1c3e26e6",
    sourceCommit: "7fe58b0b0f3873be9a21c30106b8b8527c353aa6",
  });
  assert.equal(GRAPHIFY_LIMITS.maxFiles, 15);

  const extract = buildGraphifyCommand({
    stage: "extract",
    inputDir: "/tmp/graphify-input",
    scratchDir: "/tmp/graphify-scratch",
    packageDir: "/opt/agenthost/graphify-python",
  });
  assert.equal(extract.bin, "/usr/bin/bwrap");
  assert.equal(extract.args[0], "--unshare-net", "the OS network namespace is mandatory");
  assert.ok(extract.args.includes("--clearenv"), "the package never inherits gate credentials");
  assert.ok(extract.args.includes("--unshare-pid"), "the child process tree is contained");
  const joined = extract.args.join(" ");
  assert.match(joined, /--ro-bind-try \/tmp\/graphify-input \/source/);
  assert.match(joined, /--bind \/tmp\/graphify-scratch \/scratch/);
  assert.match(joined, /metadata\.version\('graphifyy'\)/);
  assert.match(joined, /expected = '0\.9\.42'/);
  assert.match(joined, /extract \/source --code-only --max-workers 1 --out \/scratch --force/);
  assert.doesNotMatch(joined, /--backend| install | hook | global | watch | clone | prs /);

  const cluster = buildGraphifyCommand({
    stage: "cluster",
    inputDir: "/tmp/graphify-input",
    scratchDir: "/tmp/graphify-scratch",
    packageDir: "/opt/agenthost/graphify-python",
  });
  const clusterJoined = cluster.args.join(" ");
  assert.equal(cluster.args[0], "--unshare-net");
  assert.match(clusterJoined, /cluster-only \/scratch --no-viz --max-concurrency 1/);
  assert.doesNotMatch(clusterJoined, /--backend/);
});

test("the image builds the exact hashed Graphify package and ships only its local runtime", () => {
  const container = path.join(import.meta.dirname, "..", "container");
  const docker = fs.readFileSync(path.join(container, "Dockerfile"), "utf8");
  const lock = fs.readFileSync(path.join(container, "graphify-requirements-linux-x86_64-py311.txt"), "utf8");
  const requirements = lock.trim().split(/\r?\n/);

  assert.equal(requirements.length, 30, "the tested base-only dependency closure stays exact");
  assert.ok(requirements.every((line) => /^[A-Za-z0-9_.-]+==[^\s]+ --hash=sha256:[a-f0-9]{64}$/.test(line)),
    "every package is exact-versioned and hash-pinned");
  assert.equal(requirements[0],
    "graphifyy==0.9.42 --hash=sha256:d87bec57d5dbca1203ce719f4b4afb83ae5eb6cea1b4af2d62d0c10c1c3e26e6");

  assert.match(docker,
    /FROM python:3\.11-slim-bookworm@sha256:2e32f7d302adc1c37428355c1e646897c0c53f4fd60b6a551245fb90ee129f91 AS graphify-python/,
    "the package builder is immutable");
  assert.match(docker, /ARG GRAPHIFY_WHEEL_SHA256=d87bec57d5dbca1203ce719f4b4afb83ae5eb6cea1b4af2d62d0c10c1c3e26e6/);
  assert.match(docker, /COPY graphify-requirements-linux-x86_64-py311\.txt \/tmp\/graphify-requirements\.txt/);
  assert.match(docker, /pip install[\s\S]*?--require-hashes[\s\S]*?-r \/tmp\/graphify-requirements\.txt/,
    "pip may install only artifacts matching the reviewed hash lock");
  assert.match(docker, /m\.version\('graphifyy'\) == '0\.9\.42'/,
    "the built metadata is checked before promotion");
  for (const notice of ["LICENSE", "LICENSE-MIT", "NOTICE"]) assert.match(docker, new RegExp(notice));
  assert.match(docker, /COPY --from=graphify-python \/opt\/agenthost\/graphify-python \/opt\/agenthost\/graphify-python/);
  assert.match(docker, /COPY --from=graphify-python \/opt\/agenthost\/licenses\/graphify \/opt\/agenthost\/licenses\/graphify/);
  const runtimeModeStart = docker.indexOf("RUN install -o root -g root -m 0444 /dev/null /opt/agenthost/dsh-empty.env");
  const runtimeModeEnd = docker.indexOf("&& python3 -I", runtimeModeStart);
  assert.ok(runtimeModeStart >= 0 && runtimeModeEnd > runtimeModeStart, "the Graphify runtime-mode block must stay bounded");
  const runtimeMode = docker.slice(runtimeModeStart, runtimeModeEnd);
  assert.match(runtimeMode, /chmod 0444/, "the promoted Graphify runtime must be read-only");
  for (const runtime of [
    "graphify-lib.js",
    "graphify-secrets.js",
    "graphify-html.js",
    "graphify-store.js",
    "graphify-corpora.js",
    "graphify-brand.js",
    "graphify-brand-corpus.js",
    "graphify-brain.js",
    "graphify-folder-extract.py",
  ]) {
    const escaped = runtime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(docker, new RegExp(`COPY ${escaped} /opt/agenthost/${escaped}`), `${runtime} must ship in the image`);
    assert.match(runtimeMode, new RegExp(`/opt/agenthost/${escaped}`), `${runtime} must be covered by the read-only runtime mode`);
  }
});

test("boot gives the code-map state tree to the selected gate identity in both runtime modes", () => {
  const entrypoint = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "entrypoint.sh"), "utf8");
  assert.match(entrypoint,
    /install -d -o "\$artifact_review_owner" -g "\$artifact_review_owner" -m 0700 "\$AGENTHOST_CODE_MAP_STATE_DIR"/,
    "flag-off runs as agent while Foundation B runs as gate");
  assert.match(entrypoint,
    /for private_tree in[^\n]*"\$AGENTHOST_CODE_MAP_STATE_DIR"[^\n]*; do/,
    "mode changes reconcile retained code maps to the selected runtime identity");
});

test("preparing a result root retains at most seven prior private maps before a new run", (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const names = Array.from({ length: GRAPHIFY_LIMITS.maxRetainedResults + 1 }, (_, index) =>
    index.toString(16).padStart(32, "0"));
  names.forEach((name, index) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "graph.json"), "{}", { mode: 0o600 });
    const when = new Date(1_700_000_000_000 + index * 1000);
    fs.utimesSync(dir, when, when);
  });
  fs.writeFileSync(path.join(root, "operator-note"), "not a generated result");

  prepareGraphifyResultRoot(root);

  const retained = fs.readdirSync(root).filter((name) => /^[a-f0-9]{32}$/.test(name)).sort();
  assert.equal(retained.length, GRAPHIFY_LIMITS.maxRetainedResults - 1);
  assert.deepEqual(retained, names.slice(2));
  assert.equal(fs.readFileSync(path.join(root, "operator-note"), "utf8"), "not a generated result");
});

test("a successful job copies only allowlisted source and promotes only sanitized report and private JSON", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const resultDir = path.join(root, "result");
  const files = ["container/gate.js", "container/engine-adapters.js"];
  files.forEach((file) => writeSource(sourceRoot, file));

  const stages = [];
  const result = await runGraphifyCodeMap({
    sourceRoot,
    resultDir,
    files,
    buildCommand: ({ stage }) => ({ bin: "fixture-graphify", args: [stage] }),
    execute: async (_command, context) => {
      stages.push(context.stage);
      assert.deepEqual(
        fs.readdirSync(context.inputDir, { recursive: true }).filter((entry) => /\.(?:js|mjs)$/.test(entry)).sort(),
        files.map((file) => file.split("/").join(path.sep)).sort(),
      );
      if (context.stage === "cluster") writeGraphifyArtifacts(context.scratchDir);
    },
  });

  assert.deepEqual(stages, ["extract", "cluster"]);
  assert.deepEqual(fs.readdirSync(resultDir).sort(), ["GRAPH_REPORT.md", "graph.json"]);
  assert.equal(fs.existsSync(path.join(resultDir, "graph.html")), false);
  assert.equal(fs.existsSync(path.join(resultDir, ".graphify_root")), false);
  assert.equal(result.fileCount, 2);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.linkCount, 1);
  assert.equal(result.report, "# Graph Report\n\nOne useful seam.\n");
});

test("the source cap, traversal, sensitive directories, and credential values fail before execution", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const resultDir = path.join(root, "result");
  const executed = [];
  const base = {
    sourceRoot,
    resultDir,
    buildCommand: () => ({ bin: "never", args: [] }),
    execute: async () => { executed.push(true); },
  };

  await assert.rejects(runGraphifyCodeMap({ ...base, resultDir: undefined, files: ["src/one.js"] }), /result directory must be absolute/);
  const tooMany = Array.from({ length: GRAPHIFY_LIMITS.maxFiles + 1 }, (_, i) => `src/f${i}.js`);
  await assert.rejects(runGraphifyCodeMap({ ...base, files: tooMany }), /at most 15 source files/);
  await assert.rejects(runGraphifyCodeMap({ ...base, files: ["../outside.js"] }), /safe relative path/);
  await assert.rejects(runGraphifyCodeMap({ ...base, files: [".git/config.js"] }), /sensitive directory/);

  writeSource(sourceRoot, "src/leak.js", "export const key = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';\n");
  await assert.rejects(runGraphifyCodeMap({ ...base, files: ["src/leak.js"] }), /credential-shaped value/);
  writeSource(sourceRoot, "src/original.js");
  fs.linkSync(path.join(sourceRoot, "src", "original.js"), path.join(sourceRoot, "src", "hardlink.js"));
  await assert.rejects(runGraphifyCodeMap({ ...base, files: ["src/hardlink.js"] }), /single-link non-symlink file/);
  fs.writeFileSync(path.join(sourceRoot, "src", "large.js"), Buffer.alloc(GRAPHIFY_LIMITS.maxFileBytes + 1, 0x61));
  await assert.rejects(runGraphifyCodeMap({ ...base, files: ["src/large.js"] }), /source file is too large/);
  assert.equal(executed.length, 0);
  assert.equal(fs.existsSync(resultDir), false);
});

test("a source path through a directory link is refused instead of followed", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const outside = path.join(root, "outside");
  writeSource(outside, "link.js");
  fs.mkdirSync(sourceRoot, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(sourceRoot, "src"), "junction");
  } catch (error) {
    t.skip(`symlink unavailable in this environment: ${error.code}`);
    return;
  }

  await assert.rejects(runGraphifyCodeMap({
    sourceRoot,
    resultDir: path.join(root, "result"),
    files: ["src/link.js"],
    buildCommand: () => ({ bin: "never", args: [] }),
    execute: async () => { throw new Error("symlink reached execution"); },
  }), /escaped its root/);
});

test("an allowlisted source path cannot alias an internal sensitive directory", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const sensitive = path.join(sourceRoot, ".git");
  writeSource(sensitive, "gate.js");
  try {
    fs.symlinkSync(sensitive, path.join(sourceRoot, "container"), "junction");
  } catch (error) {
    t.skip(`symlink unavailable in this environment: ${error.code}`);
    return;
  }

  let executed = 0;
  await assert.rejects(runGraphifyCodeMap({
    sourceRoot,
    resultDir: path.join(root, "result"),
    files: ["container/gate.js"],
    buildCommand: () => ({ bin: "never", args: [] }),
    execute: async () => { executed++; },
  }), /canonical source path/);
  assert.equal(executed, 0, "an aliased source is rejected before Graphify executes");
});

test("path or secret leakage in Graphify output withholds the entire result", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  writeSource(sourceRoot, "container/gate.js");

  for (const [name, artifact] of [
    ["absolute path", { sourceFile: "C:\\Users\\operator\\repo\\container\\gate.js" }],
    ["internal path", { report: "# Report\nparser workspace /tmp/graphify-private\n" }],
    ["secret", { report: "# Report\nsecret-value-123456789\n" }],
    ["assignment credential", { report: "# Report\npassword=hunter2\n" }],
    ["session assignment credential", { report: "# Report\nsession: plain-session-secret\n" }],
    ["cookie assignment credential", { report: "# Report\ncookie=sessionid=plain-cookie-secret\n" }],
    ["camel assignment credential", { report: "# Report\nclientSecret=plain-client-secret\n" }],
    ["compound assignment credential", { report: "# Report\nAWS_SECRET_ACCESS_KEY=alphaSecretValue\n" }],
    ["passphrase assignment credential", { report: "# Report\nservice_passphrase=correct horse battery staple\n" }],
    ["bearer assignment credential", { report: "# Report\nbearerToken=plain-bearer-secret\n" }],
    ["private assignment credential", { report: "# Report\nprivateKey=plain-private-secret\n" }],
    ["session token assignment credential", { report: "# Report\nsessionToken=plain-session-token\n" }],
    ["acronym token assignment credential", { report: "# Report\nJWTToken=plain-jwt-secret\n" }],
    ["url token assignment credential", { report: "# Report\nmyURLToken=plain-url-secret\n" }],
    ["bracket env assignment credential", { report: "# Report\nprocess.env[\"API_KEY\"] = \"plain-bracket-env-secret\"\n" }],
    ["bracket config assignment credential", { report: "# Report\nconfig['accessToken']='plain-bracket-config-secret'\n" }],
    ["python environ assignment credential", { report: "# Report\nos.environ[\"AWS_SECRET_ACCESS_KEY\"]=\"plain-bracket-python-secret\"\n" }],
    ["powershell env assignment credential", { report: "# Report\n$env:API_KEY=plain-powershell-secret\n" }],
    ["logical OR assignment credential", { report: "# Report\nprocess.env.API_KEY ||= \"logical-or-secret\";\n" }],
    ["logical nullish assignment credential", { report: "# Report\nprocess.env.ACCESS_TOKEN ??= \"logical-nullish-secret\";\n" }],
    ["bracket logical AND assignment credential", { report: "# Report\nconfig[\"clientSecret\"] &&= \"logical-and-secret\";\n" }],
    ["signing key assignment credential", { report: "# Report\nSIGNING_KEY=signing-key-secret\n" }],
    ["encryption key assignment credential", { report: "# Report\nENCRYPTION_KEY=encryption-key-secret\n" }],
    ["session key assignment credential", { report: "# Report\nSESSION_KEY=session-key-secret\n" }],
    ["suffix assignment credential", { report: "# Report\npassword=[REDACTED],beta;gamma}\n" }],
    ["nested object token assignment credential", { report: "# Report\nconst config = { accessToken: \"fixture-secret\" };\n" }],
    ["nested object cookie assignment credential", { report: "# Report\nconst opts = { cookie: \"fixture-secret\" };\n" }],
    ["nested object template assignment credential", { report: "# Report\npayload = { clientSecret: `fixture-secret` }\n" }],
    ["nested DSN assignment credential", { report: "# Report\nDATABASE_DSN=host=db.local password=fixture-secret\n" }],
    ["nested prose assignment credential", { report: "# Report\nnote: cookie=fixture-secret\n" }],
    ["PascalCase assignment credential", { report: "# Report\npassword: SuperSecret\n" }],
    ["builtin-word assignment credential", { report: "# Report\npassword: string\n" }],
    ["type word prefix assignment credential", { report: "# Report\nconst type = \"login\"; const cfg = { password: \"hunter2\" };\n" }],
    ["same-line type escape assignment credential", { report: "# Report\ntype Inline = { token: string; }; const cfg = { password: \"hunter2\" };\n" }],
    ["same-line interface escape assignment credential", { report: "# Report\ninterface Credentials { token: string; } const cfg = { password: \"hunter2\" };\n" }],
    ["punctuated object assignment credential", { report: "# Report\nconst cfg = { password: SuperSecret, enabled: true };\n" }],
    ["punctuated scalar assignment credential", { report: "# Report\napiKey: SuperSecret;\n" }],
    ["class object assignment credential", { report: "# Report\nclass Auth { config = { password: \"class-object-secret\" }; }\n" }],
    ["class method assignment credential", { report: "# Report\nclass Auth { method() { return { clientSecret: \"class-method-secret\" }; } }\n" }],
    ["class typed initializer assignment credential", { report: "# Report\nclass Auth { password: string = \"typed-class-secret\"; }\n" }],
    ["optional typed class assignment credential", { report: "# Report\nclass Auth { token?: string = \"optional-token-secret\"; }\n" }],
    ["optional untyped class assignment credential", { report: "# Report\nclass Auth { token? = \"optional-untyped-secret\"; }\n" }],
    ["quoted optional class assignment credential", { report: "# Report\nclass Auth { static readonly \"accessToken\"?: string = \"optional-quoted-secret\"; }\n" }],
    ["computed optional class assignment credential", { report: "# Report\nclass Auth { static readonly [\"clientSecret\"]?: string = \"optional-computed-secret\"; }\n" }],
    ["optional object class assignment credential", { report: "# Report\nclass Auth { token?: { value: string } = { value: \"optional-object-secret\" }; }\n" }],
    ["optional tuple class assignment credential", { report: "# Report\nclass Auth { password?: [string, number] = [\"optional-tuple-secret\", 1]; }\n" }],
    ["optional function class assignment credential", { report: "# Report\nclass Auth { accessToken?: (() => string) = () => \"optional-function-secret\"; }\n" }],
    ["optional generic object class assignment credential", { report: "# Report\nclass Auth { clientSecret?: Promise<{ value: string }> = Promise.resolve({ value: \"optional-generic-secret\" }); }\n" }],
    ["optional union object class assignment credential", { report: "# Report\nclass Auth { refreshToken?: string | { value: string } = { value: \"optional-union-secret\" }; }\n" }],
    ["optional parenthesized union class assignment credential", { report: "# Report\nclass Auth { sessionToken?: (string | { value: string }) = { value: \"optional-paren-union-secret\" }; }\n" }],
    ["optional multiline object class assignment credential", { report: "# Report\nclass Auth { cookie?: {\n value: string\n} = { value: \"optional-multiline-secret\" }; }\n" }],
    ["computed optional object class assignment credential", { report: "# Report\nclass Auth { [\"accessToken\"]?: { value: string } = { value: \"optional-computed-object-secret\" }; }\n" }],
    ["continued string assignment credential", { report: "# Report\nconst token =\n  \"continued-string-secret\";\n" }],
    ["continued template assignment credential", { report: "# Report\nconst accessToken =\n  `continued-template-secret`;\n" }],
    ["typed return runtime assignment credential", { report: "# Report\nfunction f(): Promise<{ safe: string }> { return { token: \"runtime-return-secret\", safe: \"ok\" }; }\n" }],
    ["as runtime assignment credential", { report: "# Report\nconst value = { token: \"runtime-as-secret\" } as { token: string };\n" }],
    ["satisfies runtime assignment credential", { report: "# Report\nconst value = { accessToken: \"runtime-satisfies-secret\" } satisfies { accessToken: string };\n" }],
    ["call ternary runtime assignment credential", { report: "# Report\nconst value = condition ? fn() : { password: CallTernarySecret };\n" }],
    ["as ternary runtime assignment credential", { report: "# Report\nconst value = input as Safe ? {} : { token: AsTernarySecret };\n" }],
    ["satisfies ternary runtime assignment credential", { report: "# Report\nconst value = input satisfies Safe ? {} : { clientSecret: SatisfiesTernarySecret };\n" }],
    ["post-generic call ternary runtime assignment credential", { report: "# Report\ntype G<T> = T; const value = condition ? fn() : { password: RuntimeAfterGenericSecret };\n" }],
    ["post-generic as ternary runtime assignment credential", { report: "# Report\ntype G<T> = T; const value = input as Safe ? {} : { token: AsAfterGenericSecret };\n" }],
    ["post-generic satisfies ternary runtime assignment credential", { report: "# Report\ntype G<T> = T; const value = input satisfies Safe ? {} : { clientSecret: SatisfiesAfterGenericSecret };\n" }],
    ["ASI ternary assignment credential", { report: "# Report\ntype G<T> = T\nconst value = condition ? fn() : { password: RuntimeAfterAsiGenericSecret };\n" }],
    ["ASI as assignment credential", { report: "# Report\ntype G<T> = T /* tail */\nconst value = input as Safe ? {} : { token: AsAfterAsiGenericSecret };\n" }],
    ["ASI satisfies assignment credential", { report: "# Report\ntype G<T> = T // tail\nconst value = input satisfies Safe ? {} : { clientSecret: SatisfiesAfterAsiGenericSecret };\n" }],
    ["ASI generic bare assignment credential", { report: "# Report\ndeclare let runtime: unknown;\ntype G<T> = T\nruntime = { password: BareAfterAsiGenericSecret };\n" }],
    ["continued type-alias runtime assignment credential", { report: "# Report\ntype G<T extends { safe: string } = { safe: string }> =\n  Array<{ token: T }>\nconst value = condition ? fn() : { password: RuntimeAfterContinuedAliasSecret };\n" }],
    ["runtime generic default assignment credential", { report: "# Report\nfunction f<T>(TToken = \"runtime-generic-default-secret\"): void {}\n" }],
    ["commented key assignment credential", { report: "# Report\nconst token /* keep-comment */ = \"commented-key-secret\";\n" }],
    ["commented bracket assignment credential", { report: "# Report\nconfig[\"accessToken\"] /* keep-comment */ = \"commented-bracket-secret\";\n" }],
    ["block-comment assignment credential", { report: "# Report\n/* password=comment-secret */\n" }],
    ["nested block-comment assignment credential", { report: "# Report\ntoken /* password=inner-comment-secret */ = outer-comment-secret;\n" }],
    ["compound RHS assignment credential", { report: "# Report\npassword=\"\" + \"compound-rhs-secret\";\n" }],
    ["conditional RHS assignment credential", { report: "# Report\nconst refreshToken = condition\n  ? \"conditional-first-secret\"\n  : \"conditional-second-secret\";\n" }],
    ["commented RHS assignment credential", { report: "# Report\nconst clientSecret = /* keep-comment */\n  \"commented-rhs-secret\";\n" }],
    ["continued comment assignment credential", { report: "# Report\nconst token =\n  // selected secret\n  \"continued-comment-secret\";\n" }],
    ["blank continued comment assignment credential", { report: "# Report\nconst token =\n\n  // selected secret\n  \"blank-comment-secret\";\n" }],
    ["compound operator assignment credential", { report: "# Report\ntoken += \"compound-plus-secret\";\n" }],
    ["bracket compound operator assignment credential", { report: "# Report\nconfig[\"accessToken\"] += \"compound-bracket-secret\";\n" }],
    ["Unicode key assignment credential", { report: "# Report\nconst cfg = { pass\\u0077ord: \"unicode-js-secret\" };\n" }],
    ["quoted Unicode key assignment credential", { report: "# Report\nconst cfg = { \"pass\\u0077ord\": \"unicode-quoted-secret\" };\n" }],
    ["codepoint key assignment credential", { report: "# Report\nconst cfg = { pass\\u{77}ord: \"unicode-codepoint-secret\" };\n" }],
    ["bracket Unicode key assignment credential", { report: "# Report\nconfig[\"access\\u0054oken\"] = \"unicode-bracket-secret\";\n" }],
    ["bracket hex key assignment credential", { report: "# Report\nconfig[\"access\\x54oken\"] = \"hex-bracket-secret\";\n" }],
    ["malformed escaped key assignment credential", { report: "# Report\nconfig[\"pass\\uZZZZord\"] = \"malformed-key-secret\";\n" }],
    ["leading normalized key assignment credential", { report: "# Report\nconfig[\"_token\"] = \"leading-key-secret\";\n" }],
    ["typed function assignment credential", { report: "# Report\nconst tokenFactory: () => string = \"typed-function-secret\";\n" }],
    ["fenced Unicode JSON assignment credential", { report: "# Report\n```json\n{\"pass\\u0077ord\":\"fenced-json-secret\"}\n```\n" }],
    ["indented YAML assignment credential", { report: "# Report\npassword:\n  yaml-indented-secret\n" }],
    ["sequence YAML assignment credential", { report: "# Report\ncredentials:\n- yaml-sequence-secret\nsafe: yes\n" }],
    ["tight nested assignment credential", { report: "# Report\nouter=accessToken=fixture-secret\n" }],
    ["multiline template assignment credential", { report: "# Report\nconst privateKey = `line-one-secret\nline-two-secret`;\n" }],
    ["multiline TOML assignment credential", { report: "# Report\nprivate_key = \"\"\"line-one-secret\nline-two-secret\"\"\"\n" }],
    ["preprocessed TOML residue assignment credential", { report: "# Report\nprivate_key=\"[REDACTED]\"\nTomlTwoS3cr3t\"\"\"\n" }],
    ["inner TOML residue assignment credential", { report: "# Report\nprivate_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nTomlTwoS3cr3t\"\"\"\n" }],
    ["table TOML residue assignment credential", { report: "# Report\nprivate_key=\"[REDACTED]\"\n[section]\nTomlTwoS3cr3t\"\"\"\n" }],
    ["CRLF TOML residue assignment credential", { report: "# Report\r\nprivate_key=\"[REDACTED]\"\r\nlabel=\"[REDACTED]\"\r\nTomlTwoS3cr3t\"\"\"\r\n" }],
    ["single-quote TOML residue assignment credential", { report: "# Report\nprivate_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nTomlTwoS3cr3t'''\n" }],
    ["multiline YAML assignment credential", { report: "# Report\npassword: |\n  line-one-secret\n  line-two-secret\n" }],
    ["nested JSON assignment credential", { report: "{\"credentials\":{\"token\":\"fixture-secret\",\"safe\":\"fixture-secret\"},\"other\":1}\n" }],
    ["duplicate JSON assignment credential", { report: "{\"password\":\"first-secret\",\"password\":\"[REDACTED]\"}\n" }],
    ["escaped duplicate JSON assignment credential", { report: "{\"pass\\u0077ord\":\"first-secret\",\"pass\\u0077ord\":\"[REDACTED]\"}\n" }],
    ["escaped shadowed JSON assignment credential", { report: "{\"note\":\"pass\\u0077ord=hunter2\",\"note\":\"safe\"}\n" }],
    ["Docker ENV assignment credential", { report: "# Report\nENV API_KEY docker-env-secret\n" }],
    ["Docker continued ENV assignment credential", { report: "# Report\nENV ACCESS_TOKEN \\\n  continued-docker-secret\n" }],
    ["CLI password flag assignment credential", { report: "# Report\nrun --password cli-password-secret\n" }],
    ["CLI token flag assignment credential", { report: "# Report\nrun --token \"cli-token-secret\"\n" }],
    ["CLI continued flag assignment credential", { report: "# Report\nrun --password \\\n  cli-continued-secret\n" }],
    ["C define assignment credential", { report: "# Report\n#define PASSWORD define-secret\n" }],
    ["Ruby quoted hash assignment credential", { report: "# Report\n{ \"password\" => \"ruby-hash-secret\" }\n" }],
    ["Ruby symbol hash assignment credential", { report: "# Report\n{ :accessToken => \"ruby-symbol-secret\" }\n" }],
    ["PHP hash assignment credential", { report: "# Report\n$config = [\"token\" => \"php-hash-secret\"];\n" }],
    ["Kubernetes value assignment credential", { report: "# Report\n- name: API_KEY\n  value: kubernetes-value-secret\n" }],
    ["Kubernetes commented value assignment credential", { report: "# Report\n- name: API_KEY\n  # selected\n  value: kubernetes-comment-secret\n" }],
    ["Kubernetes blank value assignment credential", { report: "# Report\n- name: API_KEY\n\n  value: kubernetes-blank-secret\n" }],
    ["SQL password assignment credential", { report: "# Report\nCREATE USER demo WITH PASSWORD 'sql-password-secret';\n" }],
    ["PostgreSQL role password assignment credential", { report: "# Report\nCREATE ROLE app WITH LOGIN PASSWORD 'pgsql-secret';\n" }],
    ["PostgreSQL connection limit assignment credential", { report: "# Report\nCREATE ROLE app WITH LOGIN CONNECTION LIMIT 5 PASSWORD 'pgsql-limit-secret';\n" }],
    ["PostgreSQL valid-until assignment credential", { report: "# Report\nALTER ROLE app VALID UNTIL '2027-01-01' PASSWORD 'pgsql-valid-secret';\n" }],
    ["database URL assignment credential", { report: "# Report\nDATABASE_URL=postgres://dbuser:fixture-db-secret@db/app\n" }],
    ["suffix API assignment credential", { report: "# Report\nOPENAI_API_KEY_PROD=fixture-api-secret\n" }],
    ["suffix database assignment credential", { report: "# Report\nDATABASE_URL_READONLY=fixture-db-secret\n" }],
    ["suffix session assignment credential", { report: "# Report\nSESSION_ID_BACKUP=fixture-session-secret\n" }],
    ["compact session assignment credential", { report: "# Report\nSESSIONID=fixture-compact-session-secret\n" }],
    ["credential URI", { report: "# Report\nredis://:fixture-cache-secret@cache/0\n" }],
    ["Mongo credential URI", { report: "# Report\nmongodb+srv://dbuser:fixture-mongo-secret@cluster/app\n" }],
    ["HTTPS credential URI", { report: "# Report\nsource_url=https://alice:https-userinfo-secret@example.com/private\n" }],
    ["PEM credential", { report: "# Report\n-----BEGIN EC PRIVATE KEY-----\nfixture-pem-secret\n-----END EC PRIVATE KEY-----\n" }],
    ["unterminated PEM credential", { report: "# Report\n-----BEGIN OPENSSH PRIVATE KEY-----\nraw-private-body-secret\nsecond-line\n" }],
    ["github session token", { report: `# Report\nghs_${"a".repeat(24)}\n` }],
    ["jwt token", { report: "# Report\neyJabcdefgh.ijklmnop.qrstuvwx\n" }],
    ["Bearer token", { report: "# Report\nBearer abcdefghijklmnop\n" }],
    ["short camel Bearer token", { report: "# Report\nBearer SuperSecret\n" }],
    ["Basic token", { report: "# Report\nBasic dTpw\n" }],
  ]) {
    const resultDir = path.join(root, `result-${name.replaceAll(" ", "-")}`);
    await assert.rejects(runGraphifyCodeMap({
      sourceRoot,
      resultDir,
      files: ["container/gate.js"],
      secretValues: ["secret-value-123456789"],
      buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
      execute: async (_command, context) => {
        if (context.stage === "cluster") writeGraphifyArtifacts(context.scratchDir, artifact);
      },
    }), new RegExp(name === "secret" ? "secret value"
      : name.includes("database URL") || name.includes("credential URI") || name.includes("PEM credential") ? "credential-shaped value"
        : name.includes("assignment credential") ? "assignment-form credential"
          : name.includes("token") ? "credential-shaped value"
        : "absolute path"), `${name} should be rejected`);
    assert.equal(fs.existsSync(resultDir), false, "a rejected output is never partly published");
  }
});

test("comparison, type, and timeout syntax is not treated as a credential assignment", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  writeSource(sourceRoot, "container/gate.js");
  const report = "# Report\nif (token === undefined) return ok;\ntype Config = { token: string; enabled: boolean };\ntype Token = string;\ntype Handler = (token: string) => void;\ninterface Credentials {\n  token: string\n}\ninterface GenericCredentials<T> { token: T }\nfunction authenticate(token: AuthToken): void {}\nfunction generic<T>(token: T): void {}\nfunction blockLocalType(){ type Token = string; }\nclass GenericAuth<T> { private method(token: T): void {} }\nitems.map((token: string) => token);\ntoken: string | null\nclass Auth { token: AuthToken; }\npassword:\nsafeOptional: yes\n{\"sessionTimeout\":30}\nChoose the Basic plan for teams. Basic tier. Basic auth.\nBearer authentication is supported.\nBearer representational systems are supported.\n";
  const aliasContinuationReport = "type ContinuedArray =\n  Array<{ token: string }>;\ntype ContinuedReadonly<T> =\n  // safe\n  readonly [{ token: T }, { password: string }];\ntype ContinuedComplex<T extends { safe: string } = { safe: string }> =\n  /* safe */\n  keyof ({ token: T; password: string });\n";
  const safeReport = report + "type UnionCredentials = { token: string } | { password: string };\ntype GenericCredentials = Array<{ token: string }> & { password: string };\nfunction acceptsCredentials(value: Record<string, { token: string }>): void {}\nfunction graphResult(): Promise<{ token: string }> { throw new Error(); }\nfunction multilineResult():\n  Promise<{\n    token: string\n  }> { throw new Error(); }\nconst graphItems: Array<{ token: string }> = [];\nconst typedFactory: () => Promise<{ token: string }> = async () => ({ safe: true });\ndeclare const parenthesizedFactory: () => ({ token: string } | { password: string });\ntype GenericAlias<T extends { token: string } = { password: string }> = T;\ntype GenericTokenDefault<TToken extends string = string> = TToken;\ninterface GenericDefault<T extends { token: string } = { password: string }> { value: T }\nclass GenericVault<T extends { token: string } = { password: string }> {}\nfunction genericDefault<T extends { token: string } = { password: string }>(value: { clientSecret: string }): void {}\nconst assertedType = {} as { token: string } | { password: string };\nconst satisfiedType = {} satisfies { token: string } & { password?: string };\ninterface OptionalShape { token?: string }\ntype OptionalAlias = { \"accessToken\"?: string };\nclass OptionalComplexTypes { token?: { value: string }; password?: [string, number]; accessToken?: (() => string); clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }); }\ninterface OptionalComplexInterface { token?: { value: string }; password?: [string, number]; accessToken?: (() => string) }\ntype OptionalComplexAlias = { clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }) };\ninterface CommentedCredentials {\n  // harmless }\n  token: string;\n}\nclass CommentedVault { /* harmless } */ private password: string; private config: Array<{ token: string }>; }\npassword = [REDACTED];\nprivate_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nprivate_key=\"[REDACTED]\"\ndescription=\"\"\"line one\nline two\"\"\"\nprivate_key=\"[REDACTED]\"\n[section]\ndescription=\"safe\"\n{\"tokenCount\":5}\n" + aliasContinuationReport;
  const result = await runGraphifyCodeMap({
    sourceRoot,
    resultDir: path.join(root, "result-safe-syntax"),
    files: ["container/gate.js"],
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => {
      if (context.stage === "cluster") writeGraphifyArtifacts(context.scratchDir, { report: safeReport });
    },
  });
  assert.equal(result.report, safeReport);
});

test("many same-line secret assignments are redacted with bounded source slicing", () => {
  const input = "token=x;".repeat(100_000);
  const originalSlice = String.prototype.slice;
  let slicedCharacters = 0;
  String.prototype.slice = function countedSlice(...args) {
    const result = Reflect.apply(originalSlice, this, args);
    if (this.length === input.length) slicedCharacters += result.length;
    return result;
  };
  let output;
  try {
    output = redactSecretAssignments(input);
  } finally {
    String.prototype.slice = originalSlice;
  }
  assert.equal(output, "token=[REDACTED]");
  assert.ok(slicedCharacters < input.length * 4, `scanner sliced ${slicedCharacters} characters for ${input.length} input characters`);
});

test("many already-redacted assignments are validated with bounded source slicing", () => {
  const input = 'token="[REDACTED]";'.repeat(25_000);
  const originalSlice = String.prototype.slice;
  let slicedCharacters = 0;
  String.prototype.slice = function countedSlice(...args) {
    const result = Reflect.apply(originalSlice, this, args);
    if (this.length === input.length) slicedCharacters += result.length;
    return result;
  };
  let output;
  try {
    output = redactSecretAssignments(input);
  } finally {
    String.prototype.slice = originalSlice;
  }
  assert.equal(output, input);
  assert.equal(hasSecretAssignment(output), false);
  assert.ok(slicedCharacters < input.length * 14, `scanner sliced ${slicedCharacters} characters for ${input.length} input characters`);
});

test("ASI-separated generic type aliases cannot hide later runtime credentials", () => {
  const prefixes = [
    "type G<T> = T",
    "type G<T extends { token: string } = { password: string }> = T",
    "type G<T> = Promise<{ token: string }>",
    "type G<T> = { token: T }",
    "type G<T> = { token: T } | { password: string }",
    "type G<T> = T extends string ? { token: T } : { password: string }",
    "type G<T> = { [K in keyof T]: { token: T[K] } }",
    "type G<T> = (value: T) => { password: string }",
    "type G<T> = [{ token: T }, { password: string }]",
    "type G<T> = T & { token: string }",
  ];
  const runtimeComplements = [
    ["const runtime = { password: PlainRuntimeS3cr3t };", "PlainRuntimeS3cr3t"],
    ['function runtime(): { safe: string } { return { token: ReturnRuntimeS3cr3t, safe: "ok" }; }', "ReturnRuntimeS3cr3t"],
    ["const runtime = { token: AsObjectRuntimeS3cr3t } as { token: string };", "AsObjectRuntimeS3cr3t"],
    ["const runtime = { clientSecret: SatisfiesObjectRuntimeS3cr3t } satisfies { clientSecret: string };", "SatisfiesObjectRuntimeS3cr3t"],
    ["const runtime = condition ? fn() : { password: CallRuntimeS3cr3t };", "CallRuntimeS3cr3t"],
    ["const runtime = value as Safe ? {} : { token: AsRuntimeS3cr3t };", "AsRuntimeS3cr3t"],
    ["const runtime = value satisfies Safe ? {} : { clientSecret: SatisfiesRuntimeS3cr3t };", "SatisfiesRuntimeS3cr3t"],
    ["class Runtime { token?: string = OptionalRuntimeS3cr3t; }", "OptionalRuntimeS3cr3t"],
    ["runtime = { password: BareAssignRuntimeS3cr3t };", "BareAssignRuntimeS3cr3t"],
    ["runtime = condition ? fn() : { password: BareCallRuntimeS3cr3t };", "BareCallRuntimeS3cr3t"],
    ["runtime = value as Safe ? {} : { token: BareAsRuntimeS3cr3t };", "BareAsRuntimeS3cr3t"],
    ["runtime = value satisfies Safe ? {} : { clientSecret: BareSatisfiesRuntimeS3cr3t };", "BareSatisfiesRuntimeS3cr3t"],
  ];
  for (const prefix of prefixes) {
    for (const separator of ["\n", "\r\n", "\n\n", " /* tail */\n", " // tail\n"]) {
      for (const [runtime, marker] of runtimeComplements) {
        const source = `${prefix}${separator}${runtime}`;
        const safe = redactSecretAssignments(source);
        assert.equal(hasSecretAssignment(source), true, source);
        assert.ok(safe.startsWith(`${prefix}${separator}`), source);
        assert.doesNotMatch(safe, new RegExp(marker), source);
        assert.equal(hasSecretAssignment(safe), false, safe);
      }
    }
  }
});

test("multiline type-alias expressions remain byte-identical until a real statement boundary", () => {
  const headers = [
    "type X =",
    "type X<T> =",
    "type X<T extends { safe: string } = { safe: string }> =",
  ];
  const separators = ["\n  ", "\n  // safe\n  ", "\n  /* safe */\n  "];
  const expressions = [
    "{ token: string; password: string }",
    "[{ token: string }, { password: string }]",
    "readonly [{ token: string }, { password: string }]",
    "Array<{ token: string }>",
    "Promise<{ password: string }>",
    "Record<string, { token: string }>",
    "({ token: string } | { password: string })",
    "(value: string) => { token: string }",
    "new () => { password: string }",
    "abstract new () => { token: string }",
    "Base | { token: string }",
    "Base & { password: string }",
    "T extends U ? { token: string } : { password: string }",
    "keyof { token: string; password: string }",
    "keyof ({ token: string; password: string })",
    "Readonly<{ token: string }>",
    "[head: { token: string }, tail: { password: string }]",
    "typeof obj & { token: string }",
    'import("pkg").Thing & { password: string }',
    "| { token: string } | { password: string }",
    "& { token: string } & { password: string }",
  ];
  for (const header of headers) {
    for (const separator of separators) {
      for (const expression of expressions) {
        const source = `${header}${separator}${expression};`;
        assert.equal(hasSecretAssignment(source), false, source);
        assert.equal(redactSecretAssignments(source), source, source);
      }
    }
  }
});

test("ASI runtime redaction does bounded reverse line searches", () => {
  const input = "type G<T> = T\nconst runtime = { password: SecretValue };\n".repeat(2_000);
  const originalLastIndexOf = String.prototype.lastIndexOf;
  let searchedCharacters = 0;
  String.prototype.lastIndexOf = function countedLastIndexOf(search, ...args) {
    const result = Reflect.apply(originalLastIndexOf, this, [search, ...args]);
    if (this.length === input.length && (search === "\r" || search === "\n")) {
      const requested = args.length > 0 ? Number(args[0]) : this.length - 1;
      const from = Math.max(0, Math.min(Number.isFinite(requested) ? requested : this.length - 1, this.length - 1));
      searchedCharacters += result === -1 ? from + 1 : Math.max(0, from - result + 1);
    }
    return result;
  };
  let output;
  try {
    output = redactSecretAssignments(input);
  } finally {
    String.prototype.lastIndexOf = originalLastIndexOf;
  }
  assert.doesNotMatch(output, /SecretValue/);
  assert.equal(hasSecretAssignment(output), false);
  assert.ok(searchedCharacters < input.length * 2, `scanner reverse-searched ${searchedCharacters} characters for ${input.length} input characters`);
});

test("unterminated assignment comments do not cause superlinear prefix scans", () => {
  const measure = (count) => {
    const input = "password /* ".repeat(count);
    const started = process.hrtime.bigint();
    assert.equal(hasSecretAssignment(input), false);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  measure(100);
  const smallMs = measure(4_000);
  const largeMs = measure(8_000);
  assert.ok(largeMs < 1_000, "96KB unterminated-comment scan took " + largeMs.toFixed(1) + "ms");
  assert.ok(largeMs < Math.max(100, smallMs * 3.5), "scan growth was " + smallMs.toFixed(1) + "ms -> " + largeMs.toFixed(1) + "ms");
});

test("logical assignments and shadowed duplicate JSON secrets are detected and scrubbed", () => {
  for (const input of [
    "function graphResult(): Promise<{ token: string }> { throw new Error(); }",
    "function multilineResult():\n  Promise<{\n    token: string\n  }> { throw new Error(); }",
    "const graphItems: Array<{ token: string }> = [];",
    "const typedFactory: () => Promise<{ token: string }> = async () => ({ safe: true });",
    "declare const parenthesizedFactory: () => ({ token: string } | { password: string });",
    "type GenericAlias<T extends { token: string } = { password: string }> = T;",
    "type GenericTokenDefault<TToken extends string = string> = TToken;",
    "interface GenericDefault<T extends { token: string } = { password: string }> { value: T }",
    "class GenericVault<T extends { token: string } = { password: string }> {}",
    "function genericDefault<T extends { token: string } = { password: string }>(value: { clientSecret: string }): void {}",
    "const assertedType = {} as { token: string } | { password: string };",
    "const satisfiedType = {} satisfies { token: string } & { password?: string };",
    "const conditionalType = value as T extends U ? { token: string } : { password: string };",
    "interface OptionalShape { token?: string }",
    'type OptionalAlias = { "accessToken"?: string };',
    "class OptionalComplexTypes { token?: { value: string }; password?: [string, number]; accessToken?: (() => string); clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }); }",
    "interface OptionalComplexInterface { token?: { value: string }; password?: [string, number]; accessToken?: (() => string) }",
    "type OptionalComplexAlias = { clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }) };",
    'private_key="[REDACTED]"\nlabel="[REDACTED]"',
    'private_key="[REDACTED]"\ndescription="""line one\nline two"""',
    'private_key="[REDACTED]"\n[section]\ndescription="safe"',
    '{"tokenCount":5}',
  ]) {
    assert.equal(hasSecretAssignment(input), false);
    assert.equal(redactSecretAssignments(input), input);
  }
  assert.equal(isSecretKey("tokenCount"), false);
  assert.equal(isSecretKey("input_token_count"), false);
  assert.equal(isSecretKey("TOKEN_VALUE"), true);
  for (const input of [
    'process.env.API_KEY ||= "logical-or-secret"',
    'process.env.ACCESS_TOKEN ??= "logical-nullish-secret"',
    'config["clientSecret"] &&= "logical-and-secret"',
    'SIGNING_KEY=signing-key-secret',
    'ENCRYPTION_KEY=encryption-key-secret',
    'SESSION_KEY=session-key-secret',
    'function f<T>(TToken = "runtime-generic-default-secret"): void {}',
    'class Auth { token?: { value: string } = { value: "optional-object-secret" }; }',
    'class Auth { password?: [string, number] = ["optional-tuple-secret", 1]; }',
    'class Auth { accessToken?: (() => string) = () => "optional-function-secret"; }',
    'class Auth { clientSecret?: Promise<{ value: string }> = Promise.resolve({ value: "optional-generic-secret" }); }',
    'class Auth { refreshToken?: string | { value: string } = { value: "optional-union-secret" }; }',
    'class Auth { sessionToken?: (string | { value: string }) = { value: "optional-paren-union-secret" }; }',
    'class Auth { cookie?: {\n value: string\n} = { value: "optional-multiline-secret" }; }',
    'class Auth { ["accessToken"]?: { value: string } = { value: "optional-computed-object-secret" }; }',
    'type G<T> = T; const value = condition ? fn() : { password: RuntimeAfterGenericSecret };',
    'type G<T> = T; const value = input as Safe ? {} : { token: AsAfterGenericSecret };',
    'type G<T> = T; const value = input satisfies Safe ? {} : { clientSecret: SatisfiesAfterGenericSecret };',
    'private_key="[REDACTED]"\nlabel="[REDACTED]"\nTomlTwoS3cr3t"""',
    'private_key="[REDACTED]"\n[section]\nTomlTwoS3cr3t"""',
    'private_key="[REDACTED]"\r\nlabel="[REDACTED]"\r\nTomlTwoS3cr3t"""',
    "private_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nTomlTwoS3cr3t'''",
  ]) {
    assert.equal(hasSecretAssignment(input), true);
    const safe = redactSecretAssignments(input);
    assert.equal(hasSecretAssignment(safe), false);
    assert.doesNotMatch(safe, /logical-(?:or|nullish|and)-secret|(?:signing|encryption|session)-key-secret/);
  }
  for (const [input, expected] of [
    ['{"password":"hunter2","password":"[REDACTED]"}', '{"password":"[REDACTED]"}'],
    ['{"safe":"password=hunter2","safe":"ok"}', '{"safe":"ok"}'],
    ['{"credentials":{"token":"hunter2"},"credentials":{"token":"[REDACTED]"}}', '{"credentials":{"token":"[REDACTED]"}}'],
    ['{"pass\\u0077ord":"hunter2","pass\\u0077ord":"[REDACTED]"}', '{"password":"[REDACTED]"}'],
    ['{"note":"pass\\u0077ord=hunter2","note":"safe"}', '{"note":"safe"}'],
  ]) {
    assert.equal(hasSecretAssignment(input), true);
    assert.equal(redactSecretAssignments(input), expected);
  }
  for (const input of [
    'const token /* keep-comment */ = "commented-key-secret";',
    'config["accessToken"] /* keep-comment */ = "commented-bracket-secret";',
    "/* password=comment-secret */",
    "token /* password=inner-comment-secret */ = outer-comment-secret;",
    'password="" + "compound-rhs-secret";',
    'const refreshToken = condition\n  ? "conditional-first-secret"\n  : "conditional-second-secret";',
    'const clientSecret = /* keep-comment */\n  "commented-rhs-secret";',
    'const token =\n  // selected secret\n  "continued-comment-secret";',
    'const token =\n\n  // selected secret\n  "blank-comment-secret";',
    'token += "compound-plus-secret";',
    'config["accessToken"] += "compound-bracket-secret";',
    'const cfg = { pass\\u0077ord: "unicode-js-secret" };',
    'const cfg = { "pass\\u0077ord": "unicode-quoted-secret" };',
    'const cfg = { pass\\u{77}ord: "unicode-codepoint-secret" };',
    'config["access\\u0054oken"] = "unicode-bracket-secret";',
    'config["access\\x54oken"] = "hex-bracket-secret";',
    'config["pass\\uZZZZord"] = "malformed-key-secret";',
    'config["_token"] = "leading-key-secret";',
    'const tokenFactory: () => string = "typed-function-secret";',
    '```json\n{"pass\\u0077ord":"fenced-json-secret"}\n```',
  ]) {
    assert.equal(hasSecretAssignment(input), true);
    const safe = redactSecretAssignments(input);
    assert.equal(hasSecretAssignment(safe), false);
    assert.doesNotMatch(safe, /commented-(?:key|bracket|rhs)-secret|(?:continued|blank)-comment-secret|(?:inner-|outer-)?comment-secret|compound-(?:rhs|plus|bracket)-secret|conditional-(?:first|second)-secret|unicode-(?:js|quoted|codepoint|bracket)-secret|hex-bracket-secret|malformed-key-secret|leading-key-secret|typed-function-secret|fenced-json-secret/);
  }
  for (const input of ["Bearer abcdefghijklmnop", "Bearer SuperSecret", "Basic dTpw", "Basic Og==", "Basic OnA=", "Basic dTo="]) {
    assert.equal(hasCredentialShape(input), true);
    assert.equal(redactCredentialShapes(input), "[REDACTED]");
  }
  for (const input of ["Basic plan", "Basic tier", "Basic auth", "Choose the Basic plan for teams.", "Bearer authentication is supported", "Bearer representational systems are supported"]) {
    assert.equal(hasCredentialShape(input), false);
    assert.equal(redactCredentialShapes(input), input);
  }
  for (const input of [
    "ENV API_KEY docker-env-secret",
    "ENV ACCESS_TOKEN \\\n  continued-docker-secret",
    "run --password cli-password-secret",
    'run --token "cli-token-secret"',
    "run --password \\\n  cli-continued-secret",
    "#define PASSWORD define-secret",
    '{ "password" => "ruby-hash-secret" }',
    '{ :accessToken => "ruby-symbol-secret" }',
    '$config = ["token" => "php-hash-secret"];',
    "- name: API_KEY\n  value: kubernetes-value-secret\n- name: SAFE\n  value: retained",
    "- name: API_KEY\n  # selected\n  value: kubernetes-comment-secret",
    "- name: API_KEY\n\n  value: kubernetes-blank-secret",
    "CREATE USER demo WITH PASSWORD 'sql-password-secret';",
    "CREATE ROLE app WITH LOGIN PASSWORD 'pgsql-secret';",
    "CREATE ROLE app WITH LOGIN CONNECTION LIMIT 5 PASSWORD 'pgsql-limit-secret';",
    "ALTER ROLE app VALID UNTIL '2027-01-01' PASSWORD 'pgsql-valid-secret';",
  ]) {
    assert.equal(hasSecretAssignment(input), true);
    assert.equal(hasSecretAssignment(redactSecretAssignments(input)), false);
  }
  assert.equal(
    redactSecretAssignments("- name: API_KEY\n  value: kubernetes-value-secret\n- name: SAFE\n  value: retained"),
    "- name: API_KEY\n  value: [REDACTED]\n- name: SAFE\n  value: retained",
  );
  assert.equal(
    redactSecretAssignments('```json\n{"pass\\u0077ord":"fenced-json-secret"}\n```'),
    '```json\n{"pass\\u0077ord":"[REDACTED]"}\n```',
  );
  assert.equal(
    redactSecretAssignments("token /* password=inner-comment-secret */ = outer-comment-secret;"),
    "token /* password=[REDACTED] */ = [REDACTED];",
  );
  const conditional = "password=ok\n ? \"A\"\n : \"B\";";
  const redactedConditional = "password=[REDACTED];";
  assert.equal(redactSecretAssignments(conditional), redactedConditional);
  assert.equal(hasSecretAssignment(redactedConditional), false);
  assert.equal(redactSecretAssignments(redactedConditional), redactedConditional);
  const tomlResidue = 'private_key="[REDACTED]"\nTomlTwoS3cr3t"""';
  assert.equal(hasSecretAssignment(tomlResidue), true);
  assert.equal(redactSecretAssignments(tomlResidue), 'private_key="[REDACTED]"');
});

test("Graphify failures carry the tool's bounded stderr cause", async (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  writeSource(sourceRoot, "container/gate.js");

  await assert.rejects(runGraphifyCodeMap({
    sourceRoot,
    resultDir: path.join(root, "result"),
    files: ["container/gate.js"],
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async () => {
      const error = new Error("command failed");
      error.stderr = "parser setup failed because tree-sitter could not load\n";
      throw error;
    },
  }), /extract failed: parser setup failed because tree-sitter could not load/);

  for (const [name, stderr, leaked] of [
    ["duplicate-json", '{"password":"cause-json-secret","password":"[REDACTED]"}', /cause-json-secret/],
    ["logical-assignment", 'process.env.API_KEY ||= "cause-logical-secret"', /cause-logical-secret/],
  ]) {
    await assert.rejects(runGraphifyCodeMap({
      sourceRoot,
      resultDir: path.join(root, `result-${name}`),
      files: ["container/gate.js"],
      buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
      execute: async () => {
        const error = new Error("command failed");
        error.stderr = stderr;
        throw error;
      },
    }), (error) => {
      assert.doesNotMatch(error.message, leaked);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  }
});

test("the bounded child runner reports stderr and marks an unclosed timeout as unproven", async () => {
  const failed = new EventEmitter();
  failed.stdout = new EventEmitter();
  failed.stderr = new EventEmitter();
  failed.kill = () => true;
  const failure = runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => failed,
    timeoutMs: 100,
    killGraceMs: 20,
  });
  failed.stderr.emit("data", Buffer.from("the parser named its own cause\n"));
  failed.emit("close", 7, null);
  await assert.rejects(failure, /the parser named its own cause/);

  const hung = new EventEmitter();
  hung.stdout = new EventEmitter();
  hung.stderr = new EventEmitter();
  let killed = 0;
  hung.kill = () => { killed++; return true; };
  const timeout = runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => hung,
    timeoutMs: 5,
    killGraceMs: 5,
  });
  await assert.rejects(timeout, (error) => {
    assert.match(error.message, /timed out after 5ms.*did not close/i);
    assert.equal(error.terminationUnproven, true);
    return true;
  });
  assert.equal(killed, 1);

  const malformed = new EventEmitter();
  let setupKill = 0;
  malformed.kill = () => { setupKill++; return true; };
  await assert.rejects(runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => malformed,
  }), (error) => {
    assert.match(error.message, /without observable stdout, stderr, or lifecycle events/);
    assert.equal(error.terminationUnproven, true);
    return true;
  });
  assert.equal(setupKill, 1, "a partially started child is killed before the lane is quarantined");
});

test("a child error after spawn or PID needs close proof or marks termination unproven", async () => {
  const unclosed = new EventEmitter();
  unclosed.stdout = new EventEmitter();
  unclosed.stderr = new EventEmitter();
  let unclosedKills = 0;
  unclosed.kill = () => { unclosedKills++; return true; };
  const unclosedRun = runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => unclosed,
    timeoutMs: 100,
    killGraceMs: 5,
  });
  unclosed.emit("spawn");
  unclosed.emit("error", new Error("post-spawn lifecycle failure"));
  await assert.rejects(unclosedRun, (error) => {
    assert.match(error.message, /post-spawn lifecycle failure/);
    assert.equal(error.conclusiveNoChild, undefined);
    assert.equal(error.terminationUnproven, true);
    return true;
  });
  assert.equal(unclosedKills, 1);

  const closed = new EventEmitter();
  closed.pid = 4343;
  closed.stdout = new EventEmitter();
  closed.stderr = new EventEmitter();
  closed.kill = () => true;
  const closedRun = runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => closed,
    timeoutMs: 100,
    killGraceMs: 20,
  });
  closed.emit("error", new Error("observable post-spawn failure"));
  closed.emit("close", null, "SIGKILL");
  await assert.rejects(closedRun, (error) => {
    assert.match(error.message, /observable post-spawn failure/);
    assert.equal(error.conclusiveNoChild, undefined);
    assert.equal(error.terminationUnproven, undefined);
    return true;
  });

  const preSpawn = new EventEmitter();
  preSpawn.stdout = new EventEmitter();
  preSpawn.stderr = new EventEmitter();
  preSpawn.kill = () => true;
  const preSpawnRun = runBoundedCommand({ bin: "fixture", args: [] }, {
    spawn: () => preSpawn,
    timeoutMs: 100,
  });
  preSpawn.emit("error", new Error("spawn refused"));
  await assert.rejects(preSpawnRun, (error) => {
    assert.match(error.message, /did not start: spawn refused/);
    assert.equal(error.conclusiveNoChild, true);
    assert.equal(error.terminationUnproven, undefined);
    return true;
  });
});

// A file the box may not READ must never destroy a whole map. Live 2026-08-15:
// one 0600 agent-owned note in the operator's vault returned the entire vault
// graph as HTTP 500 GRAPHIFY_FAILED, because every openSync failure was treated
// alike. The hardened checks around it -- O_NOFOLLOW, nlink, "changed during
// validation", realpath recheck -- are attack-shaped and MUST stay fatal.
// EACCES is not: it is stable, benign, and no retry changes it.
//
// Structural assertions on purpose. Reproducing EACCES needs POSIX permissions
// that Windows does not honour, so a filesystem test would silently no-op on
// half the machines that run this suite -- a guard that cannot fail is the
// thing this whole file exists to prevent.
test("a corpus file the box may not read is skipped and named, never fatal", () => {
  const lib = fs.readFileSync(new URL("../container/graphify-lib.js", import.meta.url), "utf8");
  const snapshot = lib.slice(
    lib.indexOf("function materializeCorpusSnapshot"),
    lib.indexOf("function buildGraphifyCommand"),
  );
  assert.ok(snapshot, "materializeCorpusSnapshot must be readable for this guard");

  // EACCES ONLY. EPERM is deliberately NOT survivable: on open() it can signal
  // an LSM/capability denial or an immutable file, which are anomaly-shaped
  // rather than the plain "this uid may not read this file" fact that makes
  // skipping safe. (Kimi, PR #424.)
  assert.match(snapshot, /const denied = error && error\.code === "EACCES";/,
    "only EACCES may be survivable; every other open failure, EPERM included, stays fatal");
  assert.doesNotMatch(snapshot, /error\.code === "EPERM"/,
    "EPERM must not silently rejoin the survivable set without its own argument");
  assert.match(snapshot, /unreadable\.push\(\{ relative: record\.relative, code: error\.code \}\)/,
    "a skipped file must be NAMED, or the map silently omits data and says nothing");
  assert.match(snapshot, /if \(record\.skipped\) continue;/,
    "the post-copy recheck must skip files that were never opened, or it dereferences record.opened");
  assert.match(snapshot, /if \(!manifestEntries\.length && unreadable\.length\)/,
    "a corpus where NOTHING was readable is a failure, not a partial success with an empty map");
  assert.match(snapshot, /return \{ files: manifestEntries[^}]*unreadable \}/,
    "the skipped list must reach the caller so it can be surfaced to the operator");

  // Reaching the caller is NOT enough, and this is the part I got wrong first:
  // the caller used only maxMtimeMs and manifestSha256, so the skipped list
  // went nowhere and the map looked complete. A partial corpus that cannot say
  // what is missing is worse than the total failure it replaced, because the
  // operator has no way to know. It must appear in the RECEIPT they read.
  const runner = lib.slice(lib.indexOf("const materialized = materializeCorpusSnapshot("));
  assert.match(runner.slice(0, 2000), /unreadable: materialized\.unreadable\.map\(/,
    "the snapshot receipt must NAME the skipped files, or the omission is silent");
  assert.match(runner.slice(0, 2000), /unreadableCount: materialized\.unreadable\.length/,
    "the receipt must state HOW MANY were skipped, since the named list is capped");

  // The fatal paths stay fatal. If this ever stops matching, the hardening that
  // makes the survivable case safe has been removed along with it.
  for (const [what, pattern] of [
    ["a source that changed during the snapshot", /Graphify corpus source changed during the snapshot/],
    ["a non-permission open failure", /Graphify corpus source could not be safely opened/],
    ["a corpus root that changed", /Graphify corpus root changed while the snapshot was copied/],
  ]) {
    assert.match(snapshot, pattern, `${what} must remain fatal`);
  }
});
