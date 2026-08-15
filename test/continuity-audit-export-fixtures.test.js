import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CONT-10 Audit Trail Export contract fixtures (hardened 2026-07-22 after a two-agent
// red-team; see docs/continuity/CONT-09-10-REDTEAM-LOG.md).
// Contract: docs/continuity/AUDIT-EXPORT-CONTRACT.md (CONT-10, v1).
//
// Contract fixtures, not a runtime. They pin the behaviors the later exporter must
// reproduce as CONCRETE outputs (not boolean flags): stable codepoint ts-then-id
// ordering, a shape-scrubber over planted secrets incl. un-redacted audit detail, an
// unbounded audit retention gap, count reconciliation to the range-filtered snapshot,
// integer-minor-unit spend, recording as a system run with an {type:"export"} artifact
// (there is no export run kind), and no append-loop / no second store.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "audit-export-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "orderingCases", "secretCases", "retentionCases", "contentCases", "consistencyCases",
  "spendCases", "sizeCases", "requestCases", "pdfCases", "exportArtifactCases", "envelopeCases",
];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

test("audit-export fixture has one versioned, collision-free catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-audit-export-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-10");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 30, "the hardened corpus needs a meaningful surface");
});

test("JSON carries schemaVersion + the eight sections; retention mirrors the real sources", () => {
  assert.ok(fixture.jsonSections.includes("schemaVersion"), "export must be versioned");
  for (const s of ["runs", "spend", "approvals", "gateEvents", "boardSnapshots", "artifacts", "coverage", "generatedAt"])
    assert.ok(fixture.jsonSections.includes(s), `JSON must carry ${s}`);
  assert.equal(fixture.sourceRetention.runs.days, 30);
  assert.equal(fixture.sourceRetention.runs.minimumTerminalRuns, 1000);
  assert.equal(fixture.sourceRetention.runs.configurable, true);
  assert.equal(fixture.sourceRetention.auditLog.rotateBytes, 1048576);
  assert.equal(fixture.sourceRetention.auditLog.gapExtent, "unknown-unbounded");
});

test("records sort by immutable createdAt, tie-broken by id codepoint, never localeCompare", () => {
  const o = byId("orderingCases").get("stable-ts-then-id-codepoint-order");
  assert.deepEqual(o.expected.orderedIds, ["run_a", "run_c", "run_d", "run_b"]);
  assert.equal(o.expected.usesLocaleCompare, false);
  assert.equal(o.expected.ordersByCreatedAtNotUpdatedAt, true);
  // Independently recompute the canonical order from the inputs to prove it isn't hand-set.
  const recomputed = [...o.inputRecords]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
  assert.deepEqual(recomputed, o.expected.orderedIds);
});

test("secrets are scrubbed: box values (incl. un-redacted audit detail) and third-party shapes", () => {
  const sc = byId("secretCases");
  assert.equal(sc.get("box-secret-in-run-summary-scrubbed").expected.exportContainsSecret, false);
  const audit = sc.get("box-secret-in-audit-detail-scrubbed");
  assert.equal(audit.auditRedactedAtWrite, false, "audit() does not redact at write");
  assert.equal(audit.expected.exportContainsSecret, false, "export must scrub audit detail itself");
  assert.equal(sc.get("raw-prompt-never-exported").expected.presentInExport, false);
  assert.equal(sc.get("full-agent-output-never-exported").expected.presentInExport, false);
  assert.equal(sc.get("third-party-shape-scrubbed").expected.exportContainsValue, false);
  // Residual risk is disclosed, not hidden.
  const residual = sc.get("third-party-unknown-shape-best-effort-disclosed");
  assert.equal(residual.expected.guaranteedScrubbed, false);
  assert.equal(residual.expected.bestEffortDisclosed, true);
});

test("the audit retention gap is disclosed as unknown/unbounded, never a bounded window", () => {
  const rc = byId("retentionCases");
  const gap = rc.get("audit-rotation-gap-extent-unknown");
  assert.ok(gap.rotationsPastPredecessor > 1);
  assert.equal(gap.expected.gapExtent, "unknown-unbounded");
  assert.equal(gap.expected.impliesBoundedGap, false);
  assert.equal(gap.expected.earliestReadableTsSurfaced, gap.earliestReadableTs, "earliest ts is surfaced, not dead");
  const runs = rc.get("runs-at-configured-retention-boundary");
  assert.equal(runs.readsConfiguredValues, true);
  assert.equal(runs.expected.prunedCountDisclosed, runs.olderPruned);
  assert.equal(runs.expected.prunedCountIsLossyLowerBound, true);
  assert.equal(runs.expected.impliesComplete, false);
  const both = rc.get("both-sources-gapped-disclosed-independently");
  assert.equal(both.expected.collapsedIntoOneGlobalFlag, false);
});

test("active runs stay active, terminality reads from status, Unicode round-trips, unresolved != pruned", () => {
  const cc = byId("contentCases");
  assert.equal(cc.get("active-run-running-exported-as-active").expected.coercedToTerminal, false);
  assert.equal(cc.get("active-run-gated-exported-as-active").expected.coercedToTerminal, false);
  assert.equal(cc.get("terminality-read-from-status-not-finishedAt").expected.treatedTerminal, false);
  const uni = cc.get("unicode-content-preserved");
  assert.equal(uni.expected.roundTrips, uni.value, "the literal must survive verbatim, not a boolean");
  const art = cc.get("referenced-but-unresolved-artifact-disclosed-not-pruned");
  assert.equal(art.expected.labeled, "unresolved");
  assert.equal(art.expected.assertedPruned, false);
  assert.equal(art.expected.fabricated, false);
});

