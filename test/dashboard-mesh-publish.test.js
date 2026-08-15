import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")

test("Mesh publish uses the cookie-authenticated operator endpoint and returns its durable receipt", () => {
  const api = read("dashboard/lib/api.ts")

  assert.match(api, /export interface MeshPublishReceipt/)
  assert.match(api, /export function publishMeshMessage\(messageId: string, text: string\)/)
  assert.match(api, /postJson<MeshPublishReceipt>\("\/cc\/mesh\/message", \{ messageId, text \}\)/)
})

test("Mesh publish is an honest all-peer shared-thread consequence with cancel-zero and confirm-once behavior", () => {
  const source = read("dashboard/components/agenthost/mesh.tsx")

  assert.match(source, /Publish to mesh/)
  assert.match(source, /All configured peers/)
  assert.match(source, /mesh\.peers\.map\(\(peer\) => peer\.boxId\)/,
    "the consequence must name observed peer ids instead of a fixture count")
  assert.match(source, /durable shared team thread/i)
  assert.match(source, /next authenticated pull/i)
  assert.match(source, /not (?:a )?private or instant/i)
  assert.doesNotMatch(source, /Preview delivery|window\.confirm/)
  assert.match(source, /Reading mesh state/,
    "a missing snapshot must not render as Mesh live")
  assert.match(source, /problem \? "Mesh unavailable"/,
    "a failed refresh must outrank a retained LIVE snapshot")
  assert.match(source, /const canPublish = Boolean\(mesh && live && !problem/,
    "a stale or unavailable snapshot must not enable an outward publish")
  assert.match(source, /mesh && !problem \? mesh\.peers\.map/,
    "stale peer IDs must not be presented as a current recipient list")
  assert.match(source, /if \(problem \|\| !mesh \|\| !live\)[\s\S]*setPublishProblem/,
    "a refresh failure while confirmation is open must stop locally with a visible cause")
  assert.doesNotMatch(source, /StatusDot[\s\S]{0,120}(?:online|offline)|const alive =/,
    "a historical receipt must not be presented as current peer liveness")
  assert.match(source, /<Modal[\s\S]*open=\{confirming\}[\s\S]*onClose=\{cancelPublish\}/,
    "the confirmation must use the shared focus-trapped, Escape-aware modal")

  assert.match(source, /const publishInFlight = useRef\(false\)/)
  assert.match(source, /if \(publishInFlight\.current\) return/)
  assert.match(source, /publishInFlight\.current = true[\s\S]*await publishMeshMessage\([\s\S]*publishInFlight\.current = false/)
  assert.equal((source.match(/await publishMeshMessage\(/g) ?? []).length, 1,
    "only the confirmed path may call the publish endpoint")

  const cancel = source.match(/onClick=\{cancelPublish\}[\s\S]{0,180}>\s*Cancel\s*</)?.[0] ?? ""
  assert.ok(cancel, "the in-app consequence dialog needs a Cancel action")
  assert.doesNotMatch(cancel, /publishMeshMessage/,
    "Cancel must close the dialog without publishing")
  assert.match(source, /e instanceof Error \? e\.message : String\(e\)/,
    "publish failures must surface the endpoint or network cause")
  assert.match(source, /setPublishProblem\(`Message was not published — \$\{cause\}`\)/)
  assert.match(source, /publishProblem && \([\s\S]*role="alert"[\s\S]*\{publishProblem\}/,
    "the failure cause must remain visible inside the open confirmation for a safe retry")
  assert.match(source, /setDraft\(""\)[\s\S]*messageId\.current = null[\s\S]*setConfirming\(false\)/,
    "only success clears the draft and stable id")
})
