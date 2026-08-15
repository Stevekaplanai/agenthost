import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("a board card opens the one shared thread and confirms archive before acting", () => {
  const dialogs = read("dashboard/components/agenthost/dialogs.tsx")
  const command = read("dashboard/components/agenthost/command-center.tsx")

  assert.match(dialogs, /onDiscussTask: \(task: Task\) => void/)
  assert.match(dialogs, /verb === "chat"[\s\S]*onDiscussTask\(task\)/)
  assert.match(dialogs, /verb === "archive"[\s\S]*setExpanded/)
  assert.match(dialogs, /Archive this task\?/)
  assert.match(dialogs, /Nothing is archived until you confirm/)
  assert.match(dialogs, /runVerb\("archive"\)/)
  assert.match(command, /onDiscussTask=/)
  assert.doesNotMatch(command, /(?:href|location\.assign).*\/chat/)
})

test("closing dirty Settings requires an explicit discard decision", () => {
  const dialogs = read("dashboard/components/agenthost/dialogs.tsx")
  const settings = read("dashboard/components/agenthost/settings.tsx")

  assert.match(settings, /onDirtyChange\?: \(dirty: boolean\) => void/)
  assert.match(settings, /onDirtyChange\?\.\(changed\.length > 0\)/)
  assert.match(dialogs, /Discard unsaved settings changes\?/)
  assert.match(dialogs, /Keep editing/)
  assert.match(dialogs, /Discard changes/)
  const discardBody = dialogs.match(/function discardAndClose\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  assert.ok(discardBody, "Settings has no explicit discard-and-close path")
  assert.doesNotMatch(discardBody, /onSave\s*\(/, "Discarding settings sent a save")
})

test("mode changes are requested, named, and confirmed before the restart POST", () => {
  const command = read("dashboard/components/agenthost/command-center.tsx")

  assert.match(command, /pendingMode/)
  assert.match(command, /Switch to .* Mode\?/)
  assert.match(command, /restart the box/i)
  assert.match(command, /Nothing changes until you confirm/)
  assert.match(command, /Confirm and restart/)
  assert.match(command, /await postMode\(m\)/)
})

test("draft discard, paid provider tests, and settings resets use in-app consequence paths", () => {
  const createTask = read("dashboard/components/agenthost/create-task-modal.tsx")
  const settings = read("dashboard/components/agenthost/settings.tsx")

  assert.doesNotMatch(createTask, /window\.confirm/)
  assert.match(createTask, /Discard this task draft\?/)
  assert.match(createTask, /Keep editing/)
  assert.match(createTask, /Discard draft/)
  assert.match(createTask, /const submitInFlight = useRef\(false\)/)
  assert.match(createTask, /if \(!canSubmit \|\| submitInFlight\.current\) return[\s\S]*submitInFlight\.current = true/)
  assert.match(createTask, /finally \{[\s\S]*submitInFlight\.current = false/)
  assert.match(createTask, /function close\(\) \{[\s\S]*if \(submitInFlight\.current\) return/)

  assert.doesNotMatch(settings, /window\.confirm/)
  assert.match(settings, /Run a paid Moonshot connection test\?/)
  assert.match(settings, /Confirm and run test/)
  assert.match(settings, /Use defaults for/)
  assert.match(settings, /removes the saved overrides/i)
})
