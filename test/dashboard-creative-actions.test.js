import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = path.join(root, "dashboard");
const dashboardRequire = createRequire(path.join(dashboardRoot, "package.json"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function transpile(source) {
  const typescript = dashboardRequire("typescript");
  return typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
}

function loadApi() {
  const loaded = { exports: {} };
  new Function("module", "exports", "require", transpile(read("dashboard/lib/api.ts")))(
    loaded,
    loaded.exports,
    dashboardRequire,
  );
  return loaded.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function settleWithin(promise, message, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class ArtifactVersionChangedError extends Error {}
class ArtifactReviewConfirmationError extends Error {}
class ArtifactReviewPartialSaveError extends Error {
  constructor(message, task) { super(message); this.task = task; }
}
class ArtifactReviewOutcomeUnknownError extends Error {
  constructor(message, task = null) { super(message); this.task = task; }
}
class ArtifactReviewSavedReceiptIncompleteError extends Error {
  constructor(message, result) { super(message); this.result = result; }
}

function loadCreative(reviewArtifact) {
  const source = `${read("dashboard/components/agenthost/creative.tsx")}\nexport { CreativeCard as __CreativeCard }`;
  const hookState = [];
  let hookCursor = 0;
  const node = (type, props = {}) => ({ type, props });
  const Fragment = Symbol("Fragment");
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null;
    if (typeof type === "function") return type(props);
    return node(type, props);
  };
  const react = {
    useCallback(callback) { return callback; },
    useEffect() {},
    useRef(initial) {
      const index = hookCursor++;
      if (!(index in hookState)) hookState[index] = { current: initial };
      return hookState[index];
    },
    useState(initial) {
      const index = hookCursor++;
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial;
      return [hookState[index], (next) => {
        hookState[index] = typeof next === "function" ? next(hookState[index]) : next;
      }];
    },
  };
  const Btn = ({ children, type = "button", ...props }) => node("button", { type, ...props, children });
  const passthrough = ({ children, ...props }) => node("span", { ...props, children });
  const AiAssist = (props) => node("ai-assist", props);
  const Icon = () => node("svg");
  const runtime = {
    react,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/api": {
      ARTIFACT_REVIEW_FEEDBACK_MAX: 1200,
      ArtifactVersionChangedError,
      ArtifactReviewConfirmationError,
      ArtifactReviewOutcomeUnknownError,
      ArtifactReviewPartialSaveError,
      ArtifactReviewSavedReceiptIncompleteError,
      artifactViewUrl: (name, version) => `/artifacts/view?p=${encodeURIComponent(name)}&v=${version}`,
      fetchCreativeArtifacts: async () => ({ files: [] }),
      reviewArtifact,
    },
    "./ai-assist": { AiAssist },
    "./primitives": { Btn, MonoLabel: passthrough, Panel: passthrough },
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", transpile(source))(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  );
  return {
    activeCreativeArtifacts: loaded.exports.activeCreativeArtifacts,
    applyArtifactReview: loaded.exports.applyArtifactReview,
    render(artifact, onReviewed = () => true, onVersionChanged = () => {}) {
      hookCursor = 0;
      return loaded.exports.__CreativeCard({ artifact, onReviewed, onVersionChanged });
    },
  };
}

function textFrom(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFrom).join(" ");
  return textFrom(node.props?.children);
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const buttonNamed = (tree, name) => findNode(
  tree,
  (candidate) => candidate.type === "button" && textFrom(candidate).trim() === name,
);

const artifact = {
  name: "launch-concept.html",
  title: "Launch concept",
  kind: "html",
  category: "creative",
  review: null,
  reviewStale: false,
  reviewError: null,
  contentVersion: "a".repeat(64),
  size: 1200,
  mtime: Date.now(),
};

test("confirmed reviews leave the active Creative queue while unresolved rows stay visible", () => {
  const harness = loadCreative(async () => { throw new Error("must not submit"); });
  const staleRevision = { ...artifact, name: "revised.html", review: null, reviewStale: true };
  const unsafe = { ...artifact, name: "unsafe.html", review: null, reviewError: "sidecar could not be read" };
  const unresolved = { ...artifact, name: "unresolved.html", review: null };

  for (const review of ["approved", "rejected", "changes-requested"]) {
    const filed = harness.applyArtifactReview([artifact, staleRevision, unsafe, unresolved], {
      ok: true,
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review,
    });
    assert.deepEqual(
      harness.activeCreativeArtifacts(filed).map((row) => row.name),
      [staleRevision.name, unsafe.name, unresolved.name],
      `${review} did not file only the confirmed artifact version`,
    );
  }

  assert.deepEqual(
    harness.activeCreativeArtifacts([
      { ...artifact, review: "approved" },
      staleRevision,
      unsafe,
      unresolved,
    ]).map((row) => row.name),
    [staleRevision.name, unsafe.name, unresolved.name],
    "a persisted review returned to the active queue after refresh",
  );
});

test("artifact review API sends the exact payload and accepts only a matching persisted state", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      ok: true,
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review: "rejected",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await api.reviewArtifact({
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    action: "reject",
  });
  assert.equal(result.review, "rejected");
  assert.deepEqual(result, { ok: true, name: artifact.name, contentVersion: artifact.contentVersion, review: "rejected" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/artifacts/review");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    action: "reject",
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "approved",
  }), { status: 200 });
  await assert.rejects(
    api.reviewArtifact({ name: artifact.name, contentVersion: artifact.contentVersion, action: "reject" }),
    /confirmed approved instead of rejected/,
  );
});

test("request-adjustments requires real bounded feedback before fetch", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not fetch"); };

  await assert.rejects(
    api.reviewArtifact({ name: artifact.name, contentVersion: artifact.contentVersion, action: "request-adjustments", feedback: "   ", operationId: "review-operation-0001" }),
    /feedback is required to request adjustments/,
  );
  await assert.rejects(
    api.reviewArtifact({ name: artifact.name, contentVersion: artifact.contentVersion, action: "request-adjustments", feedback: "x".repeat(1201), operationId: "review-operation-0001" }),
    /feedback cannot exceed 1200 characters/,
  );
  assert.equal(calls, 0);
});

