import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTINUITY_DIR = path.join(ROOT, "docs", "continuity");
const DOCS = [
  path.join(ROOT, "docs", "CONTINUITY-EXECUTION-PLAN.md"),
  path.join(ROOT, "docs", "CONTINUITY-ROADMAP.md"),
  ...fs.readdirSync(CONTINUITY_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(CONTINUITY_DIR, name)),
];

test("Continuity JSON examples are valid", () => {
  let examples = 0;

  for (const file of DOCS) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const match of markdown.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)) {
      examples += 1;
      assert.doesNotThrow(
        () => JSON.parse(match[1]),
        `${path.relative(ROOT, file)} contains invalid JSON`,
      );
    }
  }

  assert.ok(examples > 0, "expected at least one Continuity JSON example");
});

test("Continuity local Markdown links resolve", () => {
  for (const file of DOCS) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].replace(/^<|>$/g, "");
      const target = rawTarget.split("#", 1)[0];
      if (
        !target ||
        target.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }

      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      assert.ok(
        fs.existsSync(resolved),
        `${path.relative(ROOT, file)} links to missing ${target}`,
      );
    }
  }
});
