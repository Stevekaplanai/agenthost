import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DASHBOARD = path.join(ROOT, "dashboard")
const source = fs.readFileSync(path.join(DASHBOARD, "components", "agenthost", "brain.tsx"), "utf8")
const dashboardRequire = createRequire(path.join(DASHBOARD, "package.json"))
const typescript = dashboardRequire("typescript")

function loadBrainModule() {
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  const component = () => null
  const runtime = {
    react: dashboardRequire("react"),
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "lucide-react": new Proxy({}, { get: () => component }),
    "@/lib/api": { createMemory: async () => ({}), ingestFile: async () => ({ route: "text" }) },
    "./ai-assist": { AiAssist: component },
    "./brain-memory": { BrainMemoryView: component },
    // Brain mounts the shared Graphify panel so the brain corpus can be
    // regenerated without leaving for Artifacts. Stubbed here because this
    // suite is about file-ingest consequences, not graph generation.
    "./graphify-panel": { GraphifyPanel: component },
    "./primitives": { Modal: component, MonoLabel: component },
  }
  const localRequire = (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id)
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, localRequire)
  return loaded.exports
}

test("the staged-file review names what will be durably remembered for each supported media kind", () => {
  const { fileIngestConsequence } = loadBrainModule()
  assert.equal(typeof fileIngestConsequence, "function")

  const cases = [
    [{ name: "launch.pdf", type: "application/pdf" }, /launch\.pdf.*read.*extracted text.*durable memory/i],
    [{ name: "screen.png", type: "image/png" }, /screen\.png.*described.*description.*durable memory/i],
    [{ name: "briefing.mp3", type: "audio/mpeg" }, /briefing\.mp3.*transcribed.*transcript.*durable memory/i],
    [{ name: "voice.md", type: "text/markdown" }, /voice\.md.*read.*text.*durable memory/i],
  ]

  for (const [file, expected] of cases) assert.match(fileIngestConsequence(file), expected)
  assert.match(
    fileIngestConsequence({ name: "spoofed.pdf", type: "image/png" }),
    /read.*extracted text/i,
    "the same filename-first routing as the backend must win over a vague or spoofed MIME type",
  )
  assert.match(
    fileIngestConsequence({ name: "contract.docx", type: "application/octet-stream" }),
    /validated.*if supported.*otherwise nothing.*reason.*open/i,
    "an unsupported file must not promise processing that the backend can only refuse",
  )
})

