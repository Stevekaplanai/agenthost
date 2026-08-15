import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  claimPlans,
  claimMetadata,
  existingRunClaims,
  projectGraphifyBrandClaims,
  retainedClaimRow,
} = require("../container/graphify-brand.js")

const CFG = { ok: true, url: "https://brain.example", key: "fixture-key" }
const PROVENANCE = Object.freeze({
  source_url: "https://example.com/",
  source_urls: ["https://example.com/", "https://example.com/about"],
  generated_at: "2026-08-14T12:00:00.000Z",
})

function memoryFetch(seed = []) {
  const rows = structuredClone(seed)
  const calls = []
  let nextId = rows.length + 1
  const fetchFn = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    const method = options.method || "GET"
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url: url.href, method, body })
    if (method === "GET" && url.pathname === "/memory") {
      const meta = JSON.parse(url.searchParams.get("meta") || "{}")
      const limit = Number(url.searchParams.get("limit") || 200)
      const offset = Number(url.searchParams.get("offset") || 0)
      const matches = rows.filter((row) => Object.entries(meta).every(
        ([key, value]) => row.metadata?.[key] === value,
      ))
      return response(200, { memories: matches.slice(offset, offset + limit) })
    }
    if (method === "POST" && url.pathname === "/memory") {
      const row = {
        id: `claim-${nextId++}`,
        ...body,
        version: 1,
        created_at: "2026-08-14T12:01:00.000Z",
        updated_at: "2026-08-14T12:01:00.000Z",
      }
      rows.push(row)
      return response(201, row)
    }
    return response(405, { error: `unexpected ${method} ${url.pathname}` })
  }
  fetchFn.rows = rows
  fetchFn.calls = calls
  return fetchFn
}

function response(status, body, options = {}) {
  const rawBody = Object.hasOwn(options, "rawBody") ? options.rawBody : JSON.stringify(body)
  return new Response(rawBody, { status, headers: options.headers })
}

function invalidJsonResponse(status, rawBody = "<") {
  return response(status, null, { rawBody })
}

function streamedResponse(status, chunks, headers) {
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close()
      controller.enqueue(chunks[index++])
    },
  }), { status, headers })
}

function input(overrides = {}) {
  return {
    accountId: "acme-x",
    runId: "run-2026-08-14-a",
    snapshot: { id: "snapshot-a", captured_at: "2026-08-14T12:00:00.000Z", provenance: PROVENANCE },
    graph: {
      nodes: [{
        id: "voice-node",
        label: "Voice",
        source_file: "brand/voice.md",
        asset: "voice",
        claims: [{ claim: "Uses direct language.", confidence: "EXTRACTED", evidence: { span: "line 1" } }],
      }],
      links: [],
    },
    records: [],
    cfg: CFG,
    fetchFn: memoryFetch(),
    ...overrides,
  }
}

