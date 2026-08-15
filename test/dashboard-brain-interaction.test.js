import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const brain = read("components", "agenthost", "brain.tsx");
const map = read("components", "agenthost", "brain-map.tsx");
const memory = read("components", "agenthost", "brain-memory.tsx");
const model = read("lib", "brain-model.ts");
const commandCenter = read("components", "agenthost", "command-center.tsx");

test("Brain builds real core and agent lanes from memory records", () => {
  assert.match(model, /export function buildBrainLanes/);
  assert.match(model, /scope === "shared"/);
  assert.match(model, /agent/);
  assert.match(memory, /buildBrainLanes\(/);
  assert.match(memory, /Shared core/);
  assert.match(memory, /Memory lanes/);
  assert.match(model, /function svgColor/);
  assert.match(model, /!color\.startsWith\("var\("\)/);
});

test("an author lane contains every record counted in that author's lobe", () => {
  assert.match(model, /Shared memories intentionally appear in both views/);
  assert.match(memory, /records\.filter\(\(memory\) => memory\.ownerId === agent\.id\)/);
  assert.doesNotMatch(
    memory,
    /records\.filter\(\(memory\) => memory\.scope === "individual" && memory\.ownerId === agent\.id\)/,
  );
});

test("Brain lobes have visible keyboard controls that select the exact lane", () => {
  assert.match(map, /export function BrainMap/);
  assert.match(map, /tabIndex=\{0\}/);
  assert.match(map, /onSelectLane/);
  assert.match(memory, /Memory map lane shortcuts/);
  assert.match(memory, /<button[^>]+onClick=\{\(\) => focusLane/);
  assert.match(memory, /scrollIntoView/);
});

test("Brain memory nodes open an Obsidian-like detail view and stable route", () => {
  assert.match(model, /export function brainMemoryRoute/);
  assert.match(model, /brain\/memory/);
  assert.match(map, /onSelectMemory\(hit\.id\)/);
  assert.match(memory, /memory-detail-title/);
  assert.match(memory, /brainMemoryRoute/);
  assert.match(memory, /find\(\(memory\) => memory\.id === selectedMemoryId\)/);
  assert.match(memory, /if \(!selectedMemoryId \|\| selectedMemory \|\| loading \|\| problem \|\| unconfigured\) return/);
  assert.match(memory, /params\.delete\("memory"\)[\s\S]*?history\.replaceState/);
  assert.match(memory, /not in the current 200-record Brain window[\s\S]*?aged out[\s\S]*?removed/);
});

test("Brain remains usable on phones and applies reduced-motion behavior", () => {
  assert.match(map, /h-\[300px\]/);
  assert.match(map, /touch-pan-y/);
  assert.match(memory, /overflow-x-auto/);
  assert.match(brain, /overflow-y-auto/);
  assert.match(map, /prefers-reduced-motion/);
  assert.match(model, /memoryTitle\(memory: Memory, limit = 120\)/);
  assert.match(model, /title\.length > limit/);
  assert.match(commandCenter, /<BrainPanel/);
  assert.match(commandCenter, /agents=\{engineRoster\}/);
});
