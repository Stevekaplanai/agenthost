import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "dashboard/lib/live.ts"), "utf8")

test("the generated roster maps every observed gate engine state truthfully", () => {
  const body = source.match(/const ENGINE_STATUS_MAP:[^{]+\{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body, "ENGINE_STATUS_MAP was not found")
  const entries = Object.fromEntries(
    [...body.matchAll(/^\s*([a-z_]+):\s*"([a-z]+)",?$/gm)].map((match) => [match[1], match[2]]),
  )

  assert.equal(entries.working, "running")
  assert.equal(entries.not_installed, "offline")
  assert.equal(entries.not_configured, "offline")
  assert.equal(entries.restarting, "awaiting")
  assert.match(source, /const detail = typeof eng\?\.summary === "string"[\s\S]*?eng\.summary/)
  assert.doesNotMatch(source, /ENGINE_STATUS_MAP\[rawStatus\] \|\| \(eng\.installed === false \? "offline" : "online"\)/)
})
