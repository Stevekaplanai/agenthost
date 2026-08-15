import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dashboardRequire = createRequire(path.join(import.meta.dirname, "..", "dashboard", "package.json"));
const typescript = dashboardRequire("typescript");
const {
  GRAPHIFY_FOLDER_LIMITS,
  buildGraphifySnapshotCommand,
  runBoundedCommand,
  runGraphifySnapshot,
} = require("../container/graphify-lib.js");

function assertTypeScriptSyntax(source) {
  const result = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || [])
    .filter((diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error)
    .map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  assert.deepEqual(errors, []);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-folder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, body) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  return { root, write };
}

function plan(sourceRoot, overrides = {}) {
  return {
    target: { id: "folder:fixture", label: "Fixture corpus", kind: "folder" },
    folder: { id: "f_0123456789abcdef01234567", label: "All" },
    sourceRoot,
    includeRoots: ["."],
    extensions: [".js", ".json", ".md", ".toml", ".ts"],
    allowedBasenames: ["README"],
    maxDepth: 8,
    redactInputs: true,
    snapshotKind: "folder",
    ...overrides,
  };
}

function writeOutput(scratchDir, sourceFile = "src/app.ts") {
  const output = path.join(scratchDir, "graphify-out");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Cluster report\n\nOne seam.\n");
  fs.writeFileSync(path.join(output, "graph.json"), JSON.stringify({
    directed: true,
    multigraph: true,
    graph: {},
    nodes: [
      { id: "app", label: "app", source_file: sourceFile, source_location: "L1", community: 1 },
      { id: "readme", label: "README", source_file: "README.md", source_location: "L1", community: 1 },
    ],
    links: [
      { source: "readme", target: "app", relation: "references", confidence: "EXTRACTED", source_file: "README.md" },
      { source: "app", target: "readme", relation: "related", confidence: "model-guessed", source_file: sourceFile },
    ],
    hyperedges: [],
  }));
}

test("the folder extractor and cluster stages stay exact-versioned, local, and networkless", () => {
  const extract = buildGraphifySnapshotCommand({
    stage: "extract",
    inputDir: "/tmp/source",
    scratchDir: "/tmp/scratch",
    packageDir: "/opt/agenthost/graphify-python",
    runnerScript: "/opt/agenthost/graphify-folder-extract.py",
  });
  assert.equal(extract.bin, "/usr/bin/bwrap");
  assert.equal(extract.args[0], "--unshare-net");
  assert.ok(extract.args.includes("--clearenv"));
  assert.ok(extract.args.includes("--unshare-pid"));
  const extractText = extract.args.join(" ");
  assert.match(extractText, /--ro-bind-try \/tmp\/source \/source/);
  assert.match(extractText, /--ro-bind-try \/opt\/agenthost\/graphify-folder-extract\.py \/runner\/graphify-folder-extract\.py/);
  assert.match(extractText, /\/runner\/graphify-folder-extract\.py \/source \/scratch\/graphify-out\/graph\.json/);
  assert.doesNotMatch(extractText, /--backend|claude|api[_-]?key|--code-only/i);

  const cluster = buildGraphifySnapshotCommand({
    stage: "cluster",
    inputDir: "/tmp/source",
    scratchDir: "/tmp/scratch",
  });
  assert.equal(cluster.args[0], "--unshare-net");
  assert.match(cluster.args.join(" "), /cluster-only \/scratch --no-viz --max-concurrency 1/);
});

