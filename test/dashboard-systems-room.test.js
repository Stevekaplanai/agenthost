import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")

test("Systems keeps Mesh, Operations, Inventory, Loops, Multi-Loops, and Activity inside one truthful room", () => {
  const source = read("dashboard/components/agenthost/systems-view.tsx")
  for (const tab of ["Mesh", "Operations", "Inventory", "Loops", "Activity"]) {
    assert.match(source, new RegExp(`label:\\s*[\"']${tab}[\"']`))
  }
  assert.match(source, /<MeshPanel\b/)
  assert.match(source, /<Operator\b/)
  assert.match(source, /<InventoryExplorer\b/)
  assert.match(source, /<Loops\b/)
  assert.match(source, /<ActivityView\b/)
  assert.match(source, /multiJobs=\{multiLoops\.jobs\}/)
  assert.match(source, /problem=\{meshProblem\}/)
  assert.match(source, /className=\{cn\([\s\S]*?min-h-11/)
  assert.doesNotMatch(source, /Fixture:|Live probe not connected|configured · not probed|const TASKS|const AGENTS/)
})

test("Systems room does not add fake delivery controls or external navigation", () => {
  const source = read("dashboard/components/agenthost/systems-view.tsx")
  assert.doesNotMatch(source, /Preview delivery|window\.location|externalHref|href=["']\/(?:cron|kanban|cc)/)
  assert.match(source, /onDelete=\{loops\.remove\}/)
  assert.match(source, /onDeleteMulti=\{multiLoops\.remove\}/)
})

test("Mesh Refresh is a reachable phone control wired to the live mesh refetch", () => {
  const mesh = read("dashboard/components/agenthost/mesh.tsx")
  const systems = read("dashboard/components/agenthost/systems-view.tsx")
  const commandCenter = read("dashboard/components/agenthost/command-center.tsx")
  const live = read("dashboard/lib/live.ts")
  const useMeshStart = live.indexOf("export function useMesh()")
  assert.notEqual(useMeshStart, -1, "the live Mesh hook remains reachable")
  const useMesh = live.slice(useMeshStart)

  assert.match(useMesh, /const refetch = useCallback\(\(\) => \{\s*const generation = \+\+requestGeneration\.current\s*fetchMesh\(\)\.then\(/)
  assert.equal((useMesh.match(/if \(generation !== requestGeneration\.current\) return/g) ?? []).length, 2,
    "both Mesh success and failure ignore an older request that finishes late")
  assert.match(commandCenter, /const\s+\{\s*mesh:\s*meshData,\s*problem:\s*meshProblem,\s*refetch:\s*refetchMesh\s*\}\s*=\s*useMesh\(\)/)
  assert.match(commandCenter, /<SystemsView[\s\S]*?onRefreshMesh=\{refetchMesh\}/)
  assert.match(systems, /onRefreshMesh:\s*\(\)\s*=>\s*void/)
  assert.match(systems, /<MeshPanel\s+mesh=\{mesh\}\s+problem=\{meshProblem\}\s+onRefresh=\{onRefreshMesh\}\s*\/>/)
  assert.match(mesh, /export function MeshPanel\(\{\s*mesh,\s*problem,\s*onRefresh,?\s*\}/)
  assert.match(mesh, /<button[\s\S]*?onClick=\{onRefresh\}[\s\S]*?aria-label=["']Refresh["'][\s\S]*?min-h-11/)
})

test("Activity reads the bounded audit projection, names every state, and maps the legacy path without a redirect", () => {
  const view = read("dashboard/components/agenthost/activity-view.tsx")
  const api = read("dashboard/lib/api.ts")
  const live = read("dashboard/lib/live.ts")
  const navigation = read("dashboard/components/agenthost/navigation.ts")
  const commandCenter = read("dashboard/components/agenthost/command-center.tsx")

  assert.match(api, /export interface AuditData/)
  assert.match(api, /getJson\(`\/audit\/data\?limit=\$\{boundedLimit\}`\)/)
  assert.match(live, /export function useAudit\(/)
  assert.match(commandCenter, /useAudit\(nav === ["']activity["']\)/)
  assert.match(view, /Reading activity/)
  assert.match(view, /No activity has been recorded yet/)
  assert.match(view, /Activity could not be read/)
  assert.match(view, /event\.detail/)
  assert.match(view, /event\.eng/)
  assert.match(view, /event\.tid/)
  assert.match(view, /event\.ip/)
  assert.match(view, /min-h-11/)
  assert.match(view, /onRefresh/)
  assert.match(navigation, /key:\s*["']activity["'][\s\S]*route:\s*["']systems\/activity["']/)
  assert.match(commandCenter, /window\.location\.pathname\s*===\s*["']\/audit["']/)
  assert.doesNotMatch(commandCenter, /window\.location\.pathname\s*===\s*["']\/audit["'][\s\S]{0,240}(?:replaceState|location\.(?:assign|replace)|302)/)
})
