import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const KEY = "board-relations-test-key";

async function boot(t, relationMode) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-board-relations-"));
  const capture = path.join(home, "relation-calls.jsonl");
  const preload = path.join(home, "board-relations-preload.cjs");
  fs.writeFileSync(preload, `
const cp = require("node:child_process");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const originalSpawn = cp.spawn;
const capture = process.env.RELATION_CAPTURE;
const tasks = [
  { id: "t_goal", title: "Increase qualified pipeline", status: "ready" },
  { id: "t_kr", title: "Ship landing page", status: "done" },
  { id: "t_loose", title: "Unlinked work", status: "ready" },
];
function childWithStreams() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}
cp.spawn = function(command, args, options) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv[0] === "kanban" && argv[1] === "list" && argv[2] === "--json") {
    const child = childWithStreams();
    process.nextTick(() => child.stdout.end(JSON.stringify(tasks), () => child.emit("close", 0)));
    return child;
  }
  if (String(command) === "python3" && argv.join("\\n").includes("task_links")) {
    const child = childWithStreams();
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk.toString(); });
    child.stdin.on("end", () => {
      fs.appendFileSync(capture, JSON.stringify({ command, argv, input }) + "\\n");
      if (process.env.RELATION_MODE === "fail") {
        child.stderr.end("sqlite3.OperationalError: no such table: task_links");
        child.stdout.end("", () => child.emit("close", 1));
        return;
      }
      const rows = [
        ["t_goal", "t_kr"],
        ["t_goal", "t_kr"],
        ["t_goal", "t_hidden"],
        ["not_visible", "t_kr"],
      ];
      child.stdout.end(JSON.stringify({ ok: true, rows }), () => child.emit("close", 0));
    });
    return child;
  }
  return originalSpawn.apply(this, arguments);
};
`);
  const gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      RELATION_CAPTURE: capture,
      RELATION_MODE: relationMode,
      NODE_OPTIONS: [process.env.NODE_OPTIONS || "", `--require=${preload}`].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 15_000);
    gate.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    gate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    gate.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
  const { cookie } = await mintOperatorSession(base, KEY);
  t.after(async () => {
    await stopChild(gate);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { base, cookie, capture };
}

test("GET /board returns one bulk, visible-only Hermes relation snapshot", async (t) => {
  const box = await boot(t, "ok");
  const response = await fetch(box.base + "/board", { headers: { cookie: box.cookie } });
  assert.equal(response.status, 200);
  const board = await response.json();
  assert.deepEqual(board.relations, {
    available: true,
    byTask: {
      t_goal: { parents: [], children: ["t_kr"] },
      t_kr: { parents: ["t_goal"], children: [] },
      t_loose: { parents: [], children: [] },
    },
  });
  const calls = fs.readFileSync(box.capture, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.length, 1, "one SQLite read supplies the whole board");
  assert.deepEqual(JSON.parse(calls[0].input).sort(), ["t_goal", "t_kr", "t_loose"]);
});

test("a relation query failure names its cause without taking the board down", async (t) => {
  const box = await boot(t, "fail");
  const response = await fetch(box.base + "/board", { headers: { cookie: box.cookie } });
  assert.equal(response.status, 200);
  const board = await response.json();
  assert.equal(board.available, true);
  assert.equal(board.tasks.length, 3);
  assert.equal(board.relations.available, false);
  assert.deepEqual(board.relations.byTask, {});
  assert.match(board.relations.problem, /no such table: task_links/i);
  assert.doesNotMatch(board.relations.problem, /[A-Z]:\\|\/data\/home|\.hermes[\\/]kanban\.db/i);
});