test("file selection stages only, Cancel sends zero writes, and Confirm owns one synchronous write", () => {
  const stageBody = source.match(/function stageFile\(file: File\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  const cancelBody = source.match(/function cancelFileIngest\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  const confirmBody = source.match(/async function confirmFileIngest\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""

  assert.ok(stageBody, "file selection has no staging-only path")
  assert.match(stageBody, /setPendingFile\(file\)/)
  assert.doesNotMatch(stageBody, /ingestFile\s*\(/, "choosing a file persisted it before confirmation")
  assert.match(source, /onChange=\{\(event\) => \{[\s\S]{0,180}stageFile\(file\)/)

  assert.ok(cancelBody, "the file review has no explicit Cancel path")
  assert.match(cancelBody, /setPendingFile\(null\)/)
  assert.doesNotMatch(cancelBody, /ingestFile\s*\(/, "Cancel persisted the staged file")

  assert.ok(confirmBody, "the file review has no explicit Confirm path")
  assert.match(confirmBody, /if \(!file \|\| writeInFlight\.current\) return/)
  assert.ok(
    confirmBody.indexOf("writeInFlight.current = true") < confirmBody.indexOf("await ingestFile(file)"),
    "Confirm must take its synchronous one-shot lock before the request",
  )
  assert.equal((confirmBody.match(/await ingestFile\(file\)/g) ?? []).length, 1)
  assert.equal((source.match(/await ingestFile\(file\)/g) ?? []).length, 1, "only Confirm may call the ingest API")
})

test("the chooser and staging path reject unsupported files before any review or request", () => {
  const { fileIngestProblem } = loadBrainModule()
  assert.equal(typeof fileIngestProblem, "function")
  for (const file of [
    { name: "notes.md", type: "application/octet-stream" },
    { name: "deck.pdf", type: "application/pdf" },
    { name: "photo.bin", type: "image/png" },
    { name: "recording.bin", type: "audio/wav" },
  ]) {
    assert.equal(fileIngestProblem(file), null, `${file.name} should match the live gate's supported types`)
  }
  assert.match(fileIngestProblem({ name: "contract.docx", type: "application/octet-stream" }), /cannot read \.docx yet.*text, markdown, subtitles, PDF, images and audio/i)
  assert.match(fileIngestProblem({ name: "demo.mp4", type: "video/mp4" }), /video is not ingested yet/i)

  assert.match(source, /accept="\.txt,\.md,\.markdown,\.srt,\.vtt,\.pdf,image\/\*,audio\/\*"/,
    "the visible picker must advertise exactly what the live gate accepts")
  const stageBody = source.match(/function stageFile\(file: File\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
  assert.match(stageBody, /const unsupported = fileIngestProblem\(file\)/)
  assert.ok(stageBody.indexOf("if (unsupported)") < stageBody.indexOf("setPendingFile(file)"),
    "an unsupported programmatic selection must be refused before a review opens")
  assert.match(stageBody, /if \(unsupported\) \{[\s\S]*?setPendingFile\(null\)[\s\S]*?setProblem\(unsupported\)[\s\S]*?return/)
  assert.doesNotMatch(stageBody, /ingestFile\s*\(/, "unsupported selection cannot send a request")
})

test("the open review cannot be dismissed mid-request and keeps the backend cause visible on failure", () => {
  const review = source.match(/\{pendingFile && \([\s\S]*?\n\s*\)\}/)?.[0] ?? ""
  assert.ok(review, "the selected file has no visible in-app consequence review")
  assert.match(review, /fileIngestConsequence\(pendingFile\)/)
  assert.match(review, />\s*Cancel\s*</)
  assert.match(review, /Confirm file/)
  assert.match(review, /disabled=\{busy\}/g)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, "a file name must render as text, never injected markup")

  assert.match(source, /function close\(\) \{[\s\S]*?if \(writeInFlight\.current\) return[\s\S]*?if \(dirty\)[\s\S]*?setDiscardOpen\(true\)[\s\S]*?onClose\(\)/)
  assert.match(source, /onClose=\{close\}/, "Escape, backdrop, and the X must share the in-flight lock")
  assert.match(source, /title="Discard this memory draft\?"[\s\S]*?Keep editing[\s\S]*?Discard draft/)
  assert.match(source, /catch \(error: unknown\) \{[\s\S]{0,160}setProblem\(error instanceof Error \? error\.message : String\(error\)\)/)
  assert.match(source, /pendingFile && \([\s\S]*?role="alert"|role="alert"[\s\S]*?pendingFile && \(/)
  assert.match(source, /disabled=\{busy \|\| Boolean\(pendingFile\)\}/,
    "the separate text-memory save must not bypass an open file review")
})

// The Brain canvas already paints real relationships and their EXTRACTED /
// INFERRED / AMBIGUOUS confidence -- what was missing was any way to REGENERATE
// the snapshot those edges come from without leaving for Artifacts.
// Steve, 2026-08-14: "the brain is not visual the way that graphify is visual."
test("Brain can regenerate its own graph and repaint with the new edges", () => {
  const brain = source;
  assert.match(brain, /<GraphifyPanel[^>]*onGenerated=\{onGraphGenerated\}/,
    "Brain mounts no Graphify panel, or mounts one that cannot report completion");

  // Without the refetch the canvas would keep painting the PREVIOUS snapshot
  // after a successful generate -- a graph that looks live and is stale, which
  // is worse than no graph.
  const shell = fs.readFileSync(path.join(DASHBOARD, "components", "agenthost", "command-center.tsx"), "utf8");
  assert.match(shell, /onGraphGenerated=\{refreshBrainGraph\}/,
    "a regenerated brain graph never refetches, so the canvas keeps the old edges");
});