test("mixed-confidence graph claims persist separately with bounded node and incident-edge evidence", async () => {
  const canonicalClient = {
    id: "canonical-voice",
    content: "The client's approved voice.",
    version: 7,
    metadata: {
      app: "growth",
      record_type: "brand-dna",
      account_id: "acme-x",
      asset: "voice",
      source: "client",
      schemaVersion: 1,
    },
  }
  const fetchFn = memoryFetch([canonicalClient])
  const graph = {
    nodes: [{
      id: "voice-node",
      label: "Voice",
      source_file: "brand/voice.md",
      asset: "voice",
      claims: [
        { claim: "Uses direct language; password=should-not-store", confidence: "EXTRACTED", evidence: {
          span: "line 1",
          password: "should-not-store",
          note: "authorization=Bearer should-not-store",
          nested: { apiKey: "should-not-store", safe: "kept" },
          quoted: [
            'password="hunter2"',
            'Authorization: "Bearer plain-token"',
            'cookie="session=plain-cookie"',
            "access_token='plain-token'",
            "bearerToken=plain-bearer-secret",
            "privateKey=plain-private-secret",
            "sessionToken=plain-session-token",
          ],
        } },
        { claim: "May prefer terse calls to action.", confidence: "INFERRED" },
      ],
    }],
    links: [
      { id: "edge-1", source: "voice-node", target: "audience-node", relation: "supports", privatePath: "C:\\private\\drop" },
      { id: "edge-away", source: "other", target: "elsewhere", relation: "unrelated" },
    ],
  }

  const result = await projectGraphifyBrandClaims(input({
    snapshot: { ...input().snapshot, accessToken: "should-not-store" },
    graph,
    records: [{
    id: canonicalClient.id,
    asset: "voice",
    source: "client",
    content: canonicalClient.content,
    version: canonicalClient.version,
    }],
    fetchFn,
  }))

  assert.equal(result.written, 2)
  assert.ok(result.claims.every((claim) => claim.account_id === "acme-x"))
  assert.deepEqual(result.claims.map((claim) => [claim.confidence, claim.source]), [
    ["EXTRACTED", "client"],
    ["INFERRED", "generated"],
  ])
  const persisted = fetchFn.rows.filter((row) => row.metadata?.record_type === "brand-dna-claim")
  assert.equal(persisted.length, 2, "mixed confidence must not collapse into one asset-level source")
  assert.ok(persisted.every((row) => row.metadata.asset === "voice"))
  assert.ok(persisted.every((row) => row.metadata.run_id === "run-2026-08-14-a"))
  assert.ok(persisted.every((row) => assert.deepEqual(row.metadata.snapshot, input().snapshot) === undefined))
  assert.deepEqual(persisted[0].metadata.evidence, {
    node: { id: "voice-node", asset: "voice", label: "Voice", source_file: "brand/voice.md" },
    edges: [{ id: "edge-1", source: "voice-node", target: "audience-node", relation: "supports" }],
    claim: {
      nested: { safe: "kept" },
      note: "authorization=[redacted]",
      quoted: [
        'password="[redacted]"',
        'Authorization: "[redacted]"',
        'cookie="[redacted]"',
        "access_token='[redacted]'",
        "bearerToken=[redacted]",
        "privateKey=[redacted]",
        "sessionToken=[redacted]",
      ],
      span: "line 1",
    },
  })
  assert.deepEqual(persisted[1].metadata.evidence, {
    node: { id: "voice-node", asset: "voice", label: "Voice", source_file: "brand/voice.md" },
    edges: [{ id: "edge-1", source: "voice-node", target: "audience-node", relation: "supports" }],
  })
  assert.equal(Object.hasOwn(persisted[0].metadata, "provenance"), false, "EXTRACTED client evidence has no generated provenance")
  assert.deepEqual(persisted[1].metadata.provenance, PROVENANCE)
  assert.deepEqual(fetchFn.rows[0], canonicalClient, "the explicit canonical client record is never mutated or relabelled")
  assert.equal(JSON.stringify(persisted).includes("should-not-store"), false, "secret-bearing evidence and snapshot fields are removed")
  assert.ok(fetchFn.calls.every((call) => call.method !== "PATCH"), "derived claims never write the canonical record path")
})

test("dense Brand graphs index incident evidence once instead of rescanning every link for every claim node", () => {
  let endpointReads = 0
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    id: `node-${index}`,
    asset: "voice",
    claims: [{ claim: `Claim ${index}`, confidence: "EXTRACTED" }],
  }))
  const links = Array.from({ length: 2000 }, (_, index) => {
    const source = `node-${index % nodes.length}`
    const target = `node-${(index + 1) % nodes.length}`
    return {
      get source() { endpointReads += 1; return source },
      get target() { endpointReads += 1; return target },
      relation: "supports",
    }
  })

  const plans = claimPlans(input({ graph: { nodes, links } }))
  assert.equal(plans.length, nodes.length)
  assert.ok(endpointReads < 20_000,
    `incident-edge indexing read endpoints ${endpointReads} times; a per-node full scan would exceed 400,000`)
})

test("only an exact EXTRACTED token maps to client; every other non-INFERRED token is conservative", async () => {
  const fetchFn = memoryFetch()
  const graph = {
    nodes: [{
      id: "voice-confidence-table",
      asset: "voice",
      claims: [
        { claim: "exact extracted", confidence: "EXTRACTED", source: "generated" },
        { claim: "exact inferred", confidence: "INFERRED", source: "client" },
        { claim: "exact ambiguous", confidence: "AMBIGUOUS", source: "client" },
        { claim: "missing token", source: "client" },
        { claim: "unknown token", confidence: "unknown", source: "client" },
        { claim: "lowercase token", confidence: "extracted", source: "client" },
      ],
    }],
    links: [],
  }

  const result = await projectGraphifyBrandClaims(input({ graph, fetchFn }))

  assert.deepEqual(result.claims.map(({ confidence, source }) => [confidence, source]), [
    ["EXTRACTED", "client"],
    ["INFERRED", "generated"],
    ["AMBIGUOUS", "generated"],
    ["AMBIGUOUS", "generated"],
    ["AMBIGUOUS", "generated"],
    ["AMBIGUOUS", "generated"],
  ])
})