test("the deterministic extractor ignores fenced wiki-link examples and binds file metadata once", (t) => {
  const python = (process.platform === "win32" ? ["python"] : ["python3", "python"])
    .find((candidate) => spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
  if (!python) {
    t.skip("Python is unavailable; the locked image smoke covers the extractor runtime");
    return;
  }
  const { root, write } = fixture(t);
  write(".agenthost-corpus.json", JSON.stringify({
    files: { "README.md": { asset: "voice", claims: [{ claim: "clear", confidence: "EXTRACTED" }] } },
  }));
  const script = [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    "spec = importlib.util.spec_from_file_location('agenthost_graphify_extract', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "text = '[[live-note]]\\n```md\\n[[example-only]]\\n```\\n~~~\\n[[also-example]]\\n~~~\\n'",
    "visible = module.markdown_without_fenced_blocks(text)",
    "nodes = [",
    "  {'id':'file-node','source_file':'README.md','source_location':'L1','agenthost_kind':'file'},",
    "  {'id':'heading-node','source_file':'README.md','source_location':'L2'},",
    "]",
    "module.apply_graph_metadata(Path(sys.argv[2]), nodes)",
    "print(json.dumps({'links': module.WIKILINK_RE.findall(visible), 'nodes': nodes}))",
  ].join("\n");
  const result = spawnSync(python, ["-B", "-c", script, path.join(import.meta.dirname, "..", "container", "graphify-folder-extract.py"), root], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.links, ["live-note"]);
  assert.equal(observed.nodes[0].asset, "voice");
  assert.equal(observed.nodes[0].claims.length, 1);
  assert.equal("claims" in observed.nodes[1], false, "secondary Graphify nodes cannot duplicate file-level claims");
});

test("one folder plan produces a stamped report, private graph, and offline interactive HTML", async (t) => {
  const { root, write } = fixture(t);
  write("src/app.ts", "export const app = true;\n");
  write("README.md", "# Fixture\n\n[[src/app]]\n");
  write("config.toml", "[mcp_servers.example]\ncommand='npx'\n");
  write("ignored.bin", "not selected\n");
  write("node_modules/no.js", "export const hidden = true;\n");
  write(".git/config", "never copied\n");
  const newest = new Date("2026-08-14T12:34:56.000Z");
  const older = new Date("2026-08-14T12:00:00.000Z");
  fs.utimesSync(path.join(root, "src", "app.ts"), older, older);
  fs.utimesSync(path.join(root, "config.toml"), older, older);
  fs.utimesSync(path.join(root, "README.md"), newest, newest);
  const stages = [];

  const result = await runGraphifySnapshot({
    plan: plan(root),
    now: () => new Date("2026-08-14T13:00:00.000Z"),
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => {
      stages.push(context.stage);
      const staged = fs.readdirSync(context.inputDir, { recursive: true })
        .filter((entry) => fs.statSync(path.join(context.inputDir, entry)).isFile())
        .map((entry) => entry.split(path.sep).join("/"));
      assert.ok(staged.includes("src/app.ts"));
      assert.ok(staged.includes("README.md"));
      assert.ok(staged.includes("config.toml"));
      assert.ok(staged.includes(".agenthost-corpus.json"));
      assert.equal(staged.some((entry) => entry.includes("node_modules") || entry.includes(".git") || entry.endsWith(".bin")), false);
      if (context.stage === "cluster") writeOutput(context.scratchDir);
    },
  });

  assert.deepEqual(stages, ["extract", "cluster"]);
  assert.equal(result.snapshot.kind, "folder");
  assert.equal(result.snapshot.value, newest.toISOString());
  assert.match(result.snapshot.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.snapshot.derived, true);
  assert.deepEqual(result.counts, { files: 3, inputBytes: 91, nodes: 2, links: 2 });
  assert.equal(result.graph.links[1].confidence, "AMBIGUOUS");
  assert.deepEqual(result.graph.graph.agenthost_snapshot, result.snapshot);
  assert.match(result.report, /Target: Fixture corpus/);
  assert.match(result.report, /Folder: All/);
  assert.match(result.report, new RegExp(result.snapshot.manifestSha256));
  assert.match(result.html, /Interactive relationship graph/);
  assert.match(result.html, /connect-src 'none'/);
  assert.doesNotMatch(result.html, /https?:\/\/|unpkg|vis-network/);
});

test("credential values are redacted inside the frozen snapshot before Graphify sees it", async (t) => {
  const { root, write } = fixture(t);
  const secret = "secret-value-123456789";
  const inheritedCamelSecret = "unlabelled-camel-env-secret";
  const priorAccessToken = process.env.accessToken;
  const priorGraphifySecret = process.env.GRAPHIFY_TEST_SECRET;
  process.env.accessToken = inheritedCamelSecret;
  process.env.GRAPHIFY_TEST_SECRET = secret;
  t.after(() => {
    if (priorAccessToken === undefined) delete process.env.accessToken;
    else process.env.accessToken = priorAccessToken;
    if (priorGraphifySecret === undefined) delete process.env.GRAPHIFY_TEST_SECRET;
    else process.env.GRAPHIFY_TEST_SECRET = priorGraphifySecret;
  });
  const sessionSecret = "plain-session-secret";
  const cookieSecret = "sessionid=plain-cookie-secret";
  const jwtSecret = "eyJabcdefgh.ijklmnop.qrstuvwx";
  const githubSession = `ghs_${"a".repeat(24)}`;
  write("settings.json", JSON.stringify({
    apiKey: secret,
    accessToken: "plain-access-token",
    refreshToken: "plain-refresh-token",
    clientSecret: "plain-client-secret",
    cookie: cookieSecret,
    session: sessionSecret,
    credentials: { token: "nested-json-token-secret", username: "nested-json-user-secret" },
    auth: { cookie: "nested-json-cookie-secret", label: "nested-json-label-secret" },
    databaseUrl: "postgres://dbuser:json-db-secret@db/app",
    mongoUri: "mongodb+srv://dbuser:json-mongo-secret@cluster/app",
    tokenCount: 5,
    sessionTimeout: 30,
    mcpServers: { demo: { headers: { Authorization: `Bearer ${secret}` }, command: "npx" } },
  }));
  write("duplicate.json", '{"pass\\u0077ord":"escaped-password-secret","pass\\u0077ord":"[REDACTED]","note":"access\\u0054oken=escaped-note-secret","note":"safe"}');
  write("README.md", `# Safe inventory\n\nsk-ABCDEFGHIJKLMNOPQRSTUVWX\n${githubSession}\n${jwtSecret}\n${secret}\n${inheritedCamelSecret}\npassword=hunter2\npassword=alpha,beta;gamma}\npassword: SuperSecret\nAWS_SECRET_ACCESS_KEY=alphaSecretValue\nservice_passphrase=correct horse battery staple\nbearerToken=plain-bearer-secret\nprivateKey=plain-private-secret\nsessionToken=plain-session-token\nJWTToken=plain-jwt-secret\nmyURLToken=plain-url-secret\nOPENAI_API_KEY_PROD=suffix-api-secret\nDATABASE_URL_READONLY=suffix-database-secret\nSESSION_ID_BACKUP=suffix-session-secret\nSESSIONID=suffix-compact-session-secret\nprocess.env["API_KEY"] = "plain-bracket-env-secret"\nconfig['accessToken']=\"plain-bracket-config-secret\"\nos.environ["AWS_SECRET_ACCESS_KEY"]="plain-bracket-python-secret"\n$env:API_KEY=plain-powershell-secret\ncookie=${cookieSecret}\nsession: ${sessionSecret}\naccessToken=plain-access-token\nrefreshToken=plain-refresh-token\nclientSecret=plain-client-secret\nconst config = { accessToken: "nested-access-secret" };\nconst opts = { cookie: "nested-cookie-secret" };\nconst type = "login"; const cfg = { password: "nested-type-prefix-secret" };\npayload = { clientSecret: \`nested-client-secret\` }\nDATABASE_DSN=host=db.local password=nested-dsn-password-secret\nDATABASE_URL=postgres://dbuser:assignment-db-secret@db/app\nconnection sample: redis://:uri-db-secret@cache/0\nsource_url=https://example.com/public\nnote: cookie=nested-note-cookie-secret\nouter=accessToken=nested-tight-secret\nconst privateKey = \`template-line-one-secret\ntemplate-line-two-secret\`;\nprivate_key = """toml-line-one-secret\ntoml-line-two-secret"""\npassword: |\n  yaml-line-one-secret\n  yaml-line-two-secret\nsafeAfterBlock: retained\npassword:\nsafeOptional: yes\n-----BEGIN OPENSSH PRIVATE KEY-----\npem-body-secret\n-----END OPENSSH PRIVATE KEY-----\nif (token === undefined) return ok;\ntype Config = { token: string; enabled: boolean };\n`);
  fs.appendFileSync(path.join(root, "README.md"), `type Inline = { token: string; }; const cfgAfterType = { password: "same-line-type-secret" };\ninterface InlineCredentials { token: string; } const cfgAfterInterface = { password: "same-line-interface-secret" };\nfunction authenticate(token: AuthToken): void {}\ntoken: string | null\nclass Auth { token: AuthToken; }\ntype Token = string;\ninterface MultilineCredentials {\n  token: string\n}\nconst token: string = "typed-variable-secret";\nclass TypedAuth { password: string = "typed-class-secret"; }\nconst punctuated = { password: SuperSecret, enabled: true };\napiKey: PunctuatedSecret;\nclass RuntimeAuth { config = { password: "class-object-secret" }; }\nclass RuntimeMethod { method() { return { clientSecret: "class-method-secret" }; } }\nconst token =\n  "continued-string-secret";\nconst accessToken =\n  \`continued-template-secret\`;\nsource_url=https://alice:https-userinfo-secret@example.com/private\n-----BEGIN OPENSSH PRIVATE KEY-----\nmalformed-pem-body-secret\nmalformed-pem-second-line\n`);
  write("fenced.md", '```json\n{"pass\\u0077ord":"fenced-json-secret"}\n```\n');
  write("logical.js", "process.env.API_KEY ||= \"logical-or-secret\";\nprocess.env.ACCESS_TOKEN ??= \"logical-nullish-secret\";\nconfig[\"clientSecret\"] &&= \"logical-and-secret\";\ntoken += \"compound-plus-secret\";\nconfig[\"accessToken\"] += \"compound-bracket-secret\";\nconst SIGNING_KEY = \"signing-key-secret\";\nconst ENCRYPTION_KEY = \"encryption-key-secret\";\nconst SESSION_KEY = \"session-key-secret\";\nconst bearerHeader = \"Bearer abcdefghijklmnop\";\nconst shortBearerHeader = \"Bearer SuperSecret\";\nconst basicHeader = \"Basic dTpw\";\nconst basicCopy = \"Choose the Basic plan for teams. Basic tier. Basic auth.\";\nconst bearerCopy = \"Bearer authentication is supported\";\nconst bearerLongCopy = \"Bearer representational systems are supported\";\nconst token /* keep-comment */ = \"commented-key-secret\";\nconfig[\"accessToken\"] /* keep-comment */ = \"commented-bracket-secret\";\nconst password = \"\" + \"compound-rhs-secret\";\nconst refreshToken = condition\n  ? \"conditional-first-secret\"\n  : \"conditional-second-secret\";\nconst clientSecret = /* keep-comment */\n  \"commented-rhs-secret\";\nconst privateKey =\n  // selected secret\n  \"continued-comment-secret\";\nconst sessionToken =\n\n  // selected after blank\n  \"blank-comment-secret\";\nconst escapedA = { pass\\u0077ord: \"unicode-js-secret\" };\nconst escapedB = { \"pass\\u0077ord\": \"unicode-quoted-secret\" };\nconst escapedC = { pass\\u{77}ord: \"unicode-codepoint-secret\" };\nconfig[\"access\\u0054oken\"] = \"unicode-bracket-secret\";\nconfig[\"access\\x54oken\"] = \"hex-bracket-secret\";\nconfig[\"pass\\uZZZZord\"] = \"malformed-key-secret\";\nconfig[\"_token\"] = \"leading-key-secret\";\nconst tokenFactory: () => string = \"typed-function-secret\";\nitems.map((token: string) => token);\ntype Handler = (token: string) => void;\ninterface GenericCredentials<T> { token: T }\nfunction generic<T>(token: T): void {}\nfunction blockLocalType(){ type Token = string; }\nclass GenericAuth<T> { private method(token: T): void {} }\n");
  write("comments.js", "/* password=comment-secret */\ntoken /* password=inner-comment-secret */ = outer-comment-secret;\n");
  const typeSource = "type UnionCredentials = { token: string } | { password: string };\ntype GenericCredentials = Array<{ token: string }> & { password: string };\nfunction acceptsCredentials(value: Record<string, { token: string }>): void {}\nfunction graphResult(): Promise<{ token: string }> { throw new Error(); }\nfunction multilineResult():\n  Promise<{\n    token: string\n  }> { throw new Error(); }\nconst graphItems: Array<{ token: string }> = [];\nconst typedFactory: () => Promise<{ token: string }> = async () => ({ safe: true });\ndeclare const parenthesizedFactory: () => ({ token: string } | { password: string });\ntype GenericAlias<T extends { token: string } = { password: string }> = T;\ntype GenericTokenDefault<TToken extends string = string> = TToken;\ninterface GenericDefault<T extends { token: string } = { password: string }> { value: T }\nclass GenericVault<T extends { token: string } = { password: string }> {}\nfunction genericDefault<T extends { token: string } = { password: string }>(value: T): T { return value; }\nconst assertedType = {} as { token: string };\nconst satisfiedType = {} satisfies { password?: string };\ninterface OptionalShape { token?: string }\ntype OptionalAlias = { \"accessToken\"?: string };\nclass OptionalComplexTypes { token?: { value: string }; password?: [string, number]; accessToken?: (() => string); clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }); }\ninterface OptionalComplexInterface { token?: { value: string }; password?: [string, number]; accessToken?: (() => string) }\ntype OptionalComplexAlias = { clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }) };\ninterface CommentedCredentials {\n  // harmless }\n  token: string;\n}\nclass CommentedVault { /* harmless } */ private password: string; private config: Array<{ token: string }>; }\nclass OptionalAuth { token?: string = \"optional-token-secret\"; static readonly \"accessToken\"?: string = \"optional-access-secret\"; static readonly [\"clientSecret\"]?: string = \"optional-computed-secret\"; password? = \"optional-password-secret\"; }\nclass ComplexOptionalAuth { token?: { value: string } = { value: \"optional-object-secret\" }; password?: [string, number] = [\"optional-tuple-secret\", 1]; accessToken?: (() => string) = () => \"optional-function-secret\"; clientSecret?: Promise<{ value: string }> = Promise.resolve({ value: \"optional-generic-secret\" }); refreshToken?: string | { value: string } = { value: \"optional-union-secret\" }; sessionToken?: (string | { value: string }) = { value: \"optional-paren-union-secret\" }; cookie?: {\n value: string\n} = { value: \"optional-multiline-secret\" }; static readonly [\"accessToken\"]?: { value: string } = { value: \"optional-computed-object-secret\" }; }\nfunction runtimeTypedResult(): Promise<{ safe: string }> { return { token: \"runtime-return-secret\", safe: \"ok\" }; }\nconst runtimeAsserted = { token: \"runtime-as-secret\" } as { token: string };\nconst runtimeSatisfied = { accessToken: \"runtime-satisfies-secret\" } satisfies { accessToken: string };\nconst runtimeCallTernary = condition ? fn() : { password: CallTernarySecret };\nconst runtimeAsTernary = value as Safe ? {} : { token: AsTernarySecret };\nconst runtimeSatisfiesTernary = value satisfies Safe ? {} : { clientSecret: SatisfiesTernarySecret };\ntype StickyGeneric<T> = T;\nconst runtimeAfterGeneric = condition ? fn() : { password: RuntimeAfterGenericSecret };\nconst runtimeAsAfterGeneric = value as Safe ? {} : { token: AsAfterGenericSecret };\nconst runtimeSatisfiesAfterGeneric = value satisfies Safe ? {} : { clientSecret: SatisfiesAfterGenericSecret };\nfunction runtimeGenericDefault<T>(TToken = \"runtime-generic-default-secret\"): void {}\npassword = [REDACTED];\n";
  const asiTypeSource = "type StickyAsiCall<T> = T\nconst runtimeAfterAsiGeneric = condition ? fn() : { password: RuntimeAfterAsiGenericSecret };\ntype StickyAsiAs<T> = T /* tail */\nconst runtimeAsAfterAsiGeneric = value as Safe ? {} : { token: AsAfterAsiGenericSecret };\ntype StickyAsiSatisfies<T> = T // tail\nconst runtimeSatisfiesAfterAsiGeneric = value satisfies Safe ? {} : { clientSecret: SatisfiesAfterAsiGenericSecret };\ndeclare let runtimeAsiBare: unknown;\ntype StickyAsiBare<T> = T\nruntimeAsiBare = { password: BareAfterAsiGenericSecret };\n";
  const continuedAliasSource = "type ContinuedArray =\n  Array<{ token: string }>;\ntype ContinuedReadonly<T> =\n  // safe\n  readonly [{ token: T }, { password: string }];\ntype ContinuedComplex<T extends { safe: string } = { safe: string }> =\n  /* safe */\n  keyof ({ token: T; password: string });\ntype ContinuedRuntime<T extends { safe: string } = { safe: string }> =\n  Array<{ token: T }>\nconst runtimeAfterContinuedAlias = condition ? fn() : { password: RuntimeAfterContinuedAliasSecret };\n";
  assertTypeScriptSyntax(typeSource + asiTypeSource + continuedAliasSource);
  write("types.ts", typeSource + asiTypeSource + continuedAliasSource);
  write("secrets.toml", 'private_key="""TomlOneS3cr3t\nTomlTwoS3cr3t"""\n');
  write("residue.toml", 'private_key="[REDACTED]"\nlabel="[REDACTED]"\nTomlResidueS3cr3t"""');
  write("Dockerfile", "FROM scratch\nENV API_KEY docker-env-secret\nENV ACCESS_TOKEN \\\n  continued-docker-secret\n");
  write("script.sh", "run --password cli-password-secret\nrun --token \"cli-token-secret\"\nrun --password \\\n  cli-continued-secret\n");
  write("config.h", "#define PASSWORD define-secret\n#define CLIENT_SECRET \\\n  continued-define-secret\n");
  write("config.rb", '{ "password" => "ruby-hash-secret", :accessToken => "ruby-symbol-secret" }\n');
  write("config.php", '$config = ["token" => "php-hash-secret"];\n');
  write("roles.sql", "CREATE USER demo WITH PASSWORD 'sql-password-secret';\nALTER ROLE admin WITH ENCRYPTED PASSWORD 'sql-role-secret';\nCREATE ROLE app WITH LOGIN PASSWORD 'pgsql-secret';\nCREATE ROLE limited WITH LOGIN CONNECTION LIMIT 5 PASSWORD 'pgsql-limit-secret';\nALTER ROLE expiring VALID UNTIL '2027-01-01' PASSWORD 'pgsql-valid-secret';\n");
  write("secrets.yaml", "password:\n  yaml-indented-secret\ncredentials:\n- yaml-sequence-secret\n- name: API_KEY\n  value: kubernetes-value-secret\n- name: ACCESS_TOKEN\n  # selected\n  value: kubernetes-comment-secret\n- name: CLIENT_SECRET\n\n  value: kubernetes-blank-secret\n- name: SAFE\n  value: retained\nsafeOptional:\nsafe: yes\n");
  write("k8s.yaml", "- name: API_KEY\n  value: kubernetes-value-secret\n- name: ACCESS_TOKEN\n  # selected\n  value: kubernetes-comment-secret\n- name: CLIENT_SECRET\n\n  value: kubernetes-blank-secret\n- name: SAFE\n  value: retained\n");
  let observed = "";
  let stagedSettings = null;
  let stagedDuplicate = null;
  let stagedTypes = "";
  let stagedResidue = "";
  await runGraphifySnapshot({
    plan: plan(root, {
      extensions: [".h", ".js", ".json", ".md", ".php", ".rb", ".sh", ".sql", ".toml", ".ts", ".yaml"],
      allowedBasenames: ["Dockerfile", "README"],
    }),
    fileMetadata: {
      "README.md": {
        accessToken: "metadata-access-token",
        refreshToken: "metadata-refresh-token",
        clientSecret: "metadata-client-secret",
        cookie: "metadata-cookie-secret",
        session: "metadata-session-secret",
        claims: [{ claim: "authorization=Bearer plain-secret", confidence: "EXTRACTED" }],
      },
    },
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => {
      if (context.stage === "extract") {
        const settingsText = fs.readFileSync(path.join(context.inputDir, "settings.json"), "utf8");
        stagedSettings = JSON.parse(settingsText);
        stagedDuplicate = JSON.parse(fs.readFileSync(path.join(context.inputDir, "duplicate.json"), "utf8"));
        stagedTypes = fs.readFileSync(path.join(context.inputDir, "types.ts"), "utf8");
        stagedResidue = fs.readFileSync(path.join(context.inputDir, "residue.toml"), "utf8");
        assertTypeScriptSyntax(stagedTypes);
        observed = [
          settingsText,
          "README.md", "fenced.md", "logical.js", "comments.js", "types.ts", "secrets.toml", "residue.toml", "Dockerfile", "script.sh", "config.h", "config.rb", "config.php", "roles.sql", "secrets.yaml", "k8s.yaml", "duplicate.json",
          ".agenthost-corpus.json",
        ].map((entry, index) => index === 0 ? entry : fs.readFileSync(path.join(context.inputDir, entry), "utf8")).join("\n");
      } else {
        writeOutput(context.scratchDir, "settings.json");
      }
    },
  });
  assert.doesNotMatch(observed, new RegExp(secret));
  assert.doesNotMatch(observed, /sk-ABCDEFGHIJKLMNOPQRSTUVWX/);
  assert.doesNotMatch(observed, /hunter2|alphaSecretValue|correct horse|alpha,beta|gamma|unlabelled-camel|plain-secret|plain-(?:access|refresh|client|cookie|session|bearer|private|jwt|url|bracket|powershell)|metadata-(?:access|refresh|client|cookie|session)/);
  assert.doesNotMatch(observed, /nested-(?:access|cookie|client|dsn-password|note-cookie|tight)-secret/);
  assert.doesNotMatch(observed, /(?:nested-json|template-line|toml-line|yaml-line|assignment-db|uri-db|pem-body|json-db|suffix-api|suffix-database|suffix-session|suffix-compact-session)-(?:[a-z-]+-)?secret/);
  assert.doesNotMatch(observed, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(observed, /SuperSecret|PunctuatedSecret|nested-type-prefix-secret|same-line-(?:type|interface)-secret|typed-(?:variable|class)-secret|class-(?:object|method)-secret|continued-(?:string|template)-secret|https-userinfo-secret|yaml-(?:indented|sequence)-secret|logical-(?:or|nullish|and)-secret|(?:signing|encryption|session)-key-secret|commented-(?:key|bracket|rhs)-secret|compound-rhs-secret|conditional-(?:first|second)-secret|malformed-pem-(?:body-secret|second-line)/);
  assert.doesNotMatch(observed, /(?:Bearer abcdefghijklmnop|Basic dTpw)/);
  assert.doesNotMatch(observed, /escaped-(?:password|note)-secret|(?:docker-env|continued-docker|cli-password|cli-token|cli-continued|define|continued-define|ruby-hash|ruby-symbol|php-hash|sql-password|sql-role|pgsql|pgsql-limit|pgsql-valid|kubernetes-value|kubernetes-comment|kubernetes-blank)-secret/);
  assert.doesNotMatch(observed, /fenced-json-secret|compound-(?:plus|bracket)-secret|(?:continued|blank)-comment-secret|unicode-(?:js|quoted|codepoint|bracket)-secret|hex-bracket-secret|malformed-key-secret|leading-key-secret|typed-function-secret/);
  assert.doesNotMatch(observed, /optional-(?:token|access|computed|password|object|tuple|function|generic|union|paren-union|multiline|computed-object)-secret|runtime-(?:return|as|satisfies|generic-default)-secret|(?:Runtime|As|Satisfies)AfterGenericSecret|TomlResidueS3cr3t/);
  assert.doesNotMatch(observed, /RuntimeAfterContinuedAliasSecret/);
  assert.doesNotMatch(observed, /(?:inner-|outer-)?comment-secret/);
  assert.doesNotMatch(observed, /Toml(?:One|Two)S3cr3t/);
  assert.doesNotMatch(observed, /ghs_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.match(observed, /\[REDACTED\]/);
  assert.match(observed, /const config = \{ accessToken: "\[REDACTED\]" \};/);
  assert.match(observed, /const opts = \{ cookie: "\[REDACTED\]" \};/);
  assert.match(observed, /const type = "login"; const cfg = \{ password: "\[REDACTED\]" \};/);
  assert.match(observed, /payload = \{ clientSecret: `\[REDACTED\]` \}/);
  assert.match(observed, /DATABASE_DSN=\[REDACTED\]/);
  assert.match(observed, /note: cookie=\[REDACTED\]/);
  assert.match(observed, /outer=accessToken=\[REDACTED\]/);
  assert.match(observed, /const privateKey = `\[REDACTED\]`;/);
  assert.match(observed, /private_key = """\[REDACTED\]"""/);
  assert.match(observed, /password: \[REDACTED\]/);
  assert.match(observed, /safeAfterBlock: retained/);
  assert.match(observed, /password:\r?\nsafeOptional: yes/);
  assert.match(observed, /source_url=https:\/\/example\.com\/public/);
  assert.match(observed, /if \(token === undefined\) return ok;/);
  assert.match(observed, /type Config = \{ token: string; enabled: boolean \};/);
  assert.match(observed, /type Inline = \{ token: string; \}; const cfgAfterType = \{ password: "\[REDACTED\]" \};/);
  assert.match(observed, /interface InlineCredentials \{ token: string; \} const cfgAfterInterface = \{ password: "\[REDACTED\]" \};/);
  assert.match(observed, /function authenticate\(token: AuthToken\): void \{\}/);
  assert.match(observed, /token: string \| null/);
  assert.match(observed, /class Auth \{ token: AuthToken; \}/);
  assert.match(observed, /type Token = string;/);
  assert.match(observed, /interface MultilineCredentials \{\r?\n  token: string\r?\n\}/);
  assert.match(observed, /const token: string = "\[REDACTED\]";/);
  assert.match(observed, /class TypedAuth \{ password: string = "\[REDACTED\]"; \}/);
  assert.match(observed, /class RuntimeAuth \{ config = \{ password: "\[REDACTED\]" \}; \}/);
  assert.match(observed, /class RuntimeMethod \{ method\(\) \{ return \{ clientSecret: "\[REDACTED\]" \}; \} \}/);
  assert.match(observed, /const token =\r?\n  "\[REDACTED\]";/);
  assert.match(observed, /const accessToken =\r?\n  `\[REDACTED\]`;/);
  assert.match(observed, /process\.env\.API_KEY \|\|= "\[REDACTED\]";/);
  assert.match(observed, /process\.env\.ACCESS_TOKEN \?\?= "\[REDACTED\]";/);
  assert.match(observed, /config\["clientSecret"\] &&= "\[REDACTED\]";/);
  assert.match(observed, /const SIGNING_KEY = "\[REDACTED\]";/);
  assert.match(observed, /const ENCRYPTION_KEY = "\[REDACTED\]";/);
  assert.match(observed, /const SESSION_KEY = "\[REDACTED\]";/);
  assert.match(observed, /const bearerHeader = "\[REDACTED\]";/);
  assert.match(observed, /const shortBearerHeader = "\[REDACTED\]";/);
  assert.match(observed, /const basicHeader = "\[REDACTED\]";/);
  assert.match(observed, /Choose the Basic plan for teams\. Basic tier\. Basic auth\./);
  assert.match(observed, /Bearer authentication is supported/);
  assert.match(observed, /Bearer representational systems are supported/);
  assert.match(observed, /const token \/\* keep-comment \*\/ = "\[REDACTED\]";/);
  assert.match(observed, /config\["accessToken"\] \/\* keep-comment \*\/ = "\[REDACTED\]";/);
  assert.match(observed, /const password = "\[REDACTED\]";/);
  assert.match(observed, /const refreshToken = \[REDACTED\];/);
  assert.match(observed, /const clientSecret = \/\* keep-comment \*\/\r?\n  "\[REDACTED\]";/);
  assert.match(observed, /items\.map\(\(token: string\) => token\);/);
  assert.match(observed, /type Handler = \(token: string\) => void;/);
  assert.match(observed, /interface GenericCredentials<T> \{ token: T \}/);
  assert.match(observed, /function generic<T>\(token: T\): void \{\}/);
  assert.match(observed, /token \+= "\[REDACTED\]";/);
  assert.match(observed, /config\["accessToken"\] \+= "\[REDACTED\]";/);
  assert.match(observed, /const privateKey =\r?\n  \/\/ selected secret\r?\n  "\[REDACTED\]";/);
  assert.match(observed, /const sessionToken =\r?\n\r?\n  \/\/ selected after blank\r?\n  "\[REDACTED\]";/);
  assert.match(observed, /\/\* password=\[REDACTED\] \*\//);
  assert.match(observed, /token \/\* password=\[REDACTED\] \*\/ = \[REDACTED\];/);
  assert.match(observed, /type UnionCredentials = \{ token: string \} \| \{ password: string \};/);
  assert.match(observed, /type GenericCredentials = Array<\{ token: string \}> & \{ password: string \};/);
  assert.match(observed, /function acceptsCredentials\(value: Record<string, \{ token: string \}>\): void \{\}/);
  assert.match(observed, /function graphResult\(\): Promise<\{ token: string \}> \{ throw new Error\(\); \}/);
  assert.match(stagedTypes, /function multilineResult\(\):\r?\n  Promise<\{\r?\n    token: string\r?\n  \}> \{ throw new Error\(\); \}/);
  assert.match(observed, /const graphItems: Array<\{ token: string \}> = \[\];/);
  assert.match(stagedTypes, /const typedFactory: \(\) => Promise<\{ token: string \}> = async \(\) => \(\{ safe: true \}\);/);
  assert.match(stagedTypes, /declare const parenthesizedFactory: \(\) => \(\{ token: string \} \| \{ password: string \}\);/);
  assert.match(stagedTypes, /type GenericAlias<T extends \{ token: string \} = \{ password: string \}> = T;/);
  assert.match(stagedTypes, /type GenericTokenDefault<TToken extends string = string> = TToken;/);
  assert.match(stagedTypes, /class OptionalComplexTypes \{ token\?: \{ value: string \}; password\?: \[string, number\]; accessToken\?: \(\(\) => string\);/);
  assert.match(stagedTypes, /interface OptionalComplexInterface \{ token\?: \{ value: string \}; password\?: \[string, number\]; accessToken\?: \(\(\) => string\) \}/);
  assert.match(stagedTypes, /interface GenericDefault<T extends \{ token: string \} = \{ password: string \}> \{ value: T \}/);
  assert.match(stagedTypes, /class GenericVault<T extends \{ token: string \} = \{ password: string \}> \{\}/);
  assert.match(stagedTypes, /function genericDefault<T extends \{ token: string \} = \{ password: string \}>\(value: T\): T \{ return value; \}/);
  assert.match(stagedTypes, /const assertedType = \{\} as \{ token: string \};/);
  assert.match(stagedTypes, /const satisfiedType = \{\} satisfies \{ password\?: string \};/);
  assert.match(stagedTypes, /interface OptionalShape \{ token\?: string \}/);
  assert.match(stagedTypes, /type OptionalAlias = \{ "accessToken"\?: string \};/);
  assert.match(stagedTypes, /class OptionalAuth \{ token\?: string = "\[REDACTED\]"; static readonly "accessToken"\?: string = "\[REDACTED\]"; static readonly \["clientSecret"\]\?: string = "\[REDACTED\]"; password\? = "\[REDACTED\]"; \}/);
  assert.match(stagedTypes, /function runtimeTypedResult\(\): Promise<\{ safe: string \}> \{ return \{ token: "\[REDACTED\]", safe: "ok" \}; \}/);
  assert.match(stagedTypes, /const runtimeAsserted = \{ token: "\[REDACTED\]" \} as \{ token: string \};/);
  assert.match(stagedTypes, /const runtimeSatisfied = \{ accessToken: "\[REDACTED\]" \} satisfies \{ accessToken: string \};/);
  assert.match(stagedTypes, /const runtimeCallTernary = condition \? fn\(\) : \{ password: \[REDACTED\] \};/);
  assert.match(stagedTypes, /const runtimeAsTernary = value as Safe \? \{\} : \{ token: \[REDACTED\] \};/);
  assert.match(stagedTypes, /const runtimeSatisfiesTernary = value satisfies Safe \? \{\} : \{ clientSecret: \[REDACTED\] \};/);
  assert.match(stagedTypes, /function runtimeGenericDefault<T>\(TToken = "\[REDACTED\]"\): void \{\}/);
  assert.match(stagedTypes, /class ComplexOptionalAuth \{ token\?: \{ value: string \} = \[REDACTED\]; password\?: \[string, number\] = \[REDACTED\]; accessToken\?: \(\(\) => string\) = \[REDACTED\];/);
  assert.match(stagedTypes, /clientSecret\?: Promise<\{ value: string \}> = \[REDACTED\]; refreshToken\?: string \| \{ value: string \} = \[REDACTED\]; sessionToken\?: \(string \| \{ value: string \}\) = \[REDACTED\];/);
  assert.match(stagedTypes, /cookie\?: \{\r?\n value: string\r?\n\} = \[REDACTED\]; static readonly \["accessToken"\]\?: \{ value: string \} = \[REDACTED\];/);
  assert.match(stagedTypes, /type StickyGeneric<T> = T;\r?\nconst runtimeAfterGeneric = condition \? fn\(\) : \{ password: \[REDACTED\] \};/);
  assert.match(stagedTypes, /const runtimeAsAfterGeneric = value as Safe \? \{\} : \{ token: \[REDACTED\] \};/);
  assert.match(stagedTypes, /const runtimeSatisfiesAfterGeneric = value satisfies Safe \? \{\} : \{ clientSecret: \[REDACTED\] \};/);
  assert.match(stagedTypes, /type StickyAsiCall<T> = T\r?\nconst runtimeAfterAsiGeneric = condition \? fn\(\) : \{ password: \[REDACTED\] \};/);
  assert.match(stagedTypes, /type StickyAsiAs<T> = T \/\* tail \*\/\r?\nconst runtimeAsAfterAsiGeneric = value as Safe \? \{\} : \{ token: \[REDACTED\] \};/);
  assert.match(stagedTypes, /type StickyAsiSatisfies<T> = T \/\/ tail\r?\nconst runtimeSatisfiesAfterAsiGeneric = value satisfies Safe \? \{\} : \{ clientSecret: \[REDACTED\] \};/);
  assert.match(stagedTypes, /type StickyAsiBare<T> = T\r?\nruntimeAsiBare = \{ password: \[REDACTED\] \};/);
  assert.match(stagedTypes, /type ContinuedArray =\r?\n  Array<\{ token: string \}>;/);
  assert.match(stagedTypes, /type ContinuedReadonly<T> =\r?\n  \/\/ safe\r?\n  readonly \[\{ token: T \}, \{ password: string \}\];/);
  assert.match(stagedTypes, /type ContinuedComplex<T extends \{ safe: string \} = \{ safe: string \}> =\r?\n  \/\* safe \*\/\r?\n  keyof \(\{ token: T; password: string \}\);/);
  assert.match(stagedTypes, /type ContinuedRuntime<T extends \{ safe: string \} = \{ safe: string \}> =\r?\n  Array<\{ token: T \}>\r?\nconst runtimeAfterContinuedAlias = condition \? fn\(\) : \{ password: \[REDACTED\] \};/);
  assert.equal(stagedResidue, 'private_key="[REDACTED]"');
  assert.match(observed, /interface CommentedCredentials \{\r?\n  \/\/ harmless \}\r?\n  token: string;\r?\n\}/);
  assert.match(observed, /class CommentedVault \{ \/\* harmless \} \*\/ private password: string; private config: Array<\{ token: string \}>; \}/);
  assert.match(observed, /password = \[REDACTED\];/);
  assert.match(observed, /private_key="\[REDACTED\]"/);
  assert.match(observed, /pass\\u0077ord: "\[REDACTED\]"/);
  assert.match(observed, /"pass\\u0077ord": "\[REDACTED\]"/);
  assert.match(observed, /pass\\u\{77\}ord: "\[REDACTED\]"/);
  assert.match(observed, /config\["access\\u0054oken"\] = "\[REDACTED\]";/);
  assert.match(observed, /config\["access\\x54oken"\] = "\[REDACTED\]";/);
  assert.match(observed, /config\["pass\\uZZZZord"\] = "\[REDACTED\]";/);
  assert.match(observed, /config\["_token"\] = "\[REDACTED\]";/);
  assert.match(observed, /const tokenFactory: \(\) => string = "\[REDACTED\]";/);
  assert.match(observed, /class GenericAuth<T> \{ private method\(token: T\): void \{\} \}/);
  assert.match(observed, /function blockLocalType\(\)\{ type Token = string; \}/);
  assert.ok(observed.includes('```json\n{"pass\\u0077ord":"[REDACTED]"}\n```'));
  assert.match(observed, /ENV API_KEY \[REDACTED\]/);
  assert.match(observed, /ENV ACCESS_TOKEN \[REDACTED\]/);
  assert.match(observed, /run --password \[REDACTED\]/);
  assert.match(observed, /run --token "\[REDACTED\]"/);
  assert.match(observed, /run --password \[REDACTED\]\r?\n/);
  assert.match(observed, /#define PASSWORD \[REDACTED\]/);
  assert.match(observed, /#define CLIENT_SECRET \[REDACTED\]/);
  assert.match(observed, /\{ "password" => "\[REDACTED\]", :accessToken => "\[REDACTED\]" \}/);
  assert.match(observed, /\$config = \["token" => "\[REDACTED\]"\];/);
  assert.match(observed, /CREATE USER demo WITH PASSWORD '\[REDACTED\]';/);
  assert.match(observed, /ALTER ROLE admin WITH ENCRYPTED PASSWORD '\[REDACTED\]';/);
  assert.match(observed, /CREATE ROLE app WITH LOGIN PASSWORD '\[REDACTED\]';/);
  assert.match(observed, /CREATE ROLE limited WITH LOGIN CONNECTION LIMIT 5 PASSWORD '\[REDACTED\]';/);
  assert.match(observed, /ALTER ROLE expiring VALID UNTIL '2027-01-01' PASSWORD '\[REDACTED\]';/);
  assert.match(observed, /credentials:"\[REDACTED\]"/);
  assert.match(observed, /- name: "\[REDACTED\]"\r?\n  # selected\r?\n  value: "\[REDACTED\]"/);
  assert.match(observed, /- name: "\[REDACTED\]"\r?\n\r?\n  value: "\[REDACTED\]"/);
  assert.deepEqual(stagedDuplicate, { password: "[REDACTED]", note: "safe" });
  assert.match(observed, /password:"\[REDACTED\]"/);
  assert.match(observed, /credentials:"\[REDACTED\]"/);
  assert.deepEqual(stagedSettings.credentials, { token: "[REDACTED]", username: "[REDACTED]" });
  assert.deepEqual(stagedSettings.auth, { cookie: "[REDACTED]", label: "[REDACTED]" });
  assert.equal(stagedSettings.databaseUrl, "[REDACTED]");
  assert.equal(stagedSettings.mongoUri, "[REDACTED]");
  assert.equal(stagedSettings.tokenCount, 5);
  assert.equal(stagedSettings.sessionTimeout, 30);
});

test("TOML staging redacts complete values and remains parseable by the real extractor", async (t) => {
  const python = (process.platform === "win32" ? ["python"] : ["python3", "python"])
    .find((candidate) => spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0);
  if (!python) {
    t.skip("Python is unavailable; the locked image smoke covers tomllib extraction");
    return;
  }
  const { root, write } = fixture(t);
  write("config.toml", 'description="""line one\ninner = safe-looking\nline two"""\nprivate_key="""TomlOneS3cr3t\ninner = secret-looking\nTomlTwoS3cr3t"""\ncount=5\n\n[section]\nitems = [\n  "first",\n  "inner = text",\n]\ninline = { nested = "value", tokenCount = 5 }\n');
  write("README.md", "# TOML fixture\n");
  let stagedText = "";
  let extractedKeys = [];
  await runGraphifySnapshot({
    plan: plan(root, { extensions: [".toml"], allowedBasenames: ["README.md"] }),
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => {
      if (context.stage === "extract") {
        const stagedPath = path.join(context.inputDir, "config.toml");
        stagedText = fs.readFileSync(stagedPath, "utf8");
        const script = [
          "import importlib.util, json, sys",
          "from pathlib import Path",
          "spec = importlib.util.spec_from_file_location('agenthost_graphify_extract', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "root = Path(sys.argv[2])",
          "nodes, _ = module.config_structure(root, [root / 'config.toml'])",
          "print(json.dumps(sorted(node['label'] for node in nodes)))",
        ].join("\n");
        const parsed = spawnSync(python, ["-B", "-c", script, path.join(import.meta.dirname, "..", "container", "graphify-folder-extract.py"), context.inputDir], { encoding: "utf8" });
        assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
        extractedKeys = JSON.parse(parsed.stdout);
      } else {
        writeOutput(context.scratchDir, "config.toml");
      }
    },
  });
  assert.equal(stagedText, 'description="[REDACTED]"\nprivate_key="[REDACTED]"\ncount="[REDACTED]"\n\n[section]\nitems = "[REDACTED]"\ninline = "[REDACTED]"\n');
  assert.deepEqual(extractedKeys, ["count", "description", "private_key", "section", "section.inline", "section.items"]);
  assert.doesNotMatch(stagedText, /line one|safe-looking|TomlOne|secret-looking|TomlTwo|inner = text|nested =/);
});

test("the exact manifest digest changes with file content and oversized corpora fail before spawn", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const value = 1;\n");
  write("README.md", "# Stable\n");
  const run = async () => runGraphifySnapshot({
    plan: plan(root),
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => { if (context.stage === "cluster") writeOutput(context.scratchDir, "one.js"); },
  });
  const first = await run();
  write("one.js", "export const value = 2;\n");
  const second = await run();
  assert.notEqual(first.snapshot.manifestSha256, second.snapshot.manifestSha256);

  let spawned = 0;
  for (let index = 0; index <= GRAPHIFY_FOLDER_LIMITS.maxFiles; index += 1) {
    write(`many/f${index}.js`, `export const v${index} = ${index};\n`);
  }
  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    buildCommand: () => ({ bin: "fixture", args: [] }),
    execute: async () => { spawned += 1; },
  }), /more than .* supported files/i);
  assert.equal(spawned, 0);
});

test("Graphify cannot name an unselected source or exceed the HTML-safe node limit", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => { if (context.stage === "cluster") writeOutput(context.scratchDir, "private/not-selected.js"); },
  }), /non-snapshot source file/i);

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: async (_command, context) => {
      if (context.stage !== "cluster") return;
      const output = path.join(context.scratchDir, "graphify-out");
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Too large\n");
      fs.writeFileSync(path.join(output, "graph.json"), JSON.stringify({
        directed: true,
        graph: {},
        nodes: Array.from({ length: GRAPHIFY_FOLDER_LIMITS.maxNodes + 1 }, (_, index) => ({ id: `n${index}` })),
        links: [],
      }));
    },
  }), /5000-node interactive HTML limit/i);
});

