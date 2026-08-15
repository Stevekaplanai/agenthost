"use strict";
// growth-lib.test.js -- pure-node tests, no network: a scripted fake fetch
// plays the brain. Run: node container/growth-lib.test.js
const assert = require("assert");
const { Readable } = require("stream");
const g = require("./growth-lib.js");

let passed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("ok - " + name); },
    (e) => { console.error("FAIL - " + name + ": " + e.message); process.exitCode = 1; });
}

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const step = script.shift();
    if (!step) throw new Error("fakeFetch: no scripted response left for " + url);
    return { ok: step.code < 400, status: step.code, json: async () => step.body };
  };
  fn.calls = calls;
  return fn;
}

const CFG = { ok: true, url: "http://brain", key: "k" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

(async () => {
  await ok("config: unset -> not ok, names both missing pieces", () => {
    const c = g.config({});
    assert.strictEqual(c.ok, false);
    assert.match(c.why, /MEMORY_SERVICE_URL and MEMORY_GATE_KEY/);
  });

  await ok("putDna: refuses a write without a valid source (the hard rule)", async () => {
    const r = await g.putDna(CFG, "acme-x", "voice", { content: "hi", source: "display" }, fakeFetch([]));
    assert.strictEqual(r.code, 400);
    assert.match(r.body.error, /stamped in storage at write time/);
  });

  await ok("putDna: creates when absent, stamping metadata.source", async () => {
    const f = fakeFetch([
      { code: 200, body: { memories: [] } }, // listDna: nothing yet
      { code: 201, body: { id: "u1", content: "hi", version: 1, metadata: { asset: "voice", source: "client", account_id: "acme-x", schemaVersion: 1 } } },
    ]);
    const r = await g.putDna(CFG, "acme-x", "voice", { content: "hi", source: "client" }, f);
    assert.strictEqual(r.code, 201);
    assert.strictEqual(f.calls[1].method, "POST");
    assert.strictEqual(f.calls[1].body.metadata.source, "client");
    assert.strictEqual(f.calls[1].body.metadata.schemaVersion, g.SCHEMA_VERSION);
    assert.strictEqual(r.body.record.account_id, "acme-x");
  });

  await ok("putDna: generated provenance is stored and projected without changing the base schema", async () => {
    const provenance = {
      source_url: "https://example.com/",
      source_urls: ["https://example.com/", "https://example.com/about"],
      generated_at: "2026-08-12T12:00:00.000Z",
    };
    const f = fakeFetch([
      { code: 200, body: { memories: [] } },
      { code: 201, body: { id: "u1", content: "voice", version: 1, updated_at: "t", metadata: { asset: "voice", source: "generated", account_id: "acme-x", schemaVersion: 1, provenance } } },
    ]);
    const r = await g.putDna(CFG, "acme-x", "voice", { content: "voice", source: "generated", provenance }, f);
    assert.deepEqual(f.calls[1].body.metadata.provenance, provenance);
    assert.deepEqual(r.body.record.provenance, provenance);
  });

  await ok("putDna: patches when present, retries once on version conflict", async () => {
    const existing = { id: "u1", content: "old", version: 3, created_at: "t", updated_at: "t", metadata: { app: "growth", record_type: "brand-dna", account_id: "acme-x", asset: "voice", source: "client", schemaVersion: 1 } };
    const f = fakeFetch([
      { code: 200, body: { memories: [existing] } },
      { code: 409, body: { error: "version conflict or not found" } },
      { code: 200, body: { memories: [{ ...existing, version: 4 }] } },
      { code: 200, body: { id: "u1", version: 5, updated_at: "t2" } },
    ]);
    const r = await g.putDna(CFG, "acme-x", "voice", { content: "new", source: "generated" }, f);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.record.version, 5);
    assert.strictEqual(f.calls[3].body.version, 4); // retried with the re-read version
    assert.strictEqual(f.calls[3].body.metadata.source, "generated");
  });

  await ok("exportAccount: pages until a short page and splits record types", async () => {
    const dna = (i) => ({ id: "d" + i, content: "c", version: 1, metadata: { record_type: "brand-dna", asset: "a" + i, source: "client", account_id: "acme-x" } });
    const claim = { id: "claim-1", content: "Derived claim", version: 1, metadata: {
      record_type: "brand-dna-claim", asset: "voice", source: "generated", confidence: "INFERRED",
      account_id: "acme-x", run_id: "run-1", snapshot: { id: "snapshot-1" },
      evidence: { node: { id: "voice-node" }, edges: [] },
      provenance: { source_url: "https://example.com/", source_urls: ["https://example.com/"], generated_at: "2026-08-14T12:00:00.000Z" },
    } };
    const page1 = { code: 200, body: { memories: Array.from({ length: 200 }, (_, i) => dna(i)) } };
    const page2 = { code: 200, body: { memories: [dna(200), claim, { id: "acct", content: "c", created_at: "t", metadata: { record_type: "account", account_id: "acme-x", name: "Acme" } }] } };
    const f = fakeFetch([page1, page2]);
    const dump = await g.exportAccount(CFG, "acme-x", f);
    assert.strictEqual(dump.records.length, 201);
    assert.strictEqual(dump.records[0].source, "client");
    assert.strictEqual(dump.records[0].account_id, "acme-x");
    assert.strictEqual(dump.claims.length, 1);
    assert.strictEqual(dump.claims[0].record_type, "brand-dna-claim");
    assert.strictEqual(dump.claims[0].account_id, "acme-x");
    assert.strictEqual(dump.claims[0].confidence, "INFERRED");
    assert.strictEqual(dump.accounts.length, 1);
    assert.match(f.calls[1].url, /offset=200/);
    assert.strictEqual(dump.format, "agenthost-brand-dna");
  });

  await ok("handleGrowth: unconfigured -> 503 {configured:false} with the reason", async () => {
    let sent = null;
    const sendJson = (res, code, body) => { sent = { code, body }; };
    const handled = g.handleGrowth(new URL("http://x/growth/accounts"), { method: "GET" }, {}, sendJson, fakeFetch([]), {});
    assert.strictEqual(handled, true);
    assert.strictEqual(sent.code, 503);
    assert.strictEqual(sent.body.configured, false);
    assert.match(sent.body.error, /brain is not connected/);
  });

  await ok("handleGrowth: ignores non-growth paths", () => {
    const handled = g.handleGrowth(new URL("http://x/cc"), { method: "GET" }, {}, () => {}, fakeFetch([]), {});
    assert.strictEqual(handled, false);
  });

  await ok("from-url route names malformed JSON as 400 without starting work", async () => {
    const sent = await new Promise((resolve) => {
      const req = Readable.from([Buffer.from('{"url":')]);
      req.method = "POST";
      const handled = g.handleGrowth(
        new URL("http://x/growth/accounts/acme-x/dna/from-url"), req, {},
        (_res, code, body) => resolve({ code, body }), fakeFetch([]),
        { MEMORY_SERVICE_URL: "http://brain", MEMORY_GATE_KEY: "k" },
        { buildBrandDna: async () => { throw new Error("generation must not start"); } },
      );
      assert.equal(handled, true);
    });
    assert.equal(sent.code, 400);
    assert.match(sent.body.error, /request body contained invalid JSON/i);
  });

  await ok("from-url route names an oversized JSON body as 413 without starting work", async () => {
    const sent = await new Promise((resolve) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ url: `https://example.com/${"x".repeat(9000)}` }))]);
      req.method = "POST";
      g.handleGrowth(
        new URL("http://x/growth/accounts/acme-x/dna/from-url"), req, {},
        (_res, code, body) => resolve({ code, body }), fakeFetch([]),
        { MEMORY_SERVICE_URL: "http://brain", MEMORY_GATE_KEY: "k" },
        { buildBrandDna: async () => { throw new Error("generation must not start"); } },
      );
    });
    assert.equal(sent.code, 413);
    assert.match(sent.body.error, /request body exceeded 8192 bytes/i);
  });

  await ok("from-url reserved asset rejects generic PUT at the route with zero Brain writes", async () => {
    const f = fakeFetch([]);
    const sent = await new Promise((resolve) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ content: "must not land", source: "client" }))]);
      req.method = "PUT";
      const handled = g.handleGrowth(
        new URL("http://x/growth/accounts/acme-x/dna/from-url"), req, {},
        (_res, code, body) => resolve({ code, body }), f,
        { MEMORY_SERVICE_URL: "http://brain", MEMORY_GATE_KEY: "k" },
      );
      assert.equal(handled, true);
    });
    assert.equal(sent.code, 405);
    assert.equal(sent.body.error, "unsupported method for this growth route");
    assert.equal(f.calls.length, 0);
  });

  await ok("brain errors carry the brain's own words", async () => {
    const f = fakeFetch([{ code: 500, body: { error: "database on fire" } }]);
    await assert.rejects(() => g.listAccounts(CFG, f), /the brain refused \(database on fire\)/);
  });

  await ok("Brain account reads reject an oversized declared body before Brand work starts", async () => {
    let builds = 0;
    const f = async () => new Response('{"memories":[]}', {
      status: 200,
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    });
    await assert.rejects(
      () => g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, f, {
        buildBrandDna: async () => { builds++; throw new Error("must not run"); },
      }),
      /declared response length.*exceeds.*8388608-byte/i,
    );
    assert.equal(builds, 0);
  });

  await ok("Brain DNA reads stop a streamed body at the byte limit before parsing it", async () => {
    const padding = "x".repeat(8 * 1024 * 1024);
    const f = async () => new Response(JSON.stringify({ memories: [], padding }), { status: 200 });
    await assert.rejects(
      () => g.listDna(CFG, "acme-x", f),
      /response body exceeded the 8388608-byte limit/i,
    );
  });

  await ok("query-bearing source URLs fail before fetch, model, or Brain write without echoing secrets", async () => {
    const secret = "fixture-secret-must-not-escape";
    const f = fakeFetch([]);
    let builds = 0;
    const result = await g.generateDnaFromUrl(CFG, "acme-x", { url: `https://example.com/?access_token=${secret}` }, f, {
      buildBrandDna: async () => { builds++; throw new Error("must not run"); },
    });
    assert.equal(result.code, 400);
    assert.match(result.body.error, /query strings are not accepted/i);
    assert.doesNotMatch(result.body.error, new RegExp(secret));
    assert.equal(builds, 0);
    assert.equal(f.calls.length, 0);
  });

  await ok("generateDnaFromUrl runs one validated synthesis then writes exactly five generated assets", async () => {
    let modelRuns = 0;
    const generated = Object.fromEntries(g.BRAND_ASSETS.map((asset) => [asset, `${asset} evidence`]));
    const script = [{ code: 200, body: { memories: [{ created_at: "t", metadata: { record_type: "account", account_id: "acme-x", name: "Acme" } }] } }];
    for (const asset of g.BRAND_ASSETS) script.push(
      { code: 200, body: { memories: [] } },
      { code: 201, body: { id: asset, content: generated[asset], version: 1, created_at: "t", metadata: { asset, source: "generated", account_id: "acme-x", schemaVersion: 1 } } },
    );
    const f = fakeFetch(script);
    const result = await g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, f, {
      buildBrandDna: async (url, { runModel }) => {
        assert.equal(url, "https://example.com/");
        await runModel("one prompt");
        return { assets: generated, provenance: { source_url: "https://example.com/", source_urls: ["https://example.com/"], generated_at: "2026-08-12T12:00:00.000Z" } };
      },
      runModel: async () => { modelRuns++; return "unused by fake builder"; },
    });
    assert.equal(result.code, 200);
    assert.equal(result.body.written, 5);
    assert.ok(result.body.records.every((record) => record.updated_at === "t"),
      "actual Brain POST rows expose created_at, which must satisfy the live API record contract");
    assert.equal(modelRuns, 1);
    const writes = f.calls.filter((call) => call.method === "POST");
    assert.deepEqual(writes.map((call) => call.body.metadata.asset), g.BRAND_ASSETS);
    assert.ok(writes.every((call) => call.body.metadata.source === "generated"));
    assert.ok(writes.every((call) => call.body.metadata.provenance.source_url === "https://example.com/"));
  });

  await ok("generateDnaFromUrl validates every asset before the first Brain write", async () => {
    const generated = Object.fromEntries(g.BRAND_ASSETS.map((asset) => [asset, asset === "voice" ? "x".repeat(12_001) : `${asset} evidence`]));
    const f = fakeFetch([
      { code: 200, body: { memories: [{ created_at: "t", metadata: { record_type: "account", account_id: "acme-x", name: "Acme" } }] } },
    ]);
    await assert.rejects(() => g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, f, {
      buildBrandDna: async () => ({ assets: generated, provenance: { source_url: "https://example.com/", source_urls: [], generated_at: "2026-08-12T12:00:00.000Z" } }),
    }), /voice.*12000/i);
    assert.equal(f.calls.filter((call) => call.method !== "GET").length, 0);
  });

  await ok("generateDnaFromUrl names a partial Brain write with landed count and failed asset", async () => {
    const generated = Object.fromEntries(g.BRAND_ASSETS.map((asset) => [asset, `${asset} evidence`]));
    const f = fakeFetch([
      { code: 200, body: { memories: [{ created_at: "t", metadata: { record_type: "account", account_id: "acme-x", name: "Acme" } }] } },
      { code: 200, body: { memories: [] } }, { code: 201, body: { id: "g", content: generated.guidelines, version: 1, metadata: { asset: "guidelines", source: "generated" } } },
      { code: 200, body: { memories: [] } }, { code: 500, body: { error: "disk unavailable" } },
    ]);
    const result = await g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, f, {
      buildBrandDna: async () => ({ assets: generated, provenance: { source_url: "https://example.com/", source_urls: [], generated_at: "2026-08-12T12:00:00.000Z" } }),
      runModel: async () => "unused",
    });
    assert.equal(result.code, 502);
    assert.equal(result.body.written, 1);
    assert.equal(result.body.failed_asset, "voice");
    assert.match(result.body.error, /stored 1 of 5.*voice.*disk unavailable/i);
  });

  await ok("one account serializes website builds and manual saves without blocking other accounts", async () => {
    const build = deferred();
    const started = deferred();
    const generated = Object.fromEntries(g.BRAND_ASSETS.map((asset) => [asset, `${asset} evidence`]));
    const script = [{ code: 200, body: { memories: [{ created_at: "t", metadata: { record_type: "account", account_id: "acme-x", name: "Acme" } }] } }];
    for (const asset of g.BRAND_ASSETS) script.push(
      { code: 200, body: { memories: [] } },
      { code: 201, body: { id: asset, content: generated[asset], version: 1, created_at: "t", metadata: { asset, source: "generated" } } },
    );
    let firstBuildRuns = 0;
    const generation = g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, fakeFetch(script), {
      buildBrandDna: async () => {
        firstBuildRuns++;
        started.resolve();
        return build.promise;
      },
    });
    await started.promise;

    const sameAccountFetch = fakeFetch([]);
    const save = await g.putDna(CFG, "acme-x", "voice", { content: "operator edit", source: "client" }, sameAccountFetch);
    assert.equal(save.code, 409);
    assert.match(save.body.error, /already being changed.*acme-x/i);
    assert.equal(sameAccountFetch.calls.length, 0, "a conflicting manual save reached the Brain");

    let secondBuildRuns = 0;
    const secondFetch = fakeFetch([]);
    const second = await g.generateDnaFromUrl(CFG, "acme-x", { url: "https://example.com" }, secondFetch, {
      buildBrandDna: async () => { secondBuildRuns++; throw new Error("must not run"); },
    });
    assert.equal(second.code, 409);
    assert.equal(secondBuildRuns, 0, "a second model run started while the account was locked");
    assert.equal(secondFetch.calls.length, 0);

    const otherFetch = fakeFetch([
      { code: 200, body: { memories: [] } },
      { code: 201, body: { id: "other", content: "safe", version: 1, created_at: "t", metadata: { asset: "voice", source: "client" } } },
    ]);
    assert.equal((await g.putDna(CFG, "other-account", "voice", { content: "safe", source: "client" }, otherFetch)).code, 201);
    build.resolve({
      assets: generated,
      provenance: { source_url: "https://example.com/", source_urls: [], generated_at: "2026-08-12T12:00:00.000Z" },
    });
    assert.equal((await generation).code, 200);
    assert.equal(firstBuildRuns, 1);
  });

  await ok("an account mutation lock releases after a model failure", async () => {
    await assert.rejects(
      () => g.generateDnaFromUrl(CFG, "release-me", { url: "https://example.com" }, fakeFetch([
        { code: 200, body: { memories: [{ created_at: "t", metadata: { record_type: "account", account_id: "release-me", name: "Release" } }] } },
      ]), { buildBrandDna: async () => { throw new Error("model unavailable"); } }),
      /model unavailable/i,
    );
    const f = fakeFetch([
      { code: 200, body: { memories: [] } },
      { code: 201, body: { id: "released", content: "saved", version: 1, created_at: "t", metadata: { asset: "voice", source: "client" } } },
    ]);
    assert.equal((await g.putDna(CFG, "release-me", "voice", { content: "saved", source: "client" }, f)).code, 201);
  });

  console.log(`GROWTH-LIB ${passed} passed${process.exitCode ? " (with failures)" : ", 0 failed"}`);
})();
