import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  BRAND_GRAPHIFY_FOLDER_ID,
  BRAND_GRAPHIFY_LIMITS,
  listBrandGraphifyTargets,
  materializeBrandGraphifyCorpus,
  resolveBrandGraphifyChoice,
} = require("../container/graphify-brand-corpus.js")
const { runGraphifySnapshot } = require("../container/graphify-lib.js")
const { projectGraphifyBrandClaims } = require("../container/graphify-brand.js")

const ACCOUNTS = Object.freeze([
  Object.freeze({ account_id: "acme-x", name: "Acme & Co", industry: "Retail", created_at: "2026-08-14T10:00:00.000Z" }),
  Object.freeze({ account_id: "north-star", name: "North Star", industry: null, created_at: "2026-08-14T11:00:00.000Z" }),
])
const PROVENANCE = Object.freeze({
  source_url: "https://example.com/",
  source_urls: Object.freeze(["https://example.com/", "https://example.com/about"]),
  generated_at: "2026-08-14T12:00:00.000Z",
})
const RECORDS = Object.freeze([
  Object.freeze({
    id: "dna-voice",
    account_id: "acme-x",
    asset: "voice",
    source: "client",
    content: "Use direct, concise language.",
    version: 4,
    updated_at: "2026-08-14T12:04:00.000Z",
    schemaVersion: 1,
  }),
  Object.freeze({
    id: "dna-guidelines",
    account_id: "acme-x",
    asset: "guidelines",
    source: "generated",
    content: "Lead with the practical outcome.",
    version: 2,
    updated_at: "2026-08-14T12:02:00.000Z",
    schemaVersion: 1,
    provenance: PROVENANCE,
  }),
])

function privateRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-brand-corpus-test-"))
  fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function materialize(t, overrides = {}) {
  return materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    records: RECORDS,
    stagingRoot: privateRoot(t),
    ...overrides,
  })
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