test("unknown confidence stays generated even when untrusted graph data says source client", async () => {
  const fetchFn = memoryFetch()
  const graph = {
    nodes: [{
      id: "intel-node",
      asset: "intel",
      title: "A title is not a claim",
      claims: [{ claim: "The category may be crowded.", confidence: "unknown", source: "client" }],
    }, {
      id: "calls-title-only",
      asset: "calls",
      title: "Never infer this title",
    }],
    links: [],
  }

  const result = await projectGraphifyBrandClaims(input({ graph, fetchFn }))

  assert.equal(result.written, 1)
  assert.equal(result.claims[0].confidence, "AMBIGUOUS")
  assert.equal(result.claims[0].source, "generated")
  assert.equal(fetchFn.rows[0].content, "The category may be crowded.")
  assert.equal(fetchFn.rows.some((row) => /Never infer/.test(row.content)), false, "node titles are never reverse-mapped into claims")
})

test("generated claims fail closed before the first write without valid provenance", async () => {
  const fetchFn = memoryFetch()
  await assert.rejects(
    projectGraphifyBrandClaims(input({
      snapshot: { id: "snapshot-without-provenance" },
      graph: {
        nodes: [{ id: "performance-node", asset: "performance", claims: [
          { claim: "An explicit sentence exists.", confidence: "EXTRACTED" },
          { claim: "Performance may improve.", confidence: "INFERRED" },
        ] }],
        links: [],
      },
      fetchFn,
    })),
    /generated claim.*provenance/i,
  )
  assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false)
})

test("a graph without explicit node claims is rejected; labels, titles, and edge text are never reverse-mapped", async () => {
  const fetchFn = memoryFetch()
  await assert.rejects(
    projectGraphifyBrandClaims(input({
      graph: {
        nodes: [
          { id: "title-only", asset: "calls", title: "Never infer this title" },
          { id: "label-only", asset: "intel", label: "Never infer this label" },
        ],
        links: [{ source: "title-only", target: "label-only", claim: "Never infer this edge" }],
      },
      fetchFn,
    })),
    /no explicit graph\.nodes\[\]\.claims\[\]/i,
  )
  assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false)

  const invalidFetch = memoryFetch()
  await assert.rejects(projectGraphifyBrandClaims(input({
    graph: { nodes: [{ id: "missing-asset", claims: [{ claim: "No asset", confidence: "EXTRACTED" }] }], links: [] },
    fetchFn: invalidFetch,
  })), /invalid asset: missing/i)
  assert.equal(invalidFetch.calls.some((call) => call.method === "POST"), false)
})

test("same-run projection resumes from durable claim keys and then becomes idempotent", async () => {
  const request = input({
    graph: {
      nodes: [{ id: "voice-node", asset: "voice", claims: [
        { claim: "Uses direct language.", confidence: "EXTRACTED" },
        { claim: "May favor short CTAs.", confidence: "INFERRED" },
      ] }],
      links: [],
    },
  })
  const plans = claimPlans(request)
  const firstPlan = plans[0]
  const fetchFn = memoryFetch([{
    id: "claim-durable",
    scope: "shared",
    kind: "fact",
    content: firstPlan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: 1,
    created_at: "2026-08-14T12:00:30.000Z",
    metadata: {
      app: "growth",
      record_type: "brand-dna-claim",
      account_id: request.accountId,
      asset: firstPlan.asset,
      source: firstPlan.source,
      confidence: firstPlan.confidence,
      run_id: request.runId,
      snapshot: firstPlan.snapshot,
      evidence: firstPlan.evidence,
      claim_key: firstPlan.claimKey,
      schemaVersion: 1,
    },
  }])
  request.fetchFn = fetchFn

  const concurrent = await Promise.all([
    projectGraphifyBrandClaims(request),
    projectGraphifyBrandClaims(request),
  ])
  const replayed = await projectGraphifyBrandClaims(request)

  assert.deepEqual(concurrent.map(({ written }) => written).sort(), [0, 1])
  assert.deepEqual(concurrent.map(({ existing }) => existing).sort(), [1, 2])
  assert.equal(replayed.written, 0)
  assert.equal(replayed.existing, 2)
  assert.equal(fetchFn.rows.filter((row) => row.metadata?.record_type === "brand-dna-claim").length, 2)
  assert.ok(fetchFn.rows.every((row) => assert.deepEqual(row.metadata.snapshot, request.snapshot) === undefined))
})