test("a pre-aborted Graphify snapshot grants no child and leaves no scratch directory", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  const tmpRoot = path.join(root, "jobs");
  fs.mkdirSync(tmpRoot);
  const controller = new AbortController();
  controller.abort();
  let children = 0;

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    signal: controller.signal,
    tmpRoot,
    buildCommand: () => ({ bin: "fixture", args: [] }),
    execute: async () => { children += 1; },
  }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "GRAPHIFY_CANCELLED");
    assert.equal(error.cancelled, true);
    assert.equal(error.conclusiveNoChild, true);
    assert.equal(error.terminationUnproven, undefined);
    return true;
  });
  assert.equal(children, 0);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("in-flight cancellation observes terminal close and never advances past the cancelled stage", async (t) => {
  for (const abortStage of ["extract", "cluster"]) {
    await t.test(abortStage, async (t) => {
      const { root, write } = fixture(t);
      write("one.js", "export const one = 1;\n");
      const tmpRoot = path.join(root, "jobs");
      fs.mkdirSync(tmpRoot);
      const controller = new AbortController();
      const stages = [];
      let kills = 0;

      await assert.rejects(runGraphifySnapshot({
        plan: plan(root),
        signal: controller.signal,
        tmpRoot,
        buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
        execute: async (command, context) => {
          stages.push(context.stage);
          if (context.stage !== abortStage) return;
          const child = new EventEmitter();
          child.pid = 4242;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {
            kills += 1;
            queueMicrotask(() => child.emit("close", null, "SIGKILL"));
            return true;
          };
          return runBoundedCommand(command, {
            ...context,
            spawn: () => {
              queueMicrotask(() => controller.abort());
              return child;
            },
            timeoutMs: 1_000,
            killGraceMs: 20,
          });
        },
      }), (error) => {
        assert.match(error.message, new RegExp(`Graphify ${abortStage} cancelled`, "i"));
        assert.equal(error.name, "AbortError");
        assert.equal(error.code, "GRAPHIFY_CANCELLED");
        assert.equal(error.cancelled, true);
        assert.equal(error.terminationUnproven, undefined);
        return true;
      });
      assert.deepEqual(stages, abortStage === "extract" ? ["extract"] : ["extract", "cluster"]);
      assert.equal(kills, 1);
      assert.deepEqual(fs.readdirSync(tmpRoot), [], "proved child termination allows scratch cleanup");
    });
  }
});