test("the export is consistent, byte-deterministic for an injected snapshot, and reconciles after filtering", () => {
  const cc = byId("consistencyCases");
  const tear = cc.get("concurrent-write-frozen-snapshot-counts-pinned");
  assert.equal(tear.expected.jsonRunCount, tear.snapshotRunCount);
  assert.equal(tear.expected.pdfRunCount, tear.snapshotRunCount, "JSON and PDF must agree on the frozen count");
  assert.equal(cc.get("audit-file-rotation-during-read-captured-atomically").expected.doubleCounts, false);
  const det = cc.get("deterministic-json-byte-identical-for-injected-snapshot");
  assert.equal(det.expected.byteIdentical, true);
  assert.equal(det.expected.generatedAtVerbatim, det.generatedAtInjected, "injected generatedAt flows verbatim");
  // Reconciliation ties JSON length to the in-RANGE snapshot count, not the raw source.
  const rec = cc.get("counts-reconcile-after-range-filter");
  for (const [section, len] of Object.entries(rec.expected.jsonSectionLengths)) {
    assert.equal(len, rec.inRange[section], `${section} length must equal the in-range count`);
    assert.ok(rec.source[section] >= len, `${section} raw source >= in-range (filtering removed some)`);
  }
  assert.equal(cc.get("empty-history-exports-valid-empty-sections").expected.envelopeStatus, "success");
  const prior = cc.get("prior-export-artifact-in-range-does-not-perturb-rerun");
  assert.equal(prior.expected.priorExportExcludedFromProjection, true);
  assert.equal(prior.expected.noAppendToAuditLog, true);
});

test("spend is integer minor-units and the three breakdowns reconcile to one total", () => {
  const s = byId("spendCases").get("spend-integer-minor-units-breakdowns-reconcile");
  assert.equal(s.expected.usesFloatDollars, false);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(s.perEngineMinorUnits), s.expected.totalMinorUnits);
  assert.equal(sum(s.perChainMinorUnits), s.expected.totalMinorUnits);
  assert.equal(sum(s.perDayMinorUnits), s.expected.totalMinorUnits);
  // Every value is an integer (no floats crept in).
  for (const o of [s.perEngineMinorUnits, s.perChainMinorUnits, s.perDayMinorUnits])
    for (const v of Object.values(o)) assert.ok(Number.isInteger(v), "minor-units must be integers");
});

test("large history bounds and paginates; span limit has an at-max/over-max boundary", () => {
  const sc = byId("sizeCases");
  const big = sc.get("large-history-paginates-not-fails");
  assert.equal(big.expected.fails, false);
  assert.equal(big.expected.pageCount, Math.ceil(big.sourceRunCount / big.maxRecordsPerExport));
  assert.equal(sc.get("span-at-max-accepted").requestedSpanDays, fixture.limits.maxSpanDays);
  assert.equal(sc.get("span-at-max-accepted").expected.accepted, true);
  assert.equal(sc.get("span-over-max-rejected").requestedSpanDays, fixture.limits.maxSpanDays + 1);
  assert.equal(sc.get("span-over-max-rejected").expected.errorCode, "EXPORT_TOO_LARGE");
});

test("every error code has a request/size case AND a concrete envelope", () => {
  const requestOrSizeCodes = new Set(
    [...fixture.requestCases, ...fixture.sizeCases].map((k) => k.expected.errorCode).filter(Boolean),
  );
  const envelopeCodes = new Set(fixture.envelopeCases.map((k) => k.code).filter(Boolean));
  for (const c of fixture.errorCodes) {
    assert.ok(requestOrSizeCodes.has(c), `code ${c} needs a request/size case`);
    assert.ok(envelopeCodes.has(c), `code ${c} needs a concrete envelope`);
  }
  // Every SOURCE_UNAVAILABLE variant covers a distinct source.
  const srcs = new Set(fixture.requestCases.filter((k) => k.unreadableSource).map((k) => k.unreadableSource));
  for (const s of ["auditLog", "runs", "board"]) assert.ok(srcs.has(s), `SOURCE_UNAVAILABLE must cover ${s}`);
});

test("the PDF carries every required section incl. a prominent retention disclosure, and downloads at 390px", () => {
  const pc = byId("pdfCases");
  const sec = pc.get("pdf-has-all-required-sections");
  assert.deepEqual(sec.expected.sections, fixture.pdfSections);
  assert.ok(sec.expected.sections.includes("artifacts"), "PDF must include artifacts");
  assert.ok(sec.expected.sections.includes("retentionDisclosure"));
  assert.equal(sec.expected.retentionProminent, true);
  assert.equal(pc.get("pdf-unicode-renders").expected.renders, true);
  const dl = pc.get("pdf-download-flow-390px");
  assert.equal(dl.viewportPx, 390);
  assert.equal(dl.expected.downloadCompletes, true);
});

test("the export is recorded as a system run with an export artifact, never a nonexistent kind or second store", () => {
  const e = byId("exportArtifactCases").get("export-recorded-as-system-run-with-export-artifact");
  assert.equal(e.expected.runKind, "system", "there is no 'export' run kind; use system + artifact");
  assert.equal(e.expected.artifactType, "export");
  assert.equal(e.expected.usesNonexistentExportKind, false);
  assert.equal(e.expected.count, 1);
  assert.equal(e.expected.createsSecondAuditStore, false);
  assert.equal(e.expected.observabilityWritesToAuditLog, false, "must not append to a source it re-reads");
});

test("every response envelope is deterministic and errors explain retry plus stop", () => {
  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status));
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200, `${k.id}`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts));
    if (env.status === "error") {
      assert.equal(env.error.code, k.code, `${k.id}: error.code must match the case code`);
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id} triplet`);
    }
  }
});

test("seeded credential never appears in any expected output", () => {
  const secret = fixture.seededSecret;
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