test("lists path-free Brand targets with one stable folder and no account internals", () => {
  const targets = listBrandGraphifyTargets(ACCOUNTS)

  assert.deepEqual(targets, [
    {
      id: "brand:acme-x",
      label: "Acme & Co (acme-x)",
      kind: "brand",
      folders: [{ id: BRAND_GRAPHIFY_FOLDER_ID, label: "Brand DNA" }],
      defaultFolderId: BRAND_GRAPHIFY_FOLDER_ID,
    },
    {
      id: "brand:north-star",
      label: "North Star (north-star)",
      kind: "brand",
      folders: [{ id: BRAND_GRAPHIFY_FOLDER_ID, label: "Brand DNA" }],
      defaultFolderId: BRAND_GRAPHIFY_FOLDER_ID,
    },
  ])
  const browserJson = JSON.stringify(targets)
  assert.doesNotMatch(browserJson, /industry|created_at|[A-Za-z]:[\\/]|\/(?:data|home|tmp)\//i)

  const sameNames = listBrandGraphifyTargets([
    { account_id: "acme-east", name: "Acme" },
    { account_id: "acme-west", name: "Acme" },
  ])
  assert.deepEqual(sameNames.map((target) => target.label), ["Acme (acme-east)", "Acme (acme-west)"])
  const truncated = listBrandGraphifyTargets([{
    account_id: `a${"z".repeat(63)}`,
    name: `${"N".repeat(91)}\u{1F642}${"N".repeat(27)}`,
  }])[0].label
  assert.ok(truncated.length <= BRAND_GRAPHIFY_LIMITS.maxTargetLabelChars)
  assert.equal(Buffer.from(truncated, "utf8").toString("utf8"), truncated)
})

test("rejects duplicate or unsafe account records before producing browser choices", () => {
  assert.throws(
    () => listBrandGraphifyTargets([...ACCOUNTS, { ...ACCOUNTS[0] }]),
    /duplicates account id/i,
  )
  for (const account of [
    { account_id: "../acme", name: "Acme" },
    { account_id: "Acme", name: "Acme" },
    { account_id: "acme-x", name: "C:\\Users\\Steve\\Acme" },
    { account_id: "acme-x", name: "Acme/Division" },
    { account_id: "acme-x", name: "<Acme>" },
    { account_id: "acme-x", name: "line\nbreak" },
    { account_id: "acme-x", name: "Acme\u0085hidden" },
    { account_id: "acme-x", name: "Acme\u202e-x" },
    { account_id: "acme-x", name: "Acme\u2066-x" },
    { account_id: "acme-x", name: `sk-${"x".repeat(24)}` },
  ]) {
    assert.throws(() => listBrandGraphifyTargets([account]), /unsafe (?:account id|browser label)/i)
  }
  assert.throws(
    () => listBrandGraphifyTargets(Array.from({ length: BRAND_GRAPHIFY_LIMITS.maxAccounts + 1 }, (_, index) => ({
      account_id: `account-${index}`,
      name: `Account ${index}`,
    }))),
    /too many accounts/i,
  )
})

test("resolves only an exact id pair against the current account list", () => {
  assert.deepEqual(resolveBrandGraphifyChoice(ACCOUNTS, {
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
  }), {
    target: { id: "brand:acme-x", label: "Acme & Co (acme-x)", kind: "brand" },
    folder: { id: BRAND_GRAPHIFY_FOLDER_ID, label: "Brand DNA" },
    accountId: "acme-x",
  })

  assert.throws(
    () => resolveBrandGraphifyChoice(ACCOUNTS.slice(1), { targetId: "brand:acme-x", folderId: BRAND_GRAPHIFY_FOLDER_ID }),
    /not a current account/i,
  )
  assert.throws(
    () => resolveBrandGraphifyChoice(ACCOUNTS, { targetId: "brand:acme-x", folderId: "brand_other" }),
    /folder choice is invalid/i,
  )
  assert.throws(
    () => resolveBrandGraphifyChoice(ACCOUNTS, {
      targetId: "brand:acme-x",
      folderId: BRAND_GRAPHIFY_FOLDER_ID,
      label: "North Star",
    }),
    /exactly targetId and folderId/i,
  )
})

test("materializes deterministic Markdown and account-bound confidence metadata", (t) => {
  const records = [RECORDS[0], RECORDS[1]]
  const result = materialize(t, { records })

  assert.equal(result.accountId, "acme-x")
  assert.deepEqual(result.plan.target, { id: "brand:acme-x", label: "Acme & Co (acme-x)", kind: "brand" })
  assert.deepEqual(result.plan.folder, { id: BRAND_GRAPHIFY_FOLDER_ID, label: "Brand DNA" })
  assert.deepEqual(result.plan.includeRoots, ["brand"])
  assert.deepEqual(result.plan.extensions, [".md"])
  assert.deepEqual(result.plan.allowedBasenames, [])
  assert.equal(result.plan.maxDepth, 1)
  assert.equal(result.plan.redactInputs, true)
  assert.equal(result.plan.snapshotKind, "folder")
  assert.equal(fs.realpathSync(result.plan.sourceRoot), result.plan.sourceRoot)
  assert.deepEqual(fs.readdirSync(path.join(result.plan.sourceRoot, "brand")), ["guidelines.md", "voice.md"])
  assert.equal(
    fs.readFileSync(path.join(result.plan.sourceRoot, "brand", "guidelines.md"), "utf8"),
    "```text\n\"Lead with the practical outcome.\"\n```\n",
  )
  assert.equal(
    fs.readFileSync(path.join(result.plan.sourceRoot, "brand", "voice.md"), "utf8"),
    "```text\n\"Use direct, concise language.\"\n```\n",
  )
  assert.deepEqual(result.fileMetadata["brand/voice.md"], {
    account_id: "acme-x",
    asset: "voice",
    claims: [{
      account_id: "acme-x",
      asset: "voice",
      claim: "Use direct, concise language.",
      confidence: "EXTRACTED",
      source: "client",
    }],
  })
  assert.deepEqual(result.fileMetadata["brand/guidelines.md"], {
    account_id: "acme-x",
    asset: "guidelines",
    claims: [{
      account_id: "acme-x",
      asset: "guidelines",
      claim: "Lead with the practical outcome.",
      confidence: "INFERRED",
      source: "generated",
    }],
  })
  assert.deepEqual(result.records.map((record) => record.asset), ["guidelines", "voice"])
  assert.ok(result.records.every((record) => record.account_id === "acme-x"))
  assert.deepEqual(records, [RECORDS[0], RECORDS[1]])

  const jobRoot = result.plan.sourceRoot
  assert.equal(fs.existsSync(jobRoot), true)
  result.cleanup()
  result.cleanup()
  assert.equal(fs.existsSync(jobRoot), false)
})

test("the staged Brand corpus passes the shared Graphify runner contract", async (t) => {
  const staged = materialize(t)
  let observedMetadata = null
  try {
    const result = await runGraphifySnapshot({
      plan: staged.plan,
      fileMetadata: staged.fileMetadata,
      secretValues: [],
      now: () => new Date("2026-08-14T13:00:00.000Z"),
      buildCommand: ({ stage }) => ({ bin: "brand-fixture", args: [stage] }),
      execute: async (_command, context) => {
        if (context.stage === "extract") {
          observedMetadata = JSON.parse(fs.readFileSync(path.join(context.inputDir, ".agenthost-corpus.json"), "utf8"))
          return
        }
        const output = path.join(context.scratchDir, "graphify-out")
        fs.mkdirSync(output, { recursive: true })
        fs.writeFileSync(path.join(output, "GRAPH_REPORT.md"), "# Brand relationships\n\nCanonical claims staged.\n")
        fs.writeFileSync(path.join(output, "graph.json"), JSON.stringify({
          directed: true,
          multigraph: true,
          graph: {},
          nodes: Object.entries(observedMetadata.files).map(([sourceFile, metadata]) => ({
            id: metadata.asset,
            label: metadata.asset,
            source_file: sourceFile,
            source_location: "L1",
            asset: metadata.asset,
            claims: metadata.claims,
          })),
          links: [{
            source: "guidelines",
            target: "voice",
            relation: "informs",
            confidence: "INFERRED",
            source_file: "brand/guidelines.md",
          }],
          hyperedges: [],
        }))
      },
    })

    assert.deepEqual(observedMetadata.files["brand/voice.md"], staged.fileMetadata["brand/voice.md"])
    assert.equal(result.snapshot.kind, "folder")
    assert.equal(result.snapshot.value, "2026-08-14T12:04:00.000Z")
    assert.equal(result.graph.nodes.find((node) => node.asset === "voice").claims[0].confidence, "EXTRACTED")
    assert.equal(result.graph.nodes.find((node) => node.asset === "guidelines").claims[0].confidence, "INFERRED")
    assert.match(result.report, /Target: Acme & Co \(acme-x\)/)
    assert.match(result.html, /Interactive relationship graph/)

    let claimId = 0
    const projected = await projectGraphifyBrandClaims({
      accountId: staged.accountId,
      runId: "brand-corpus-contract",
      snapshot: result.snapshot,
      graph: result.graph,
      records: staged.records,
      cfg: { ok: true, url: "https://brain.example", key: "fixture-key" },
      fetchFn: async (_url, options = {}) => {
        if ((options.method || "GET") === "GET") return response(200, { memories: [] })
        const body = JSON.parse(options.body)
        return response(201, {
          id: `claim-${++claimId}`,
          ...body,
          version: 1,
          created_at: "2026-08-14T13:00:00.000Z",
          updated_at: "2026-08-14T13:00:00.000Z",
        })
      },
    })
    assert.deepEqual(projected.claims.map((claim) => [claim.asset, claim.confidence, claim.source]), [
      ["guidelines", "INFERRED", "generated"],
      ["voice", "EXTRACTED", "client"],
    ])
  } finally {
    staged.cleanup()
  }
})

test("arbitrary canonical Markdown is inert inside one deterministic document body", (t) => {
  const content = "# Client heading\n```javascript\n## Nested heading\n```\n[[not-a-graph-edge]]\u2028```\u2029# still-not-a-heading"
  const staged = materialize(t, { records: [{ ...RECORDS[0], content }] })
  const markdown = fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8")
  const lines = markdown.split("\n")
  const encoded = JSON.stringify(content)
    .replace(/\[/g, "\\u005b")
    .replace(/\]/g, "\\u005d")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  assert.deepEqual(lines, ["```text", encoded, "```", ""])
  assert.doesNotMatch(lines[1], /\[\[/)
  assert.equal(JSON.parse(lines[1]), content)
  staged.cleanup()
})

test("pinned Graphify emits one claim node and no invented Brand references", {
  skip: process.env.AGENTHOST_GRAPHIFY_PINNED_SMOKE !== "1",
}, (t) => {
  const content = "# Heading\n```javascript\n## Nested\n```\n[[not-a-real-edge]]\u2028# Still nested"
  const staged = materialize(t, { records: [{ ...RECORDS[0], content }] })
  fs.writeFileSync(
    path.join(staged.plan.sourceRoot, ".agenthost-corpus.json"),
    `${JSON.stringify({ version: 1, files: staged.fileMetadata })}\n`,
    { flag: "wx", mode: 0o400 },
  )
  const mountedSource = staged.plan.sourceRoot.replaceAll("\\", "/")
  const mountedRunner = path.resolve("container/graphify-folder-extract.py").replaceAll("\\", "/")
  const run = spawnSync("docker", [
    "run", "--rm",
    "-e", "PYTHONPATH=/opt/agenthost/graphify-python",
    "-v", `${mountedSource}:/source`,
    "-v", `${mountedRunner}:/runner.py:ro`,
    "agenthost-graphify-package-test:0.9.42-locked",
    "python3", "/runner.py", "/source", "/source/out.json",
  ], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true })
  assert.equal(run.status, 0, `pinned Graphify smoke failed: ${(run.stderr || run.error?.message || "no cause").slice(0, 500)}`)
  const graph = JSON.parse(fs.readFileSync(path.join(staged.plan.sourceRoot, "out.json"), "utf8"))
  assert.equal(graph.nodes.filter((node) => Array.isArray(node.claims)).length, 1)
  assert.equal(graph.links.filter((edge) => edge.relation === "references").length, 0)
  assert.equal(graph.links.filter((edge) => edge.relation === "contains").length, 2)
  staged.cleanup()
})

test("near-cap UTF-8 content and provenance still pass the projector preflight", async (t) => {
  const content = "\u20ac".repeat(Math.floor(BRAND_GRAPHIFY_LIMITS.maxContentBytes / 3))
  const provenance = {
    source_url: `https://example.com/${"a".repeat(BRAND_GRAPHIFY_LIMITS.maxProvenanceBytes - 600)}`,
    source_urls: [],
    generated_at: PROVENANCE.generated_at,
  }
  const staged = materialize(t, {
    records: [{ ...RECORDS[1], asset: "voice", id: "dna-large-voice", content, provenance }],
  })
  try {
    const claims = staged.fileMetadata["brand/voice.md"].claims
    const result = await projectGraphifyBrandClaims({
      accountId: staged.accountId,
      runId: "brand-corpus-near-cap",
      snapshot: { kind: "folder", value: RECORDS[0].updated_at, manifestSha256: "a".repeat(64), derived: true },
      graph: {
        nodes: [{ id: "voice", label: "voice.md", source_file: "brand/voice.md", asset: "voice", claims }],
        links: [],
      },
      records: staged.records,
      cfg: { ok: true, url: "https://brain.example", key: "fixture-key" },
      fetchFn: async (_url, options = {}) => {
        if ((options.method || "GET") === "GET") return response(200, { memories: [] })
        const body = JSON.parse(options.body)
        return response(201, {
          id: "claim-near-cap",
          ...body,
          version: 1,
          created_at: "2026-08-14T13:00:00.000Z",
          updated_at: "2026-08-14T13:00:00.000Z",
        })
      },
    })
    assert.equal(result.written, 1)
    assert.equal(result.claims[0].source, "generated")
  } finally {
    staged.cleanup()
  }
})

test("rejects hostile, foreign, duplicate, malformed, and empty DNA records", (t) => {
  const cases = [
    { records: [], pattern: /at least one canonical/i },
    { records: [{ ...RECORDS[0], asset: "../voice" }], pattern: /invalid asset/i },
    { records: [{ ...RECORDS[0], source: "agent" }], pattern: /invalid source/i },
    { records: [{ ...RECORDS[0], content: "" }], pattern: /empty content/i },
    { records: [{ ...RECORDS[0], content: " padded" }], pattern: /canonical surrounding whitespace/i },
    { records: [{ ...RECORDS[0], content: "contains\u0000nul" }], pattern: /control character/i },
    { records: [{ ...RECORDS[0], content: `sk-${"z".repeat(24)}` }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "password=hunter2" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "AWS_SECRET_ACCESS_KEY=alphaSecretValue" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "service_passphrase=correct horse battery staple" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "bearerToken=plain-bearer-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "privateKey=plain-private-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "sessionToken=plain-session-token" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const config = { accessToken: \"fixture-secret\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const opts = { cookie: \"fixture-secret\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "payload = { clientSecret: `fixture-secret` }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "DATABASE_DSN=host=db.local password=fixture-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "note: cookie=fixture-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "password: SuperSecret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "password: string" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const type = \"login\"; const cfg = { password: \"hunter2\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type Inline = { token: string; }; const cfg = { password: \"hunter2\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "interface Credentials { token: string; } const cfg = { password: \"hunter2\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const cfg = { password: SuperSecret, enabled: true };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "apiKey: SuperSecret;" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { config = { password: \"class-object-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { method() { return { clientSecret: \"class-method-secret\" }; } }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { password: string = \"typed-class-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { token?: string = \"optional-token-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { token? = \"optional-untyped-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { static readonly \"accessToken\"?: string = \"optional-quoted-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { static readonly [\"clientSecret\"]?: string = \"optional-computed-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { token?: { value: string } = { value: \"optional-object-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { password?: [string, number] = [\"optional-tuple-secret\", 1]; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { accessToken?: (() => string) = () => \"optional-function-secret\"; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { clientSecret?: Promise<{ value: string }> = Promise.resolve({ value: \"optional-generic-secret\" }); }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { refreshToken?: string | { value: string } = { value: \"optional-union-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { sessionToken?: (string | { value: string }) = { value: \"optional-paren-union-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { cookie?: {\n value: string\n} = { value: \"optional-multiline-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "class Auth { [\"accessToken\"]?: { value: string } = { value: \"optional-computed-object-secret\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const token =\n  \"continued-string-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const accessToken =\n  `continued-template-secret`;" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "function f(): Promise<{ safe: string }> { return { token: \"runtime-return-secret\", safe: \"ok\" }; }" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const value = { token: \"runtime-as-secret\" } as { token: string };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const value = { accessToken: \"runtime-satisfies-secret\" } satisfies { accessToken: string };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const value = condition ? fn() : { password: CallTernarySecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const value = input as Safe ? {} : { token: AsTernarySecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const value = input satisfies Safe ? {} : { clientSecret: SatisfiesTernarySecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T; const value = condition ? fn() : { password: RuntimeAfterGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T; const value = input as Safe ? {} : { token: AsAfterGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T; const value = input satisfies Safe ? {} : { clientSecret: SatisfiesAfterGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T\nconst value = condition ? fn() : { password: RuntimeAfterAsiGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T /* tail */\nconst value = input as Safe ? {} : { token: AsAfterAsiGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T> = T // tail\nconst value = input satisfies Safe ? {} : { clientSecret: SatisfiesAfterAsiGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "declare let runtime: unknown;\ntype G<T> = T\nruntime = { password: BareAfterAsiGenericSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "type G<T extends { safe: string } = { safe: string }> =\n  Array<{ token: T }>\nconst value = condition ? fn() : { password: RuntimeAfterContinuedAliasSecret };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "function f<T>(TToken = \"runtime-generic-default-secret\"): void {}" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "process.env.API_KEY ||= \"logical-or-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "process.env.ACCESS_TOKEN ??= \"logical-nullish-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"clientSecret\"] &&= \"logical-and-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "SIGNING_KEY=signing-key-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "ENCRYPTION_KEY=encryption-key-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "SESSION_KEY=session-key-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const token /* keep-comment */ = \"commented-key-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"accessToken\"] /* keep-comment */ = \"commented-bracket-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "token /* password=inner-comment-secret */ = outer-comment-secret;" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "password=\"\" + \"compound-rhs-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const refreshToken = condition\n  ? \"conditional-first-secret\"\n  : \"conditional-second-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const clientSecret = /* keep-comment */\n  \"commented-rhs-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const token =\n  // selected secret\n  \"continued-comment-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const token =\n\n  // selected secret\n  \"blank-comment-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "token += \"compound-plus-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"accessToken\"] += \"compound-bracket-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const cfg = { pass\\u0077ord: \"unicode-js-secret\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const cfg = { \"pass\\u0077ord\": \"unicode-quoted-secret\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const cfg = { pass\\u{77}ord: \"unicode-codepoint-secret\" };" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"access\\u0054oken\"] = \"unicode-bracket-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"access\\x54oken\"] = \"hex-bracket-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"pass\\uZZZZord\"] = \"malformed-key-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "config[\"_token\"] = \"leading-key-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const tokenFactory: () => string = \"typed-function-secret\";" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '```json\n{"pass\\u0077ord":"fenced-json-secret"}\n```' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "ENV API_KEY docker-env-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "ENV ACCESS_TOKEN \\\n  continued-docker-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "run --password cli-password-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: 'run --token "cli-token-secret"' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "run --password \\\n  cli-continued-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "#define PASSWORD define-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '{ "password" => "ruby-hash-secret" }' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '{ :accessToken => "ruby-symbol-secret" }' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '$config = ["token" => "php-hash-secret"];' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "- name: API_KEY\n  value: kubernetes-value-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "- name: API_KEY\n  # selected\n  value: kubernetes-comment-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "- name: API_KEY\n\n  value: kubernetes-blank-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "CREATE USER demo WITH PASSWORD 'sql-password-secret';" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "CREATE ROLE app WITH LOGIN PASSWORD 'pgsql-secret';" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "CREATE ROLE app WITH LOGIN CONNECTION LIMIT 5 PASSWORD 'pgsql-limit-secret';" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "ALTER ROLE app VALID UNTIL '2027-01-01' PASSWORD 'pgsql-valid-secret';" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "password:\n  yaml-indented-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "credentials:\n- yaml-sequence-secret\nsafe: yes" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "outer=accessToken=fixture-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "const privateKey = `line-one-secret\nline-two-secret`;" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "private_key = \"\"\"line-one-secret\nline-two-secret\"\"\"" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: 'private_key="[REDACTED]"\nTomlTwoS3cr3t"""' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: 'private_key="[REDACTED]"\nlabel="[REDACTED]"\nTomlTwoS3cr3t"""' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: 'private_key="[REDACTED]"\n[section]\nTomlTwoS3cr3t"""' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: 'private_key="[REDACTED]"\r\nlabel="[REDACTED]"\r\nTomlTwoS3cr3t"""' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "private_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nTomlTwoS3cr3t'''" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "password: |\n  line-one-secret\n  line-two-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "{\"credentials\":{\"token\":\"fixture-secret\",\"safe\":\"fixture-secret\"},\"other\":1}" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "DATABASE_URL=postgres://dbuser:fixture-db-secret@db/app" }], pattern: /credential-shaped|credential assignment/i },
    { records: [{ ...RECORDS[0], content: "OPENAI_API_KEY_PROD=fixture-api-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "DATABASE_URL_READONLY=fixture-db-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "SESSION_ID_BACKUP=fixture-session-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "SESSIONID=fixture-compact-session-secret" }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "redis://:fixture-cache-secret@cache/0" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "mongodb+srv://dbuser:fixture-mongo-secret@cluster/app" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "source_url=https://alice:https-userinfo-secret@example.com/private" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "-----BEGIN RSA PRIVATE KEY-----\nfixture-pem-secret\n-----END RSA PRIVATE KEY-----" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "-----BEGIN OPENSSH PRIVATE KEY-----\nraw-private-body-secret\nsecond-line" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "Bearer abcdefghijklmnop" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "Bearer SuperSecret" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "Basic dTpw" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: "Basic Og==" }], pattern: /credential-shaped/i },
    { records: [{ ...RECORDS[0], content: '{"password":"first-secret","password":"[REDACTED]"}' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '{"pass\\u0077ord":"first-secret","pass\\u0077ord":"[REDACTED]"}' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: '{"note":"pass\\u0077ord=hunter2","note":"safe"}' }], pattern: /credential assignment/i },
    { records: [{ ...RECORDS[0], content: "C:\\Users\\Steve\\secret.txt" }], pattern: /private path/i },
    { records: [{ ...RECORDS[0], account_id: "north-star" }], pattern: /missing or different account id/i },
    { records: [{ ...RECORDS[0], account_id: undefined }], pattern: /missing or different account id/i },
    { records: [RECORDS[0], { ...RECORDS[0], id: "dna-voice-copy" }], pattern: /duplicates asset/i },
    { records: [{ ...RECORDS[0], updated_at: "not-a-date" }], pattern: /updated_at/i },
    { records: [{ ...RECORDS[0], version: -1 }], pattern: /version/i },
    { records: [{ ...RECORDS[1], provenance: { ...PROVENANCE, source_url: "file:///private" } }], pattern: /provenance/i },
    {
      records: [{
        ...RECORDS[1],
        provenance: { ...PROVENANCE, source_url: `https://example.com/${"a".repeat(BRAND_GRAPHIFY_LIMITS.maxProvenanceBytes)}` },
      }],
      pattern: /provenance byte limit/i,
    },
  ]
  const root = privateRoot(t)
  for (const fixture of cases) {
    assert.throws(() => materializeBrandGraphifyCorpus({
      accounts: ACCOUNTS,
      targetId: "brand:acme-x",
      folderId: BRAND_GRAPHIFY_FOLDER_ID,
      stagingRoot: root,
      records: fixture.records,
    }), fixture.pattern)
  }
  assert.deepEqual(fs.readdirSync(root), [])
})

test("common comparison, type, and timeout syntax is not a credential assignment", (t) => {
  const content = "if (token === undefined) return ok;\ntype Config = { token: string; enabled: boolean };\ntype Token = string;\ntype Handler = (token: string) => void;\ninterface Credentials {\n  token: string\n}\ninterface GenericCredentials<T> { token: T }\nfunction authenticate(token: AuthToken): void {}\nfunction generic<T>(token: T): void {}\nfunction blockLocalType(){ type Token = string; }\nclass GenericAuth<T> { private method(token: T): void {} }\ntoken: string | null\nclass Auth { token: AuthToken; }\npassword:\nsafeOptional: yes\n{\"sessionTimeout\":30}\nsource_url=https://example.com/public\nChoose the Basic plan for teams. Basic tier. Basic auth.\nBearer authentication is supported.\nBearer representational systems are supported."
  const aliasContinuations = "\ntype ContinuedArray =\n  Array<{ token: string }>;\ntype ContinuedReadonly<T> =\n  // safe\n  readonly [{ token: T }, { password: string }];\ntype ContinuedComplex<T extends { safe: string } = { safe: string }> =\n  /* safe */\n  keyof ({ token: T; password: string });"
  const safeContent = content + "\ntype UnionCredentials = { token: string } | { password: string };\ntype GenericCredentials = Array<{ token: string }> & { password: string };\nfunction acceptsCredentials(value: Record<string, { token: string }>): void {}\nfunction graphResult(): Promise<{ token: string }> { throw new Error(); }\nfunction multilineResult():\n  Promise<{\n    token: string\n  }> { throw new Error(); }\nconst graphItems: Array<{ token: string }> = [];\nconst typedFactory: () => Promise<{ token: string }> = async () => ({ safe: true });\ndeclare const parenthesizedFactory: () => ({ token: string } | { password: string });\ntype GenericAlias<T extends { token: string } = { password: string }> = T;\ntype GenericTokenDefault<TToken extends string = string> = TToken;\ninterface GenericDefault<T extends { token: string } = { password: string }> { value: T }\nclass GenericVault<T extends { token: string } = { password: string }> {}\nfunction genericDefault<T extends { token: string } = { password: string }>(value: { clientSecret: string }): void {}\nconst assertedType = {} as { token: string } | { password: string };\nconst satisfiedType = {} satisfies { token: string } & { password?: string };\ninterface OptionalShape { token?: string }\ntype OptionalAlias = { \"accessToken\"?: string };\nclass OptionalComplexTypes { token?: { value: string }; password?: [string, number]; accessToken?: (() => string); clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }); }\ninterface OptionalComplexInterface { token?: { value: string }; password?: [string, number]; accessToken?: (() => string) }\ntype OptionalComplexAlias = { clientSecret?: Promise<{ value: string }>; refreshToken?: string | { value: string }; sessionToken?: (string | { value: string }) };\ninterface CommentedCredentials {\n  // harmless }\n  token: string;\n}\nclass CommentedVault { /* harmless } */ private password: string; private config: Array<{ token: string }>; }\npassword = [REDACTED];\nprivate_key=\"[REDACTED]\"\nlabel=\"[REDACTED]\"\nprivate_key=\"[REDACTED]\"\ndescription=\"\"\"line one\nline two\"\"\"\nprivate_key=\"[REDACTED]\"\n[section]\ndescription=\"safe\"\n{\"tokenCount\":5}" + aliasContinuations
  const staged = materialize(t, { records: [{ ...RECORDS[0], content: safeContent }] })
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /sessionTimeout/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /Choose the Basic plan/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /type UnionCredentials = \{ token: string \} \| \{ password: string \}/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /type GenericCredentials = Array<\{ token: string \}>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /function graphResult\(\): Promise<\{ token: string \}>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /parenthesizedFactory: \(\) => \(\{ token: string \} \| \{ password: string \}\)/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /const graphItems: Array<\{ token: string \}> = \\u005b\\u005d/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /type GenericAlias<T extends \{ token: string \} = \{ password: string \}>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /GenericTokenDefault<TToken extends string = string>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /interface GenericDefault<T extends \{ token: string \} = \{ password: string \}>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /const assertedType = \{\} as \{ token: string \} \| \{ password: string \}/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /interface OptionalShape \{ token\?: string \}/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /class OptionalComplexTypes \{ token\?: \{ value: string \}; password\?: \\u005bstring, number\\u005d/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /tokenCount/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /\/\* harmless \} \*\/ private password: string/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /password = \\u005bREDACTED\\u005d/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /type ContinuedArray =\\n  Array<\{ token: string \}>/)
  assert.match(fs.readFileSync(path.join(staged.plan.sourceRoot, "brand", "voice.md"), "utf8"), /type ContinuedComplex<T extends \{ safe: string \} = \{ safe: string \}> =\\n  \/\* safe \*\/\\n  keyof \(\{ token: T; password: string \}\)/)
  staged.cleanup()
})

test("a bare private-key block is rejected before Brand files or claim metadata exist", (t) => {
  const root = privateRoot(t)
  assert.throws(() => materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    stagingRoot: root,
    records: [{
      ...RECORDS[0],
      content: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-material\n-----END OPENSSH PRIVATE KEY-----",
    }],
  }), /credential-shaped/i)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("suffix-qualified API and database keys are rejected before Brand metadata exists", (t) => {
  for (const content of [
    "OPENAI_API_KEY_PROD=fixture-api-secret",
    "DATABASE_URL_READONLY=fixture-db-secret",
    "SESSION_ID_BACKUP=fixture-session-secret",
    "SESSIONID=fixture-compact-session-secret",
  ]) {
    const root = privateRoot(t)
    assert.throws(() => materializeBrandGraphifyCorpus({
      accounts: ACCOUNTS,
      targetId: "brand:acme-x",
      folderId: BRAND_GRAPHIFY_FOLDER_ID,
      stagingRoot: root,
      records: [{ ...RECORDS[0], content }],
    }), /credential assignment/i)
    assert.deepEqual(fs.readdirSync(root), [])
  }
})

test("rejects character, byte, and total input overflows", (t) => {
  const root = privateRoot(t)
  const run = (records) => materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    stagingRoot: root,
    records,
  })
  assert.throws(
    () => run([{ ...RECORDS[0], content: "a".repeat(BRAND_GRAPHIFY_LIMITS.maxContentChars + 1) }]),
    /character limit/i,
  )
  assert.throws(
    () => run([{ ...RECORDS[0], content: "\u20ac".repeat(Math.ceil(BRAND_GRAPHIFY_LIMITS.maxContentBytes / 3) + 1) }]),
    /byte limit/i,
  )
  const records = ["guidelines", "voice", "intel", "performance", "calls"].map((asset, index) => ({
    ...RECORDS[0],
    id: `dna-${asset}`,
    asset,
    content: String(index).repeat(Math.floor(BRAND_GRAPHIFY_LIMITS.maxTotalContentBytes / 5) + 1),
  }))
  assert.throws(() => run(records), /total content byte limit/i)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("requires a canonical private staging root and never removes siblings", (t) => {
  const root = privateRoot(t)
  const sibling = path.join(root, "keep.txt")
  fs.writeFileSync(sibling, "keep", { flag: "wx" })
  const result = materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    records: RECORDS,
    stagingRoot: root,
  })
  result.cleanup()
  assert.equal(fs.readFileSync(sibling, "utf8"), "keep")

  const fileRoot = path.join(root, "not-a-directory")
  fs.writeFileSync(fileRoot, "occupied", { flag: "wx" })
  assert.throws(() => materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    records: RECORDS,
    stagingRoot: fileRoot,
  }), /staging root must be a real non-symlink directory/i)
})

test("rejects a symlink staging root", (t) => {
  const root = privateRoot(t)
  const target = fs.mkdtempSync(path.join(root, "real-"))
  const link = path.join(root, "linked")
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    t.skip(`symlink creation is unavailable: ${error.code || error.message}`)
    return
  }
  assert.throws(() => materializeBrandGraphifyCorpus({
    accounts: ACCOUNTS,
    targetId: "brand:acme-x",
    folderId: BRAND_GRAPHIFY_FOLDER_ID,
    records: RECORDS,
    stagingRoot: link,
  }), /staging root must be a real non-symlink directory/i)
})