test("an unclosed cancelled child marks termination unproven and quarantines its scratch directory", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  const tmpRoot = path.join(root, "jobs");
  fs.mkdirSync(tmpRoot);
  const controller = new AbortController();
  const stages = [];
  let kills = 0;

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    signal: controller.signal,
    tmpRoot,
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: (command, context) => {
      stages.push(context.stage);
      const child = new EventEmitter();
      child.pid = 4343;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { kills += 1; return true; };
      return runBoundedCommand(command, {
        ...context,
        spawn: () => {
          queueMicrotask(() => controller.abort());
          return child;
        },
        timeoutMs: 1_000,
        killGraceMs: 5,
      });
    },
  }), (error) => {
    assert.match(error.message, /Graphify extract cancelled.*did not close/i);
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "GRAPHIFY_CANCELLED");
    assert.equal(error.cancelled, true);
    assert.equal(error.terminationUnproven, true);
    return true;
  });
  assert.deepEqual(stages, ["extract"]);
  assert.equal(kills, 1);
  const quarantined = fs.readdirSync(tmpRoot).filter((name) => name.startsWith("agenthost-graphify-folder-"));
  assert.equal(quarantined.length, 1);
  assert.ok(fs.statSync(path.join(tmpRoot, quarantined[0], "scratch")).isDirectory());
});