test("a later claim failure reports the exact number already saved", async () => {
  const baseFetch = memoryFetch()
  let posts = 0
  const fetchFn = async (url, options = {}) => {
    if ((options.method || "GET") === "POST") {
      posts += 1
      if (posts === 2) return response(503, { error: "Brain claim write refused" })
    }
    return baseFetch(url, options)
  }
  const request = input({
    graph: {
      nodes: [{ id: "voice-node", asset: "voice", claims: [
        { claim: "The first claim lands.", confidence: "EXTRACTED" },
        { claim: "The second claim fails.", confidence: "INFERRED" },
      ] }],
      links: [],
    },
    fetchFn,
  })

  await assert.rejects(projectGraphifyBrandClaims(request), (error) => {
    assert.equal(error.landedCount, 1)
    assert.equal(error.existingCount, 0)
    assert.equal(error.totalClaims, 2)
    assert.match(error.message, /failed after 1 new claim was saved.*Brain claim write refused/i)
    return true
  })
  assert.equal(baseFetch.rows.filter((row) => row.metadata?.record_type === "brand-dna-claim").length, 1)
})

test("a run id cannot silently move to a different snapshot", async () => {
  const fetchFn = memoryFetch()
  const request = input({ fetchFn })
  await projectGraphifyBrandClaims(request)

  await assert.rejects(
    projectGraphifyBrandClaims({ ...request, snapshot: { ...request.snapshot, id: "snapshot-b" } }),
    /run .* already bound to a different snapshot/i,
  )
  assert.equal(fetchFn.rows.filter((row) => row.metadata?.record_type === "brand-dna-claim").length, 1)
})

test("a supplied same-run claim from another account is rejected before any write", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const fetchFn = memoryFetch()
  const foreign = {
    id: "foreign-claim",
    content: "A foreign account's content.",
    version: 1,
    metadata: {
      app: "growth",
      record_type: "brand-dna-claim",
      account_id: "other-account",
      asset: plan.asset,
      source: plan.source,
      confidence: plan.confidence,
      run_id: request.runId,
      snapshot: plan.snapshot,
      evidence: plan.evidence,
      claim_key: plan.claimKey,
      schemaVersion: 1,
    },
  }

  await assert.rejects(
    projectGraphifyBrandClaims({ ...request, records: [foreign], fetchFn }),
    /claim row.*account/i,
  )
  assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false)
})

test("a forged supplied same-run claim never substitutes for a durable Brain row", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const forged = {
    id: "forged-corpus-claim",
    record_type: "brand-dna-claim",
    account_id: request.accountId,
    run_id: request.runId,
    claim_key: plan.claimKey,
    snapshot: plan.snapshot,
    content: null,
  }
  const calls = []
  const fetchFn = async (rawUrl, options = {}) => {
    const method = options.method || "GET"
    calls.push({ method, url: new URL(rawUrl) })
    if (method === "GET") return response(200, { memories: [] })
    return response(503, { error: "durable write refused" })
  }

  await assert.rejects(
    projectGraphifyBrandClaims({ ...request, records: [forged], fetchFn }),
    (error) => {
      assert.equal(error.landedCount, 0)
      assert.equal(error.existingCount, 0, "caller records are not durable confirmations")
      assert.equal(error.totalClaims, 1)
      assert.match(error.message, /durable write refused/i)
      return true
    },
  )
  assert.equal(calls.filter((call) => call.method === "GET").length, 1)
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "a forged corpus row cannot avoid the durable write")
})

