// A tapped notification must land in the app the operator actually uses.
//
// Steve, 2026-08-03: "Deep linking was supposed to have been built. It would
// need to be linked to the new board anyway." It HAD been built — sw.js has
// handled notificationclick and read data.url since before the rebuild — but
// every push pointed at /kanban#<id>, the legacy board. So the feature worked
// perfectly and delivered him somewhere else, which is the hardest kind of
// broken to notice: nothing errors, the wrong page just opens.
//
// Second defect these lock down: the gate sent `task` while sw.js read
// `taskId`, so the service worker's id fallback could never fire. It only
// looked correct because data.url happened to carry the id too.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "container", f), "utf8");
const gate = read("gate.js");
const sw = read("sw.js");
const contract = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "frontend-collapse-contract-v1.json"), "utf8"));

async function notificationClickTarget(url) {
  let click;
  let opened = null;
  const self = {
    location: { origin: "https://agenthost.test" },
    registration: { showNotification() { return Promise.resolve(); } },
    clients: {
      matchAll() { return Promise.resolve([]); },
      openWindow(target) { opened = target; return Promise.resolve(); },
    },
    addEventListener(type, handler) { if (type === "notificationclick") click = handler; },
  };
  vm.runInNewContext(sw, { self, URL, Promise, encodeURIComponent });
  let completion;
  click({
    notification: { data: { url }, close() {} },
    waitUntil(promise) { completion = promise; },
  });
  await completion;
  return opened;
}

async function activationReceipt() {
  const handlers = {};
  let skipped = 0;
  let claimed = 0;
  const self = {
    location: { origin: "https://agenthost.test" },
    registration: { showNotification() { return Promise.resolve(); } },
    skipWaiting() { skipped += 1; return Promise.resolve(); },
    clients: {
      claim() { claimed += 1; return Promise.resolve(); },
      matchAll() { return Promise.resolve([]); },
      openWindow() { return Promise.resolve(); },
    },
    addEventListener(type, handler) { handlers[type] = handler; },
  };
  vm.runInNewContext(sw, { self, URL, Promise, encodeURIComponent });
  for (const type of ["install", "activate"]) {
    let completion;
    handlers[type]({ waitUntil(promise) { completion = promise; } });
    await completion;
  }
  return { skipped, claimed };
}

function pushCallFor(family) {
  const contextAt = family.contextMarker ? gate.indexOf(family.contextMarker) : 0;
  assert.notEqual(contextAt, -1, `${family.id} context marker is missing`);
  const callAt = gate.indexOf(family.sourceMarker, contextAt);
  assert.notEqual(callAt, -1, `${family.id} push call is missing`);
  const openAt = gate.indexOf("(", callAt);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = openAt; i < gate.length; i += 1) {
    const char = gate[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return gate.slice(callAt, i + 1);
  }
  assert.fail(`${family.id} push call is not balanced`);
}

test("no push deep-links to the legacy board", () => {
  const legacy = [...gate.matchAll(/url:\s*"\/kanban[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(
    legacy,
    [],
    "these pushes still open the legacy board: " + legacy.join(", ") +
      ". A tapped notification must land on the generated shell (/?task=<id>).",
  );
});

test("every push that names a task carries a deep link to it", () => {
  // Each payload carrying a task id must also carry a url. A push that says
  // "approval needed" and drops him on the home screen to go find it is the
  // same defect in a smaller coat.
  const payloads = [...gate.matchAll(/\{\s*task:\s*String\([^)]+\)[^}]*\}/g)].map((m) => m[0]);
  assert.ok(payloads.length > 0, "no task-carrying push payloads found — did the shape change?");
  for (const p of payloads) {
    assert.match(p, /url:\s*"\/\?task="/, `this push names a task but has no deep link to it: ${p}`);
    assert.match(
      p,
      /taskId:/,
      "sw.js reads data.taskId for its fallback; a payload with only `task` leaves that path dead: " + p,
    );
  }
});

test("every classified task-family push carries both task ids and its encoded board URL", () => {
  const taskFamilies = [
    ...contract.pushEntry.linkedTaskFamilies,
    ...contract.pushEntry.contextualFamilies.filter((family) => family.context === "task"),
  ];
  assert.equal(taskFamilies.length, 14, "the task push inventory changed without updating this regression");
  for (const family of taskFamilies) {
    const call = pushCallFor(family);
    assert.match(call, /\btask:\s*String\(/, `${family.id} does not carry data.task`);
    assert.match(call, /\btaskId:\s*String\(/, `${family.id} does not carry data.taskId`);
    assert.match(
      call,
      /\burl:\s*"\/\?task="\s*\+\s*encodeURIComponent\(String\(/,
      `${family.id} does not deep-link to its encoded task id`,
    );
  }
});

test("the aggregate board-write denial opens the board without inventing one task", () => {
  const family = contract.pushEntry.contextualFamilies.find((item) => item.id === "board-write-denied");
  assert.ok(family, "board-write-denied is missing from the push inventory");
  const call = pushCallFor(family);
  assert.match(call, /\{\s*url:\s*"\/\?view=work%2Fboard"\s*\}/, "board-write-denied must open the board in the generated shell");
  assert.doesNotMatch(call, /\btask(?:Id)?:/, "an aggregate denial must not pretend one task represents the batch");
});

test("the id is encoded, not concatenated raw", () => {
  // Capture what FOLLOWS the concatenation and compare it, rather than using a
  // negative lookahead. A lookahead placed after \s* backtracks to zero width
  // and then succeeds against the whitespace itself — the first version of this
  // check reported all five correct call sites as raw. A guard that cries wolf
  // gets deleted, so it has to be right.
  const raw = [...gate.matchAll(/url:\s*"\/\?task="\s*\+\s*(\w+)/g)]
    .filter((m) => m[1] !== "encodeURIComponent")
    .map((m) => m[0]);
  assert.deepEqual(raw, [], "a task id goes into a query string unencoded — encodeURIComponent it");
});

test("the service worker reads the fields the gate actually sends", () => {
  assert.match(sw, /data\.url/, "sw.js must honour data.url");
  assert.match(sw, /data\.taskId/, "sw.js must honour data.taskId");
  // Only same-origin absolute paths. A url from a push payload is data, and an
  // absolute external URL here would turn a notification into an open redirect.
  assert.match(
    sw,
    /new URL\(data\.url, self\.location\.origin\)/,
    "sw.js must resolve a push URL against the service worker's own origin",
  );
  assert.match(sw, /candidate\.origin === self\.location\.origin/, "sw.js must reject an external resolved origin");
  assert.match(sw, /var target = "\/";/, "a push without a URL must open the generated shell, not a removed page");
});

test("notification links stay on this AgentHost origin", async () => {
  assert.equal(await notificationClickTarget("/?task=t_probe"), "/?task=t_probe");
  assert.equal(
    await notificationClickTarget("/chat?task=t_old_worker"),
    "/?task=t_old_worker",
    "a stale payload must keep its task but never reopen a retired page",
  );
  assert.equal(await notificationClickTarget("/settings#channels"), "/#channels");
  assert.equal(
    await notificationClickTarget("//evil.example/phish"),
    "/",
    "a protocol-relative push URL must not become an external navigation",
  );
});

test("an updated worker immediately replaces and controls the old worker", async () => {
  assert.deepEqual(await activationReceipt(), { skipped: 1, claimed: 1 });
});