test("a synchronous abort inside spawn waits for the returned child to close before scratch cleanup", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  const tmpRoot = path.join(root, "jobs");
  fs.mkdirSync(tmpRoot);
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 4444;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  let closed = false;
  let scratchExistedDuringKill = false;
  child.kill = () => {
    kills += 1;
    const jobs = fs.readdirSync(tmpRoot).filter((name) => name.startsWith("agenthost-graphify-folder-"));
    scratchExistedDuringKill = jobs.length === 1
      && fs.existsSync(path.join(tmpRoot, jobs[0], "scratch"));
    setTimeout(() => {
      closed = true;
      child.emit("close", null, "SIGKILL");
    }, 5);
    return true;
  };

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    signal: controller.signal,
    tmpRoot,
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: (command, context) => runBoundedCommand(command, {
      ...context,
      spawn: () => {
        controller.abort();
        return child;
      },
      timeoutMs: 25,
      killGraceMs: 15,
    }),
  }), (error) => {
    assert.match(error.message, /Graphify extract cancelled/i);
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "GRAPHIFY_CANCELLED");
    assert.equal(error.cancelled, true);
    assert.equal(error.conclusiveNoChild, undefined);
    assert.equal(error.terminationUnproven, undefined);
    assert.equal(closed, true, "the caller cannot finish until the returned child closes");
    return true;
  });
  assert.equal(kills, 1);
  assert.equal(scratchExistedDuringKill, true);
  assert.deepEqual(fs.readdirSync(tmpRoot), [], "scratch is cleaned only after close proves termination");
});

