import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("the dashboard posts one exact single-Loop run approval and preserves the gate's failure cause", () => {
  const api = read("dashboard/lib/api.ts")
  const loops = read("dashboard/components/agenthost/loops.tsx")

  assert.match(api, /approveCronRun\(runId: string, fingerprint: string\)/)
  assert.match(api, /\/cron\/runs\/\$\{encodeURIComponent\(runId\)\}\/approve/)
  assert.match(api, /decision:\s*["']approve_once["']/)
  assert.match(api, /fingerprint/)

  assert.match(loops, /status\?:\s*["']gated["']/)
  assert.match(loops, /approvalFingerprint\?:\s*string/)
  assert.match(loops, /approvalPending\?:\s*boolean/)
  assert.match(loops, /Approve this Loop run once\?/)
  assert.match(loops, /only this exact scheduled run/i)
  assert.match(loops, /rechecks[\s\S]*before any agent starts/i)
  assert.match(loops, /Approve once/)
  assert.match(loops, /min-h-11/, "the phone approval control needs a 44px touch target")
  assert.match(loops, /onClose=\{\(\) => \{ if \(!approving\) cancelApproval\(\) \}\}/,
    "Escape and backdrop cannot hide an approval write while it settles")
  assert.match(loops, /role=["']alert["'][\s\S]*approvalError/,
    "an approval failure must announce the gate's real cause")
  assert.match(loops, /r\.approvalPending[\s\S]*approvedRuns\.get\(r\.runId\) === runs/,
    "a fresh server snapshot must replace the optimistic approval overlay after expiry or mismatch")
  assert.doesNotMatch(loops, /window\.confirm/, "the consequence decision stays inside the product")
})

test("cancel is a zero-request path and confirm is locked to one in-flight approval", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  const confirmBody = loops.match(/async function confirmApproval\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  assert.ok(confirmBody, "the exact-run approval has no confirm handler")
  assert.match(confirmBody, /approvalRequestInFlight\.current/)
  assert.match(confirmBody, /await approveCronRun/)
  assert.match(confirmBody, /setPendingApproval\(null\)/)

  const cancel = loops.match(/function cancelApproval\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  assert.ok(cancel, "the approval modal has no explicit cancel path")
  assert.match(cancel, /setPendingApproval\(null\)/)
  assert.doesNotMatch(cancel, /approveCronRun|fetch\(|onCreate|onDelete/,
    "cancelling an approval must make zero requests")
})

test("both asynchronous Loop modal failures are announced", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  assert.match(loops, /role=["']alert["'][^>]*>[\s\S]{0,220}Not scheduled/,
    "the schedule modal must announce a failed create")
  assert.match(loops, /role=["']alert["'][^>]*>[\s\S]{0,220}approvalError/,
    "the approval modal must announce a failed exact-run grant")
})

test("Loop form labels do not create invalid nested paragraphs during hydration", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  assert.doesNotMatch(loops, /<p[^>]*>\s*<MonoLabel/,
    "MonoLabel already renders a paragraph and cannot sit inside another paragraph")
  assert.doesNotMatch(loops, /<label[^>]*>\s*<MonoLabel/,
    "MonoLabel's paragraph is not valid phrasing content inside a label")
})

test("single-Loop creation is named, keyboard-submittable, and phone-sized", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  assert.match(loops, /<form[\s\S]{0,180}onSubmit=/,
    "the creation controls must be a real form so Enter can open the consequence gate")
  for (const name of ["Loop name", "Local time", "Loop prompt"]) {
    assert.match(loops, new RegExp(`aria-label=["']${name}["']`), `${name} needs a programmatic name`)
  }
  assert.match(loops, /type="submit"[\s\S]{0,500}add loop/i,
    "the Add Loop action must be the form submitter")
  assert.match(loops, /aria-label="Loop name"[\s\S]{0,220}min-h-11/,
    "the name field needs a 44px phone target")
  assert.match(loops, /aria-label="Local time"[\s\S]{0,220}min-h-11/,
    "the time field needs a 44px phone target")
})

test("single-Loop deletion names the full consequence and cannot double-submit", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  assert.match(loops, /schedule, any queued run, and (?:its )?run history/i)
  assert.match(loops, /deleteRequestInFlight\.current/,
    "the destructive request needs a synchronous same-tick lock")
  assert.match(loops, /async function removeLoop[\s\S]*?try \{[\s\S]*?await onDelete[\s\S]*?finally \{[\s\S]*?deleteRequestInFlight\.current = null/)
  assert.match(loops, /disabled=\{deleting === j\.id\}[\s\S]{0,500}>\s*Keep\s*</,
    "Keep cannot hide an in-flight deletion")
})