test("request-adjustments is successful only with a confirmed Codex revision task", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = (body) => new Response(JSON.stringify(body), { status: 200 });
  const operationId = "review-operation-0001";

  globalThis.fetch = async () => response({
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "changes-requested",
    operationId,
  });
  await assert.rejects(
    api.reviewArtifact({ name: artifact.name, contentVersion: artifact.contentVersion, action: "request-adjustments", feedback: "Make the CTA specific.", operationId }),
    /did not confirm a board task/,
  );

  globalThis.fetch = async () => response({
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "changes-requested",
    operationId,
    task: { id: "t_wrong", title: "Creative changes", assignee: "claude" },
  });
  await assert.rejects(
    api.reviewArtifact({ name: artifact.name, contentVersion: artifact.contentVersion, action: "request-adjustments", feedback: "Make the CTA specific.", operationId }),
    /must be assigned to codex/,
  );

  globalThis.fetch = async () => response({
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "changes-requested",
    operationId,
    task: { id: "t_123", title: "Revise creative artifact", assignee: "codex" },
  });
  const confirmed = await api.reviewArtifact({
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    action: "request-adjustments",
    feedback: "Make the CTA specific.",
    operationId,
  });
  assert.equal(confirmed.task.id, "t_123");
});

test("request-adjustments reconciles an ambiguous 200 with the same operation id", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  const operationId = "review-operation-reconcile-0001";
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return new Response("not-json", { status: 200 });
    return new Response(JSON.stringify({
      ok: true,
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review: "changes-requested",
      operationId,
      task: { id: "t_once", title: "Revise creative artifact", assignee: "codex" },
    }), { status: 200 });
  };

  const confirmed = await api.reviewArtifact({
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    action: "request-adjustments",
    feedback: "Tighten the CTA.",
    operationId,
  });
  assert.equal(confirmed.task.id, "t_once");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0], "ambiguous confirmation changed the idempotency key or request");
});