test("every claim metadata body is preflighted before the first write", async () => {
  const fetchFn = memoryFetch()
  const oversizedEvidence = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`field_${String(index).padStart(2, "0")}`, "x".repeat(1000)]),
  )

  await assert.rejects(
    projectGraphifyBrandClaims(input({
      graph: {
        nodes: [{ id: "voice-node", asset: "voice", claims: [
          { claim: "This valid claim must not land first.", confidence: "EXTRACTED" },
          { claim: "This evidence is too large.", confidence: "EXTRACTED", evidence: oversizedEvidence },
        ] }],
        links: [],
      },
      fetchFn,
    })),
    /metadata.*32768 bytes/i,
  )
  assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false)
})

test("a timed-out Brain call releases the same-run queue for a retry", async () => {
  const baseFetch = memoryFetch()
  let stallFirst = true
  const fetchFn = async (url, options = {}) => {
    if (!stallFirst) return baseFetch(url, options)
    stallFirst = false
    if (!options.signal) throw new Error("missing abort signal")
    return new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000)
      options.signal.addEventListener("abort", () => {
        clearInterval(keepAlive)
        reject(options.signal.reason)
      }, { once: true })
    })
  }
  const request = input({ cfg: { ...CFG, timeoutMs: 5 }, fetchFn })

  await assert.rejects(projectGraphifyBrandClaims(request), /brain did not answer.*timed out/i)
  const retried = await projectGraphifyBrandClaims(request)
  assert.equal(retried.written, 1)
  assert.equal(baseFetch.rows.length, 1)
})

test("a successful Brain response with invalid JSON names the parse failure", async () => {
  const fetchFn = async () => invalidJsonResponse(200)

  await assert.rejects(
    projectGraphifyBrandClaims(input({ fetchFn })),
    /brain returned invalid JSON.*Unexpected token/i,
  )
})

test("an oversized declared response is rejected before its body is read", async () => {
  let bodyRead = false
  const fetchFn = async (_url, options = {}) => {
    if ((options.method || "GET") === "GET") return response(200, { memories: [] })
    return {
      ok: true,
      status: 201,
      headers: { get: (name) => name.toLowerCase() === "content-length" ? String(1024 * 1024 * 1024) : null },
      get body() {
        bodyRead = true
        throw new Error("oversized body must not be opened")
      },
    }
  }

  await assert.rejects(
    projectGraphifyBrandClaims(input({ fetchFn })),
    /declared response.*exceeds.*POST row/i,
  )
  assert.equal(bodyRead, false)
})

test("a streamed response is cancelled once it exceeds the POST row byte ceiling", async () => {
  let posts = 0
  const fetchFn = async (_url, options = {}) => {
    if ((options.method || "GET") === "GET") return response(200, { memories: [] })
    posts += 1
    const chunk = new Uint8Array(64 * 1024).fill(0x78)
    return streamedResponse(201, [chunk, chunk, chunk])
  }

  await assert.rejects(
    projectGraphifyBrandClaims(input({ fetchFn })),
    /response body exceeded.*POST row/i,
  )
  assert.equal(posts, 1)
})

test("the durable claim lookup rejects malformed successful GET envelopes", async () => {
  for (const body of [null, [], {}, { memories: null }, { memories: {} }, { memories: [null] }]) {
    const fetchFn = async () => response(200, body)
    await assert.rejects(
      projectGraphifyBrandClaims(input({ fetchFn })),
      /brain returned an invalid memory list/i,
    )
  }
})

test("a GET page cannot return more rows than its requested page limit", async () => {
  const fetchFn = async () => response(200, { memories: Array.from({ length: 201 }, () => ({})) })

  await assert.rejects(
    projectGraphifyBrandClaims(input({ fetchFn })),
    /memory list.*more than 200 rows/i,
  )
})

test("stored same-run rows must contain the exact planned content and metadata", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const exactRow = {
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: 1,
    created_at: "2026-08-14T12:01:00.000Z",
    metadata: claimMetadata(request.accountId, request.runId, plan),
  }
  const cases = [
    ["null content", (row) => ({ ...row, content: null })],
    ["wrong content", (row) => ({ ...row, content: "Different claim text." })],
    ["wrong metadata", (row) => ({ ...row, metadata: { ...row.metadata, confidence: "AMBIGUOUS" } })],
    ["mismatched provenance", (row) => ({ ...row, metadata: { ...row.metadata, provenance: PROVENANCE } })],
    ["wrong scope", (row) => ({ ...row, scope: "private" })],
    ["wrong kind", (row) => ({ ...row, kind: "note" })],
    ["wrong tags", (row) => ({ ...row, tags: ["growth", "brand-dna"] })],
  ]

  for (const [label, alterRow] of cases) {
    const fetchFn = memoryFetch([alterRow(structuredClone(exactRow))])
    await assert.rejects(
      projectGraphifyBrandClaims({ ...request, fetchFn }),
      /stored returned claim row.*(content|metadata|scope|kind|tags)/i,
      label,
    )
    assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false, label)
  }
})