test("cancellation keeps explicit child termination refusal details after close", async (t) => {
  for (const refusal of ["throw", "false"]) {
    await t.test(refusal, async () => {
      const controller = new AbortController();
      const child = new EventEmitter();
      child.pid = 4545;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        if (refusal === "throw") {
          const error = new Error("operation not permitted by fixture");
          error.code = "EPERM";
          throw error;
        }
        return false;
      };
      const run = runBoundedCommand({ bin: "fixture", args: [] }, {
        signal: controller.signal,
        spawn: () => {
          queueMicrotask(() => {
            controller.abort();
            queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          });
          return child;
        },
        timeoutMs: 1_000,
        killGraceMs: 20,
      });

      await assert.rejects(run, (error) => {
        assert.equal(error.name, "AbortError");
        assert.equal(error.code, "GRAPHIFY_CANCELLED");
        assert.equal(error.cancelled, true);
        assert.equal(error.terminationUnproven, undefined);
        if (refusal === "throw") {
          assert.match(error.message, /SIGKILL.*EPERM.*operation not permitted by fixture/i);
        } else {
          assert.match(error.message, /SIGKILL.*not delivered.*returned false/i);
        }
        return true;
      });
    });
  }
});

test("a later abort cannot replace an earlier lifecycle failure and its bounded child reason", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 4646;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => {
    kills += 1;
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("bounded lifecycle shutdown reason\n"));
      controller.abort();
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    signal: controller.signal,
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: (command, context) => runBoundedCommand(command, {
      ...context,
      spawn: () => {
        queueMicrotask(() => child.emit("error", new Error("parser lifecycle failed")));
        return child;
      },
      timeoutMs: 1_000,
      killGraceMs: 20,
    }),
  }), (error) => {
    assert.match(error.message, /Graphify extract failed/i);
    assert.match(error.message, /parser lifecycle failed/i);
    assert.match(error.message, /bounded lifecycle shutdown reason/i);
    assert.equal(error.name, "Error");
    assert.equal(error.code, undefined);
    assert.equal(error.cancelled, undefined);
    return true;
  });
  assert.equal(kills, 1, "the later abort must not start a second termination attempt");
});

test("a later abort cannot replace an earlier timeout and its bounded child reason", async (t) => {
  const { root, write } = fixture(t);
  write("one.js", "export const one = 1;\n");
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 4747;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => {
    kills += 1;
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("bounded timeout shutdown reason\n"));
      controller.abort();
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };

  await assert.rejects(runGraphifySnapshot({
    plan: plan(root),
    signal: controller.signal,
    buildCommand: ({ stage }) => ({ bin: "fixture", args: [stage] }),
    execute: (command, context) => runBoundedCommand(command, {
      ...context,
      spawn: () => child,
      timeoutMs: 5,
      killGraceMs: 20,
    }),
  }), (error) => {
    assert.match(error.message, /Graphify extract failed/i);
    assert.match(error.message, /timed out after 5ms/i);
    assert.match(error.message, /bounded timeout shutdown reason/i);
    assert.equal(error.name, "Error");
    assert.equal(error.code, undefined);
    assert.equal(error.cancelled, undefined);
    return true;
  });
  assert.equal(kills, 1, "the later abort must not start a second termination attempt");
});