test("an explicit task-created save failure exposes the validated task and is not retried", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  const operationId = "review-partial-save-0001";
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      code: "artifact_review_save_failed_after_task",
      error: "Revision task t_partial was created, but the artifact review was not saved: disk full",
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review: "changes-requested",
      operationId,
      task: { id: "t_partial", title: "Revise creative artifact", assignee: "codex" },
    }), { status: 500 });
  };
  await assert.rejects(
    api.reviewArtifact({
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      action: "request-adjustments",
      feedback: "Tighten the CTA.",
      operationId,
    }),
    (error) => error instanceof api.ArtifactReviewPartialSaveError
      && error.task.id === "t_partial"
      && /disk full/.test(error.message),
  );
  assert.equal(calls, 1, "a known task-created failure was retried and could duplicate the task");
});

test("a durable pending operation is a validated terminal outcome and is not auto-retried", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  const operationId = "review-pending-restart-0001";
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      code: "artifact_review_outcome_unknown",
      error: "This revision operation already started. Inspect the Board; the gate will not create a duplicate task",
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      operationId,
    }), { status: 409 });
  };
  await assert.rejects(
    api.reviewArtifact({
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      action: "request-adjustments",
      feedback: "Tighten the CTA.",
      operationId,
    }),
    (error) => error instanceof api.ArtifactReviewOutcomeUnknownError
      && error.task === null
      && /will not create a duplicate/.test(error.message),
  );
  assert.equal(calls, 1);
});

test("a saved-review receipt failure is validated separately and is not auto-retried", async (t) => {
  const api = loadApi();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  const operationId = "review-saved-receipt-0001";
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      code: "artifact_review_saved_receipt_incomplete",
      error: "The artifact review was saved and revision task t_saved exists, but confirmation cleanup failed",
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review: "changes-requested",
      operationId,
      task: { id: "t_saved", title: "Revise creative artifact", assignee: "codex" },
    }), { status: 500 });
  };
  await assert.rejects(
    api.reviewArtifact({
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      action: "request-adjustments",
      feedback: "Tighten the CTA.",
      operationId,
    }),
    (error) => error instanceof api.ArtifactReviewSavedReceiptIncompleteError
      && error.result.review === "changes-requested"
      && error.result.task.id === "t_saved",
  );
  assert.equal(calls, 1);
});

test("Creative card never shows approval before the server confirms it", async () => {
  const call = deferred();
  const payloads = [];
  const reviewed = [];
  const harness = loadCreative((payload) => {
    payloads.push(payload);
    return call.promise;
  });

  let tree = harness.render(artifact, (result) => reviewed.push(result));
  const href = findNode(tree, (candidate) => candidate.type === "a").props.href;
  assert.equal(href, `/artifacts/view?p=launch-concept.html&v=${artifact.contentVersion}`);
  assert.equal(findNode(tree, (candidate) => candidate.type === "iframe").props.src, href);
  const approve = buttonNamed(tree, "Approve");
  assert.ok(approve, "the Creative card has no reachable Approve control");
  assert.match(approve.props.className, /min-h-11/);
  approve.props.onClick();
  assert.deepEqual(payloads, [{ name: artifact.name, contentVersion: artifact.contentVersion, action: "approve" }]);
  assert.deepEqual(reviewed, []);

  tree = harness.render(artifact, (result) => reviewed.push(result));
  assert.equal(buttonNamed(tree, "Approving…").props.disabled, true);
  assert.doesNotMatch(textFrom(tree), /Approved and filed/);

  call.resolve({ ok: true, name: artifact.name, contentVersion: artifact.contentVersion, review: "approved" });
  await new Promise((resolve) => setImmediate(resolve));
  tree = harness.render({ ...artifact, review: "approved" }, (result) => reviewed.push(result));
  assert.equal(reviewed.length, 1);
  assert.match(textFrom(tree), /Approved and filed/);
});

