import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("gate lib-mode still boots when the optional Kanban bridge module is absent", () => {
  const gate = path.resolve("container", "gate.js");
  const script = String.raw`
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "./kanban-bridge.js" && parent && parent.filename.endsWith("gate.js")) {
        const error = new Error("simulated optional module absence");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }
      return original.call(this, request, parent, isMain);
    };
    require(process.argv[1]);
    process.stdout.write("booted");
  `;
  const run = spawnSync(process.execPath, ["-e", script, gate], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "booted");
});
