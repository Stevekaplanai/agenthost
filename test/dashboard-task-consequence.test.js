import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = fs.readFileSync(path.join(ROOT, "dashboard/components/agenthost/dialogs.tsx"), "utf8")

test("resuming a board task names dispatch and spend before the existing action runs", () => {
  assert.match(source, /verb === "resume"[\s\S]{0,160}setExpanded/,
    "Resume must open a review surface instead of running immediately")
  assert.match(source, /queued work may dispatch/i)
  assert.match(source, /model spend may resume/i)

  const confirmation = source.match(/\{expanded === "resume"[\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(confirmation, "Resume consequence confirmation is missing")
  assert.match(confirmation, />\s*Cancel\s*</)
  assert.match(confirmation, /onClick=\{\(\) => runVerb\("resume"\)\}/,
    "only the confirmation may submit Resume")
  assert.match(source, /onClose=\{\(\) => \{ if \(!actionInFlight\.current\) onClose\(\) \}\}/,
    "the task dialog cannot close while a consequence request is still settling")
  assert.match(source, /disabled=\{Boolean\(busyVerb\)\}[\s\S]*onClick=\{\(\) => \{ if \(!actionInFlight\.current\) onClose\(\) \}\}/,
    "the footer Close control must use the same in-flight guard as Escape and the backdrop")
  assert.match(source, /role="alert"[\s\S]{0,160}\{actError\}/,
    "task action failures must be announced without closing the dialog")
})

test("approving a board task names the new work and spend before one locked action runs", () => {
  assert.match(source, /verb === "approve"[\s\S]{0,160}setExpanded/,
    "Approve must open a consequence review instead of running immediately")

  const confirmation = source.match(/\{expanded === "approve"[\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(confirmation, "Approve consequence confirmation is missing")
  assert.match(confirmation, /agent work may dispatch/i)
  assert.match(confirmation, /model spend may resume/i)
  assert.match(confirmation, /fresh review and fix allowance/i)
  assert.match(confirmation, />\s*Cancel\s*</)
  assert.match(confirmation, /onClick=\{\(\) => runVerb\("approve"\)\}/,
    "only the consequence confirmation may submit Approve")

  assert.match(source, /const actionInFlight = useRef\(false\)/)
  assert.match(source, /if \(!task \|\| actionInFlight\.current\) return/)
  assert.match(source, /actionInFlight\.current = true/)
  assert.match(source, /finally \{[\s\S]{0,120}actionInFlight\.current = false/,
    "the synchronous lock must always release after the action settles")
})

test("blocking a board task stages the intentional stop before one locked action", () => {
  assert.match(source, /verb === "block"[\s\S]{0,160}setExpanded/,
    "Block must open a consequence review instead of running immediately")
  const confirmation = source.match(/\{expanded === "block"[\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(confirmation, "Block consequence confirmation is missing")
  assert.match(confirmation, /intentionally stops scheduler work/i)
  assert.match(confirmation, /No agent may dispatch/i)
  assert.match(confirmation, />\s*Cancel\s*</)
  assert.match(confirmation, /onClick=\{\(\) => runVerb\("block"\)\}/)
})

test("send back and reassign require a cancelable spend review before one locked action", () => {
  const sendBack = source.match(/\{expanded === "send_back"[\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(sendBack, "Send back review is missing")
  assert.match(sendBack, /agent work may dispatch/i)
  assert.match(sendBack, /model spend may resume/i)
  assert.match(sendBack, />\s*Cancel\s*</)
  assert.match(sendBack, /Confirm send back/)
  assert.match(sendBack, /onClick=\{\(\) => runVerb\("send_back", \{ note: sendBackReason\.trim\(\) \}\)\}/)

  assert.match(source, /const \[assignTarget, setAssignTarget\] = useState<AgentId \| null>\(null\)/)
  assert.doesNotMatch(source, /onClick=\{\(\) => runVerb\("assign", \{ engine: a\.id \}\)\}/,
    "choosing an engine must not mutate the task")
  assert.match(source, /onClick=\{\(\) => setAssignTarget\(a\.id\)\}/)
  const assign = source.match(/\{assignTarget && \([\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(assign, "Reassign consequence review is missing")
  assert.match(assign, /agent work may dispatch/i)
  assert.match(assign, /model spend may resume/i)
  assert.match(assign, />\s*Cancel\s*</)
  assert.match(assign, /Confirm reassign/)
  assert.match(assign, /runVerb\("assign", \{ engine: assignTarget \}\)/)
})