test("re-reviewing a changed artifact clears its stale marker immediately", async () => {
  let saved
  const harness = loadCreative(async () => ({ ok: true, name: artifact.name, contentVersion: artifact.contentVersion, review: "approved" }))
  let tree = harness.render({ ...artifact, reviewStale: true }, (result) => { saved = result; return true })
  buttonNamed(tree, "Approve").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(saved.review, "approved")

  const [updated] = harness.applyArtifactReview([{ ...artifact, reviewStale: true }], saved)
  assert.equal(updated.reviewStale, false)
  assert.equal(updated.reviewError, null)
  tree = harness.render(updated)
  assert.doesNotMatch(textFrom(tree), /changed since its last review/)
  assert.match(textFrom(tree), /Approved and filed/)
})

test("Reject is a one-tap decision and still waits for the persisted response", async () => {
  const call = deferred();
  const payloads = [];
  const reviewed = [];
  const harness = loadCreative((payload) => {
    payloads.push(payload);
    return call.promise;
  });

  let tree = harness.render(artifact, (result) => reviewed.push(result));
  buttonNamed(tree, "Reject").props.onClick();
  assert.deepEqual(payloads, [{ name: artifact.name, contentVersion: artifact.contentVersion, action: "reject" }]);
  assert.deepEqual(reviewed, []);
  tree = harness.render(artifact, (result) => reviewed.push(result));
  assert.equal(buttonNamed(tree, "Rejecting…").props.disabled, true);
  assert.doesNotMatch(textFrom(tree), /Rejected and filed/);

  call.resolve({ ok: true, name: artifact.name, contentVersion: artifact.contentVersion, review: "rejected" });
  await new Promise((resolve) => setImmediate(resolve));
  tree = harness.render({ ...artifact, review: "rejected" }, (result) => reviewed.push(result));
  assert.equal(reviewed.length, 1);
  assert.match(textFrom(tree), /Rejected and filed/);
});

test("Request adjustments is a keyboard-submittable form with required bounded feedback and named failures", async () => {
  const payloads = [];
  let fail = true;
  let nextReviewCall = null;
  const harness = loadCreative(async (payload) => {
    payloads.push(payload);
    nextReviewCall?.resolve(payload);
    nextReviewCall = null;
    if (fail) throw new Error("artifact changed while review was being saved");
    return {
      ok: true,
      name: artifact.name,
      contentVersion: artifact.contentVersion,
      review: "changes-requested",
      operationId: payload.operationId,
      task: { id: "t_456", title: "Revise creative artifact", assignee: "codex" },
    };
  });

  let tree = harness.render(artifact);
  buttonNamed(tree, "Request adjustments").props.onClick();
  tree = harness.render(artifact);
  const field = findNode(tree, (candidate) => candidate.type === "textarea");
  const form = findNode(tree, (candidate) => candidate.type === "form");
  assert.ok(field && form, "Request adjustments must open an inline feedback form");
  assert.equal(field.props.required, true);
  assert.equal(field.props.maxLength, 1200);
  assert.match(field.props["aria-label"], /Adjustments requested for Launch concept/);
  const assist = findNode(tree, (candidate) => candidate.type === "ai-assist");
  assert.equal(assist?.props.surface, "creative", "reachable creative feedback must use its own Assist prompt profile");
  assert.equal(assist?.props.value, "");
  assert.equal(assist?.props.maxLength, 1200,
    "Creative Assist must not replace bounded feedback with an un-submittable longer answer");

  form.props.onSubmit({ preventDefault() {} });
  assert.equal(payloads.length, 0, "empty feedback reached the API");
  tree = harness.render(artifact);
  assert.match(textFrom(tree), /Feedback is required to request adjustments/);

  findNode(tree, (candidate) => candidate.type === "textarea").props.onChange({
    target: { value: "  The product claim needs a source.  " },
  });
  tree = harness.render(artifact);
  const firstCount = payloads.length;
  const firstReviewCall = deferred();
  nextReviewCall = firstReviewCall;
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
  await settleWithin(firstReviewCall.promise, "the first adjustment request did not reach the API");
  await settleWithin(new Promise((resolve) => setImmediate(resolve)), "the first adjustment UI did not settle");
  assert.equal(payloads.length, firstCount + 1, "the first adjustment submit reached the API more than once");
  assert.equal(payloads[0].name, artifact.name);
  assert.equal(payloads[0].contentVersion, artifact.contentVersion);
  assert.equal(payloads[0].action, "request-adjustments");
  assert.equal(payloads[0].feedback, "The product claim needs a source.");
  assert.match(payloads[0].operationId, /^creative_[0-9a-f]{64}$/);
  assert.deepEqual(payloads[0], {
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    action: "request-adjustments",
    feedback: "The product claim needs a source.",
    operationId: payloads[0].operationId,
  });
  tree = harness.render(artifact);
  assert.match(textFrom(tree), /Review was not saved.*artifact changed while review was being saved/);

  fail = false;
  const retryCount = payloads.length;
  const retryReviewCall = deferred();
  nextReviewCall = retryReviewCall;
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
  await settleWithin(retryReviewCall.promise, "the adjustment retry did not reach the API");
  await settleWithin(new Promise((resolve) => setImmediate(resolve)), "the adjustment retry UI did not settle");
  assert.equal(payloads.length, retryCount + 1, "the adjustment retry reached the API more than once");
  assert.equal(payloads[1].operationId, payloads[0].operationId,
    "a retry after an ambiguous failure changed the idempotency key");
  tree = harness.render({ ...artifact, review: "changes-requested" });
  assert.match(textFrom(tree), /Adjustments requested.*t_456.*assigned to Codex/);
});

