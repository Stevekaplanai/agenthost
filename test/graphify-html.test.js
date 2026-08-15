import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderGraphifyHtml, safeGraph } = require("../container/graphify-html.js");

test("Graphify HTML is self-contained, interactive, stamped, and honest about confidence", () => {
  const html = renderGraphifyHtml({
    title: "Harness graph",
    targetLabel: "Agent harness",
    folderLabel: "All harness",
    snapshot: { kind: "folder", value: "2026-08-14T12:00:00.000Z", manifestSha256: "a".repeat(64) },
    graph: {
      nodes: [
        { id: "a", label: "Skill <one>", community: 1, source_file: "skills/one/SKILL.md" },
        { id: "b", label: "Plugin", community: 1 },
      ],
      links: [
        { source: "a", target: "b", relation: "uses", confidence: "EXTRACTED" },
        { source: "b", target: "a", relation: "suggests", confidence: "INFERRED" },
        { source: "a", target: "a", relation: "maybe", confidence: "other" },
      ],
    },
  });

  assert.match(html, /Interactive relationship graph/);
  assert.match(html, /EXTRACTED[\s\S]*INFERRED[\s\S]*AMBIGUOUS/);
  assert.match(html, /Folder mtime: 2026-08-14T12:00:00\.000Z/);
  assert.match(html, /derived snapshot; source wins/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /pointerdown/);
  assert.match(html, / Skill \\u003cone\\u003e|Skill \\u003cone\\u003e/);
  assert.doesNotMatch(html, /<script\s+[^>]*src=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*href=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /unpkg|vis-network/i);
});

test("unknown confidence fails visibly to AMBIGUOUS", () => {
  const graph = safeGraph({
    nodes: [{ id: "a" }, { id: "b" }],
    links: [{ source: "a", target: "b", confidence: "certain" }],
  });
  assert.equal(graph.links[0].confidence, "AMBIGUOUS");
});