test("durable claim lookup drops large irrelevant Brain row fields after exact validation", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const metadata = claimMetadata(request.accountId, request.runId, plan)
  const padding = "x".repeat(2 * 1024 * 1024)
  const fetchFn = memoryFetch([{
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: 3,
    created_at: "2026-08-14T12:01:00.000Z",
    updated_at: "2026-08-14T12:02:00.000Z",
    metadata,
    irrelevant_padding: padding,
  }])
  const expectedByKey = new Map([[plan.claimKey, { plan, metadata }]])

  const retained = await existingRunClaims(
    { ...CFG, timeoutMs: 8000 },
    request.accountId,
    request.runId,
    expectedByKey,
    fetchFn,
  )

  assert.equal(retained.length, 1)
  assert.equal(Object.hasOwn(retained[0], "irrelevant_padding"), false)
  assert.ok(JSON.stringify(retained[0]).length < 64 * 1024, "retained state must stay canonical and bounded")
  assert.deepEqual(retained[0], {
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: 3,
    updated_at: "2026-08-14T12:02:00.000Z",
    metadata,
  })
})

test("canonical retained claims drop padded and unbounded optional Brain response fields", () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const metadata = claimMetadata(request.accountId, request.runId, plan)

  const retained = retainedClaimRow({
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: "v".repeat(1024 * 1024),
    updated_at: "t".repeat(1024 * 1024),
    metadata,
    irrelevant_padding: "x".repeat(2 * 1024 * 1024),
  }, { plan, metadata })

  assert.deepEqual(retained, {
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    metadata,
  })
})

test("oversized durable Brain ids fail closed on both GET and POST confirmations", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const metadata = claimMetadata(request.accountId, request.runId, plan)
  const oversizedId = "x".repeat(513)
  const storedFetch = memoryFetch([{
    id: oversizedId,
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    metadata,
  }])

  await assert.rejects(
    projectGraphifyBrandClaims({ ...request, fetchFn: storedFetch }),
    /stored returned claim row has an oversized id/i,
  )
  const postFetch = async (rawUrl, options = {}) => {
    if ((options.method || "GET") === "GET") return response(200, { memories: [] })
    return response(201, { id: oversizedId, ...JSON.parse(options.body) })
  }
  await assert.rejects(projectGraphifyBrandClaims({ ...request, fetchFn: postFetch }), (error) => {
    assert.equal(error.landedCount, 0)
    assert.match(error.message, /claim save returned claim row has an oversized id/i)
    return true
  })
})

test("stored same-run rows reject duplicate and unplanned durable claim keys", async () => {
  const request = input()
  const plan = claimPlans(request)[0]
  const exactRow = {
    id: "claim-stored",
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    version: 1,
    created_at: "2026-08-14T12:01:00.000Z",
    metadata: claimMetadata(request.accountId, request.runId, plan),
  }
  const cases = [
    ["duplicate durable claim key", [exactRow, { ...structuredClone(exactRow), id: "claim-duplicate" }], /duplicate durable claim key/i],
    ["unplanned durable claim key", [{
      ...structuredClone(exactRow),
      id: "claim-extra",
      metadata: { ...exactRow.metadata, claim_key: "f".repeat(64) },
    }], /metadata outside the current plan/i],
  ]

  for (const [label, rows, cause] of cases) {
    const fetchFn = memoryFetch(rows)
    await assert.rejects(projectGraphifyBrandClaims({ ...request, fetchFn }), cause, label)
    assert.equal(fetchFn.calls.some((call) => call.method === "POST"), false, label)
  }
})