test("the same exact adjustment reuses its durable operation after a component reload", async () => {
  const operations = new Map();
  const payloads = [];
  let creates = 0;
  let nextReviewCall = null;
  const review = async (payload) => {
    payloads.push(payload);
    nextReviewCall?.resolve(payload);
    nextReviewCall = null;
    const request = JSON.stringify([payload.name, payload.contentVersion, payload.feedback]);
    const prior = operations.get(payload.operationId);
    if (prior) {
      assert.equal(prior.request, request, "one operation id named two different adjustment requests");
      return prior.result;
    }
    creates += 1;
    const result = {
      ok: true,
      name: payload.name,
      contentVersion: payload.contentVersion,
      review: "changes-requested",
      operationId: payload.operationId,
      task: { id: `t_${creates}`, title: "Revise creative artifact", assignee: "codex" },
    };
    operations.set(payload.operationId, { request, result });
    return result;
  };

  const submit = async (row, note) => {
    // A new harness has fresh hook state, matching a browser reload/remount.
    const harness = loadCreative(review);
    let tree = harness.render(row);
    buttonNamed(tree, "Request adjustments").props.onClick();
    tree = harness.render(row);
    findNode(tree, (candidate) => candidate.type === "textarea").props.onChange({ target: { value: note } });
    tree = harness.render(row);
    const count = payloads.length;
    const reviewCall = deferred();
    nextReviewCall = reviewCall;
    findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
    const payload = await settleWithin(reviewCall.promise, "the adjustment request did not reach the API");
    assert.equal(payloads.length, count + 1, "one adjustment submit reached the API more than once");
    return payload;
  };

  const first = await submit(artifact, "  Make the proof specific.  ");
  const afterReload = await submit(artifact, "Make the proof specific.");
  assert.equal(afterReload.operationId, first.operationId);
  assert.equal(creates, 1, "a reload created a second task for the same exact request");

  const changedFeedback = await submit(artifact, "Make the proof independently verifiable.");
  assert.notEqual(changedFeedback.operationId, first.operationId);
  const changedVersion = await submit({ ...artifact, contentVersion: "b".repeat(64) }, "Make the proof specific.");
  assert.notEqual(changedVersion.operationId, first.operationId);
  assert.notEqual(changedVersion.operationId, changedFeedback.operationId);
  assert.equal(creates, 3);
});

