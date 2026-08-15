import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")

test("Resume explains dispatch and spend before one guarded autonomy request", () => {
  const source = read("dashboard/components/agenthost/operator.tsx")

  assert.match(source, /queued cards may dispatch/i)
  assert.match(source, /agent\/model spend can resume/i)
  assert.match(source, /const \[confirmResume, setConfirmResume\] = useState\(false\)/)
  assert.match(source, /const autonomyRequestInFlight = useRef\(false\)/)
  assert.match(source, /if \(autonomyRequestInFlight\.current\) return/)
  assert.match(source, /autonomyRequestInFlight\.current = true[\s\S]*await postAutonomy\(on\)[\s\S]*autonomyRequestInFlight\.current = false/)
  assert.equal((source.match(/await postAutonomy\(/g) ?? []).length, 1)

  const cancel = source.match(/onClick=\{\(\) => setConfirmResume\(false\)\}[\s\S]{0,180}>\s*Cancel\s*</)?.[0] ?? ""
  assert.ok(cancel, "Resume confirmation needs an in-app Cancel action")
  assert.doesNotMatch(cancel, /postAutonomy|changeAutonomy/)
  assert.match(source, /autonomyOn === false \? \(\) => setConfirmResume\(true\) : \(\) => changeAutonomy\(false\)/,
    "Resume must open confirmation while Pause remains a direct, reversible action")
  assert.match(source, /onClick=\{\(\) => changeAutonomy\(true\)\}/,
    "only Resume confirmation may submit the enabling request")
})

test("Multi-Loop deletion names every deleted asset", () => {
  const source = read("dashboard/components/agenthost/multi-loops.tsx")
  assert.match(source, /deletes? the schedule, (?:any|the) queued run, and (?:its|the) run-history directory/i)
  assert.match(source, /min-h-11 rounded-md border border-line[\s\S]*History/,
    "History must have a 44px phone target")
  assert.match(source, /inline-flex min-h-11 items-center[\s\S]*Delete/,
    "the first Delete control must have a 44px phone target")
})

test("scheduling recurring Loops and Multi-Loops requires one explicit consequence confirmation", () => {
  const loops = read("dashboard/components/agenthost/loops.tsx")
  const multi = read("dashboard/components/agenthost/multi-loops.tsx")

  for (const [label, source] of [["Loop", loops], ["Multi-Loop", multi]]) {
    assert.match(source, /recurring model spend/i, `${label} confirmation must name recurring spend`)
    assert.match(source, /requestInFlight\.current/, `${label} confirmation needs a double-submit lock`)
    assert.match(source, /if \(requestInFlight\.current\) return/, `${label} confirmation must refuse a second write`)
    assert.match(source, /Cancel/, `${label} confirmation needs a zero-write Cancel action`)
    assert.match(source, /Confirm schedule/, `${label} confirmation needs an explicit commit action`)
  }

  assert.equal((loops.match(/await onCreate\(/g) ?? []).length, 1)
  assert.equal((multi.match(/await onCreate\(/g) ?? []).length, 1)
  assert.match(multi, /\{formError && <p[^>]*role="alert"[^>]*>Not scheduled/,
    "Multi-Loop scheduling failures must be announced inside the open modal")
})

test("inventory reports clipboard truth only after the browser settles", () => {
  const source = read("dashboard/components/agenthost/inventory.tsx")
  const copy = source.slice(source.indexOf("async function copy"), source.indexOf("\n\n  return (", source.indexOf("async function copy")))

  assert.match(copy, /await navigator\.clipboard\.writeText\(name\)/)
  assert.ok(copy.indexOf("await navigator.clipboard.writeText(name)") < copy.indexOf("setCopied(name)"),
    "Copied state must follow the resolved clipboard write")
  assert.match(copy, /e instanceof Error \? e\.message : String\(e\)/,
    "clipboard rejection must preserve the browser's actual cause")
  assert.match(copy, /content remains visible/i,
    "failed copy must tell the operator the source content was retained")
  assert.doesNotMatch(copy, /\.catch\(\(\) => \{\}\)/,
    "clipboard failures must never be swallowed")
})