test("a 5001st durable same-run row is rejected instead of being hidden past the claim cap", async () => {
  const request = input({
    graph: {
      nodes: Array.from({ length: 5000 }, (_, index) => ({
        id: `voice-${index}`,
        asset: "voice",
        claims: [{ claim: `Claim ${index}`, confidence: "EXTRACTED" }],
      })),
      links: [],
    },
  })
  const plans = claimPlans(request)
  const rows = plans.map((plan, index) => ({
    id: `claim-${index}`,
    scope: "shared",
    kind: "fact",
    content: plan.content,
    tags: ["growth", "brand-dna", "brand-dna-claim"],
    metadata: claimMetadata(request.accountId, request.runId, plan),
  }))
  rows.push({ ...structuredClone(rows[0]), id: "claim-5000" })
  const fetchFn = async (rawUrl, options = {}) => {
    assert.equal(options.method || "GET", "GET")
    const url = new URL(rawUrl)
    const offset = Number(url.searchParams.get("offset") || 0)
    const limit = Number(url.searchParams.get("limit") || 200)
    return response(200, { memories: rows.slice(offset, offset + limit) })
  }

  await assert.rejects(
    projectGraphifyBrandClaims({ ...request, fetchFn }),
    /more than 5000 durable claim rows/i,
  )
})

test("ambiguous successful POST responses are not confirmed and resume from the durable same-run row", async () => {
  const cases = [
    ["null row", () => null],
    ["malformed row", () => ({ id: "claim-malformed", metadata: null })],
    ["wrong account", (row) => ({ ...row, metadata: { ...row.metadata, account_id: "other-account" } })],
    ["wrong run", (row) => ({ ...row, metadata: { ...row.metadata, run_id: "other-run" } })],
    ["wrong claim key", (row) => ({ ...row, metadata: { ...row.metadata, claim_key: "0".repeat(64) } })],
    ["null content", (row) => ({ ...row, content: null })],
    ["wrong content", (row) => ({ ...row, content: "Different claim text." })],
    ["wrong metadata", (row) => ({ ...row, metadata: { ...row.metadata, source: "generated" } })],
    ["mismatched provenance", (row) => ({ ...row, metadata: { ...row.metadata, provenance: PROVENANCE } })],
    ["wrong scope", (row) => ({ ...row, scope: "private" })],
    ["wrong kind", (row) => ({ ...row, kind: "note" })],
    ["wrong tags", (row) => ({ ...row, tags: ["growth", "brand-dna"] })],
  ]

  for (const [label, alterResponse] of cases) {
    const baseFetch = memoryFetch()
    let ambiguous = true
    const fetchFn = async (url, options = {}) => {
      const result = await baseFetch(url, options)
      if (ambiguous && (options.method || "GET") === "POST") {
        ambiguous = false
        return response(201, alterResponse(structuredClone(baseFetch.rows.at(-1))))
      }
      return result
    }
    const request = input({ fetchFn })

    await assert.rejects(projectGraphifyBrandClaims(request), (error) => {
      assert.equal(error.landedCount, 0, `${label}: an unverified response must not count as landed`)
      assert.equal(error.existingCount, 0)
      assert.equal(error.totalClaims, 1)
      assert.match(error.message, /claim save failed.*returned claim row/i)
      return true
    })
    assert.equal(baseFetch.rows.length, 1, `${label}: the first write may have landed despite its ambiguous response`)

    const retried = await projectGraphifyBrandClaims(request)
    assert.equal(retried.written, 0, `${label}: retry must not write a duplicate`)
    assert.equal(retried.existing, 1)
    assert.equal(baseFetch.calls.filter((call) => call.method === "POST").length, 1)
  }
})

test("a successful POST with invalid JSON is retry-safe when the durable write landed", async () => {
  const baseFetch = memoryFetch()
  let ambiguous = true
  const fetchFn = async (url, options = {}) => {
    const result = await baseFetch(url, options)
    if (ambiguous && (options.method || "GET") === "POST") {
      ambiguous = false
      return invalidJsonResponse(201, "")
    }
    return result
  }
  const request = input({ fetchFn })

  await assert.rejects(projectGraphifyBrandClaims(request), (error) => {
    assert.equal(error.landedCount, 0)
    assert.match(error.message, /brain returned invalid JSON.*Unexpected end/i)
    return true
  })
  const retried = await projectGraphifyBrandClaims(request)
  assert.deepEqual({ written: retried.written, existing: retried.existing }, { written: 0, existing: 1 })
  assert.equal(baseFetch.calls.filter((call) => call.method === "POST").length, 1)
})