test("Creative names why review controls are unavailable and disables every action", () => {
  const harness = loadCreative(async () => { throw new Error("must not submit"); });
  const tree = harness.render({ ...artifact, reviewError: "artifact name is not reviewable" });
  assert.match(textFrom(tree), /Review controls are unavailable.*artifact name is not reviewable/);
  assert.equal(buttonNamed(tree, "Approve").props.disabled, true);
  assert.equal(buttonNamed(tree, "Reject").props.disabled, true);
  assert.equal(buttonNamed(tree, "Request adjustments").props.disabled, true);
});

test("a revised artifact explains the stale review but stays fully reviewable", () => {
  const harness = loadCreative(async () => ({ ok: true, name: artifact.name, contentVersion: artifact.contentVersion, review: "approved" }));
  const tree = harness.render({ ...artifact, reviewStale: true });
  assert.match(textFrom(tree), /changed since its last review.*Review the new version/);
  assert.equal(buttonNamed(tree, "Approve").props.disabled, false);
  assert.equal(buttonNamed(tree, "Reject").props.disabled, false);
  assert.equal(buttonNamed(tree, "Request adjustments").props.disabled, false);
});

test("a changed artifact refreshes instead of claiming the stale preview was reviewed", async () => {
  let refreshed = 0;
  const reviewed = [];
  const harness = loadCreative(async () => {
    throw new ArtifactVersionChangedError("artifact changed since this preview was loaded");
  });
  let tree = harness.render(artifact, (result) => reviewed.push(result), () => { refreshed += 1; });
  buttonNamed(tree, "Approve").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  tree = harness.render(artifact, (result) => reviewed.push(result), () => { refreshed += 1; });
  assert.equal(refreshed, 1);
  assert.deepEqual(reviewed, []);
  assert.doesNotMatch(textFrom(tree), /Approved and saved/);
  assert.match(textFrom(tree), /Review was not saved.*changed since this preview was loaded/);
});

test("an in-flight version A response cannot mark a newly listed version B reviewed", async () => {
  const harness = loadCreative(async () => ({
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "approved",
  }));
  const versionB = { ...artifact, contentVersion: "b".repeat(64) };
  const [preserved] = harness.applyArtifactReview([versionB], {
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "approved",
  });
  assert.deepEqual(preserved, versionB);

  let refreshed = 0;
  let tree = harness.render(artifact, () => false, () => { refreshed += 1; });
  buttonNamed(tree, "Approve").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  tree = harness.render(artifact, () => false, () => { refreshed += 1; });
  assert.equal(refreshed, 1);
  assert.match(textFrom(tree), /latest version is being refreshed.*not marked reviewed/);
  assert.doesNotMatch(textFrom(tree), /Approved and saved/);
});

test("a known task-created save failure tells the operator not to retry", async () => {
  const task = { id: "t_partial", title: "Revise creative artifact", assignee: "codex" };
  let attempts = 0;
  const reviewCall = deferred();
  const harness = loadCreative(async () => {
    attempts += 1;
    reviewCall.resolve();
    throw new ArtifactReviewPartialSaveError("review state could not be written", task);
  });
  let tree = harness.render(artifact);
  buttonNamed(tree, "Request adjustments").props.onClick();
  tree = harness.render(artifact);
  findNode(tree, (candidate) => candidate.type === "textarea").props.onChange({ target: { value: "Tighten it." } });
  tree = harness.render(artifact);
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
  await settleWithin(reviewCall.promise, "the partial-save request did not reach the API");
  await settleWithin(new Promise((resolve) => setImmediate(resolve)), "the partial-save UI did not settle");
  assert.equal(attempts, 1, "one partial-save submit reached the API more than once");
  tree = harness.render(artifact);
  assert.match(textFrom(tree), /Board task t_partial exists.*review state was not saved.*request is closed/);
  assert.doesNotMatch(textFrom(tree), /Adjustments requested/);
  assert.equal(buttonNamed(tree, "Approve").props.disabled, true);
  assert.equal(buttonNamed(tree, "Reject").props.disabled, true);
  assert.equal(buttonNamed(tree, "Request adjustments").props.disabled, true);
  assert.equal(findNode(tree, (candidate) => candidate.type === "form"), null);
});

test("an unknown restart outcome closes the form and directs the operator to the Board", async () => {
  let attempts = 0;
  const reviewCall = deferred();
  const harness = loadCreative(async () => {
    attempts += 1;
    reviewCall.resolve();
    throw new ArtifactReviewOutcomeUnknownError(
      "This revision operation already started. Inspect the Board; the gate will not create a duplicate task",
    );
  });
  let tree = harness.render(artifact);
  buttonNamed(tree, "Request adjustments").props.onClick();
  tree = harness.render(artifact);
  findNode(tree, (candidate) => candidate.type === "textarea").props.onChange({ target: { value: "Tighten it." } });
  tree = harness.render(artifact);
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
  await settleWithin(reviewCall.promise, "the restart-outcome request did not reach the API");
  await settleWithin(new Promise((resolve) => setImmediate(resolve)), "the restart-outcome UI did not settle");
  assert.equal(attempts, 1, "one restart-outcome submit reached the API more than once");
  tree = harness.render(artifact);
  assert.match(textFrom(tree), /needs reconciliation.*Inspect the Board.*will not create a duplicate/);
  assert.equal(buttonNamed(tree, "Approve").props.disabled, true);
  assert.equal(buttonNamed(tree, "Reject").props.disabled, true);
  assert.equal(buttonNamed(tree, "Request adjustments").props.disabled, true);
  assert.equal(findNode(tree, (candidate) => candidate.type === "form"), null);
});

test("a saved review with incomplete receipt cleanup files the exact artifact and keeps the warning", async () => {
  const receiptFailure = deferred();
  const reviewAttempt = deferred();
  const filing = deferred();
  const result = {
    ok: true,
    name: artifact.name,
    contentVersion: artifact.contentVersion,
    review: "changes-requested",
    operationId: "review-saved-receipt-0001",
    task: { id: "t_saved", title: "Revise creative artifact", assignee: "codex" },
  };
  let reviewed = null;
  let announcement = "";
  const onReviewed = (saved, notice) => {
    reviewed = saved;
    announcement = notice;
    filing.resolve();
    return true;
  };
  const harness = loadCreative(async () => {
    reviewAttempt.resolve();
    await receiptFailure.promise;
    throw new ArtifactReviewSavedReceiptIncompleteError("confirmation cleanup failed", result);
  });
  let tree = harness.render(artifact, onReviewed);
  buttonNamed(tree, "Request adjustments").props.onClick();
  tree = harness.render(artifact, onReviewed);
  findNode(tree, (candidate) => candidate.type === "textarea").props.onChange({ target: { value: "Tighten it." } });
  tree = harness.render(artifact, onReviewed);
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} });
  await settleWithin(reviewAttempt.promise, "the saved-review request did not reach the API");
  assert.equal(reviewed, null, "Creative filed before the API returned a saved receipt");
  receiptFailure.resolve();
  await settleWithin(filing.promise, "the saved-review receipt failure was not filed");
  assert.equal(reviewed, result, "Creative did not file the exact persisted receipt returned by the API");
  const filed = harness.applyArtifactReview([artifact], reviewed);
  assert.deepEqual(harness.activeCreativeArtifacts(filed), [], "the saved artifact card remained in the active queue");
  assert.match(announcement, /Review saved.*task t_saved exists.*confirmation cleanup was incomplete/);
  assert.doesNotMatch(announcement, /confirmation cleanup (?:succeeded|was complete\b)/i);
});
