import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const componentPath = path.join(ROOT, "components", "agenthost", "push-notification-settings.tsx");
const apiPath = path.join(ROOT, "lib", "api.ts");
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const typescript = dashboardRequire("typescript");

function compile(source, filename) {
  return typescript.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
}

function loadApi() {
  const source = fs.readFileSync(apiPath, "utf8");
  const loaded = { exports: {} };
  new Function("module", "exports", "require", compile(source, apiPath))(
    loaded,
    loaded.exports,
    dashboardRequire,
  );
  return loaded.exports;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

function loadInteractiveComponent(api) {
  const source = fs.readFileSync(componentPath, "utf8");
  const React = dashboardRequire("react");
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const InteractiveReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      const changed = !previous || !dependencies
        || dependencies.some((value, offset) => value !== previous.dependencies[offset]);
      if (changed) pendingEffects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: effect() };
      });
    },
  };
  const ModalMarker = () => null;
  const runtime = {
    react: InteractiveReact,
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "./primitives": { Btn: "button", Modal: ModalMarker, MonoLabel: "span" },
    "./service-worker-registration": { SERVICE_WORKER_OUTCOME_EVENT: "agenthost:service-worker-outcome" },
    "../../lib/api": api,
    "@/lib/api": api,
    "@/lib/brand": { getBuyerBrand: () => ({ name: "AgentHost" }) },
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", compile(source, componentPath))(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  );

  function render() {
    cursor = 0;
    return loaded.exports.PushNotificationSettings();
  }

  function visit(node, callback, visible = true) {
    if (!visible || node == null || typeof node === "boolean") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, callback, visible);
      return;
    }
    if (!React.isValidElement(node)) return;
    const isModal = node.type === ModalMarker;
    const shown = !isModal || Boolean(node.props.open);
    if (!shown) return;
    callback(node);
    if (isModal) {
      visit(node.props.title, callback, shown);
      visit(node.props.subtitle, callback, shown);
      visit(node.props.children, callback, shown);
      visit(node.props.footer, callback, shown);
      return;
    }
    visit(node.props.children, callback, shown);
  }

  function textFrom(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textFrom).join("");
    if (!React.isValidElement(node)) return "";
    if (node.type === ModalMarker && !node.props.open) return "";
    return [node.props.title, node.props.subtitle, node.props.children, node.props.footer]
      .map(textFrom)
      .join(" ");
  }

  return {
    ...loaded.exports,
    source,
    render,
    textFrom,
    find(tree, predicate) {
      let result;
      visit(tree, (node) => { if (!result && predicate(node)) result = node; });
      return result;
    },
    async flushEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) effect();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("push API helpers use only canonical cookie-auth routes and preserve exact server causes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/push/key") return response(200, JSON.stringify({ key: "BElive-public-vapid-key" }));
    if (url === "/push/status") return response(200, JSON.stringify({ subscribed: true, originReset: false, signingKeyReset: false, total: 1 }));
    if (url === "/push/subscribe") return response(200, JSON.stringify({ ok: true }));
    if (url === "/push/unsubscribe") return response(503, JSON.stringify({ error: "subscription store is read-only" }));
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const api = loadApi();
    const payload = {
      endpoint: "https://push.example/subscription-id",
      expirationTime: null,
      keys: { p256dh: "browser-public-key", auth: "browser-auth-secret" },
    };

    assert.equal(await api.fetchPushPublicKey(), "BElive-public-vapid-key");
    assert.deepEqual(await api.fetchPushSubscriptionStatus(payload.endpoint), {
      subscribed: true,
      originReset: false,
      signingKeyReset: false,
    });
    await api.savePushSubscription(payload);
    await assert.rejects(
      api.removePushSubscription(payload.endpoint),
      /subscription store is read-only/,
    );

    assert.deepEqual(calls.map(({ url }) => url), [
      "/push/key",
      "/push/status",
      "/push/subscribe",
      "/push/unsubscribe",
    ]);
    assert.equal(calls[0].init.credentials, "include");
    for (const call of calls.slice(1)) {
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.credentials, "include");
      assert.equal(call.init.headers["Content-Type"], "application/json");
    }
    assert.deepEqual(JSON.parse(calls[1].init.body), { endpoint: payload.endpoint });
    assert.deepEqual(JSON.parse(calls[2].init.body), payload);
    assert.deepEqual(JSON.parse(calls[3].init.body), { endpoint: payload.endpoint });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("push API helpers reject malformed success bodies and incomplete browser subscriptions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const api = loadApi();
    globalThis.fetch = async () => response(200, JSON.stringify({ key: 42 }));
    await assert.rejects(api.fetchPushPublicKey(), /public key/i);

    globalThis.fetch = async () => response(200, JSON.stringify({ subscribed: false }));
    await assert.rejects(api.fetchPushSubscriptionStatus(""), /subscription and reset state/i);

    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return response(200, JSON.stringify({ ok: true }));
    };
    await assert.rejects(
      api.savePushSubscription({ endpoint: "https://push.example/incomplete" }),
      /p256dh and auth/i,
    );
    assert.equal(called, false, "an incomplete subscription reached the box");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enable is an in-app Cancel=0 Confirm=1 journey; disable removes box and browser subscriptions", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const calls = [];
  let localSubscription = null;
  const subscription = {
    endpoint: "https://push.example/live-device",
    toJSON() {
      return {
        endpoint: this.endpoint,
        expirationTime: null,
        keys: { p256dh: "browser-public-key", auth: "browser-auth-secret" },
      };
    },
    async unsubscribe() {
      calls.push("browser.unsubscribe");
      localSubscription = null;
      return true;
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        calls.push("browser.getSubscription");
        return localSubscription;
      },
      async subscribe(options) {
        calls.push({ kind: "browser.subscribe", options });
        localSubscription = subscription;
        return subscription;
      },
    },
  };
  const notification = {
    permission: "default",
    async requestPermission() {
      calls.push("browser.requestPermission");
      this.permission = "granted";
      return "granted";
    },
  };
  const fakeWindow = {};
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  fakeWindow.Notification = notification;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
  });

  const api = {
    async fetchPushPublicKey() {
      calls.push("api.key");
      return "BElive-public-vapid-key";
    },
    async fetchPushSubscriptionStatus(endpoint) {
      calls.push({ kind: "api.status", endpoint });
      return { subscribed: false, originReset: false, signingKeyReset: false };
    },
    async savePushSubscription(payload) {
      calls.push({ kind: "api.subscribe", payload });
    },
    async removePushSubscription(endpoint) {
      calls.push({ kind: "api.unsubscribe", endpoint });
    },
  };

  try {
    const harness = loadInteractiveComponent(api);
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    assert.match(harness.textFrom(tree), /notifications are off/i);

    const enable = harness.find(tree, (node) => node.type === "button" && /Enable notifications/.test(harness.textFrom(node)));
    assert.ok(enable, "the off state has no enable control");
    enable.props.onClick();
    tree = harness.render();
    assert.match(harness.textFrom(tree), /ask this browser for notification permission/i);
    assert.equal(calls.filter((entry) => entry === "browser.requestPermission").length, 0);
    assert.equal(calls.filter((entry) => entry === "api.key").length, 0);

    const cancel = harness.find(tree, (node) => node.type === "button" && /Cancel/.test(harness.textFrom(node)));
    cancel.props.onClick();
    tree = harness.render();
    assert.equal(calls.filter((entry) => entry === "browser.requestPermission").length, 0, "Cancel requested permission");
    assert.equal(calls.filter((entry) => entry && entry.kind === "browser.subscribe").length, 0, "Cancel subscribed the browser");
    assert.equal(calls.filter((entry) => entry && entry.kind === "api.subscribe").length, 0, "Cancel saved a subscription");

    harness.find(tree, (node) => node.type === "button" && /Enable notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    const confirm = harness.find(tree, (node) => node.type === "button" && /Confirm and enable/.test(harness.textFrom(node)));
    confirm.props.onClick();
    confirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(calls.filter((entry) => entry === "browser.requestPermission").length, 1, "rapid Confirm requested permission twice");
    assert.equal(calls.filter((entry) => entry && entry.kind === "browser.subscribe").length, 1, "rapid Confirm subscribed twice");
    assert.equal(calls.filter((entry) => entry && entry.kind === "api.subscribe").length, 1, "rapid Confirm saved twice");
    assert.match(harness.textFrom(tree), /notifications are on/i);

    harness.find(tree, (node) => node.type === "button" && /Turn off notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    assert.match(harness.textFrom(tree), /stop alerts on this device/i);
    const disableCancel = harness.find(tree, (node) => node.type === "button" && /Cancel/.test(harness.textFrom(node)));
    disableCancel.props.onClick();
    assert.equal(calls.filter((entry) => entry && entry.kind === "api.unsubscribe").length, 0, "disable Cancel removed the subscription");

    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Turn off notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    const disableConfirm = harness.find(tree, (node) => node.type === "button" && /Confirm and turn off/.test(harness.textFrom(node)));
    disableConfirm.props.onClick();
    disableConfirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(calls.filter((entry) => entry && entry.kind === "api.unsubscribe").length, 1, "rapid disable Confirm called the box twice");
    assert.equal(calls.filter((entry) => entry === "browser.unsubscribe").length, 1, "browser subscription was not removed exactly once");
    assert.match(harness.textFrom(tree), /notifications are off/i);
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("enable replaces a browser subscription bound to the box's retired signing key", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const calls = [];
  const newKey = Uint8Array.from([1, 2, 3, 4]);
  let localSubscription;
  const freshSubscription = {
    endpoint: "https://push.example/new-key-device",
    options: { applicationServerKey: newKey.buffer },
    toJSON() {
      return {
        endpoint: this.endpoint,
        expirationTime: null,
        keys: { p256dh: "new-browser-public-key", auth: "new-browser-auth-key" },
      };
    },
    async unsubscribe() { throw new Error("the fresh subscription must not be removed"); },
  };
  const staleSubscription = {
    endpoint: "https://push.example/old-key-device",
    options: { applicationServerKey: Uint8Array.from([9, 9, 9, 9]).buffer },
    async unsubscribe() {
      calls.push("browser.unsubscribe-stale");
      localSubscription = null;
      return true;
    },
  };
  localSubscription = staleSubscription;
  const registration = {
    pushManager: {
      async getSubscription() { return localSubscription; },
      async subscribe(options) {
        calls.push({ kind: "browser.subscribe", options });
        assert.deepEqual(Array.from(options.applicationServerKey), Array.from(newKey));
        localSubscription = freshSubscription;
        return freshSubscription;
      },
    },
  };
  const notification = { permission: "granted", async requestPermission() { return "granted"; } };
  const fakeWindow = { Notification: notification };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
  });

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() {
        calls.push("api.key");
        return "AQIDBA";
      },
      async fetchPushSubscriptionStatus(endpoint) {
        calls.push({ kind: "api.status", endpoint });
        return { subscribed: false, originReset: false, signingKeyReset: true };
      },
      async savePushSubscription(payload) { calls.push({ kind: "api.subscribe", payload }); },
      async removePushSubscription() {},
    });
    harness.render();
    await harness.flushEffects();
    let tree = harness.render();
    assert.match(harness.textFrom(tree), /replaced its notification signing key/i);
    assert.match(harness.textFrom(tree), /Notifications are off/i);

    harness.find(tree, (node) => node.type === "button" && /Enable notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    const confirm = harness.find(tree, (node) => node.type === "button" && /Confirm and enable/.test(harness.textFrom(node)));
    confirm.props.onClick();
    confirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(calls.filter((entry) => entry === "browser.unsubscribe-stale").length, 1);
    assert.equal(calls.filter((entry) => entry && entry.kind === "browser.subscribe").length, 1);
    assert.equal(calls.filter((entry) => entry && entry.kind === "api.subscribe").length, 1);
    assert.match(harness.textFrom(tree), /Notifications are on/i);
    assert.doesNotMatch(harness.textFrom(tree), /replaced its notification signing key/i);
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("permission denial names its cause and keeps the enable review open", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const notification = {
    permission: "default",
    async requestPermission() {
      this.permission = "denied";
      return "denied";
    },
  };
  const fakeWindow = {};
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  fakeWindow.Notification = notification;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) } },
  });

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() { throw new Error("must not fetch a key after denial"); },
      async fetchPushSubscriptionStatus() { return { subscribed: false, originReset: false, signingKeyReset: false }; },
      async savePushSubscription() { throw new Error("must not save after denial"); },
      async removePushSubscription() {},
    });
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Enable notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Confirm and enable/.test(harness.textFrom(node))).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.match(harness.textFrom(tree), /blocked in this browser/i);
    assert.match(harness.textFrom(tree), /ask this browser for notification permission/i, "permission failure closed the review");
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("worker registration failure ends checking with the observed cause", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const neverReady = new Promise(() => {});
  const notification = { permission: "default", async requestPermission() { return "default"; } };
  const fakeWindow = {
    Notification: notification,
    __agentHostServiceWorkerOutcome: { problem: "Service workers are blocked by this browser profile" },
  };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: neverReady } },
  });

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() { throw new Error("must not fetch while worker is unavailable"); },
      async fetchPushSubscriptionStatus() { return { subscribed: false, originReset: false, signingKeyReset: false }; },
      async savePushSubscription() {},
      async removePushSubscription() {},
    });
    harness.render();
    await harness.flushEffects();
    const tree = harness.render();
    assert.doesNotMatch(harness.textFrom(tree), /Checking this device/i);
    assert.match(harness.textFrom(tree), /Service workers are blocked by this browser profile/i);
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("a canonical browser with no local subscription sees the retired-origin re-enrollment cause", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const notification = { permission: "default", async requestPermission() { return "default"; } };
  const fakeWindow = { Notification: notification };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) } },
  });
  const statusEndpoints = [];

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() { return "unused"; },
      async fetchPushSubscriptionStatus(endpoint) {
        statusEndpoints.push(endpoint);
        return { subscribed: false, originReset: true, signingKeyReset: false };
      },
      async savePushSubscription() {},
      async removePushSubscription() {},
    });
    harness.render();
    await harness.flushEffects();
    const tree = harness.render();
    assert.deepEqual(statusEndpoints, [""], "a browser without a local endpoint did not ask the box for migration state");
    assert.match(harness.textFrom(tree), /Notifications are off/i);
    assert.match(harness.textFrom(tree), /retired box address.*sealed/i);
    assert.match(harness.textFrom(tree), /Enable notifications again on this canonical address/i);
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("a partial disable reports delivery off and keeps the browser-cleanup cause open", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const subscription = {
    endpoint: "https://push.example/partial-device",
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } }; },
    async unsubscribe() { return false; },
  };
  const registration = { pushManager: { async getSubscription() { return subscription; } } };
  const notification = { permission: "granted", async requestPermission() { return "granted"; } };
  const fakeWindow = { Notification: notification };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
  });
  let removed = 0;

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() { return "unused"; },
      async fetchPushSubscriptionStatus() { return { subscribed: true, originReset: false, signingKeyReset: false }; },
      async savePushSubscription() {},
      async removePushSubscription() { removed += 1; },
    });
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Turn off notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Confirm and turn off/.test(harness.textFrom(node))).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(removed, 1);
    assert.match(harness.textFrom(tree), /Notifications are off/i);
    assert.match(harness.textFrom(tree), /box stopped alerts.*browser did not remove/i);
    assert.match(harness.textFrom(tree), /This browser will stop receiving AgentHost alerts/i, "partial failure closed its review");
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("the component is phone reachable and never logs or persists subscription material", () => {
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /min-h-11/, "phone controls must be at least 44px high");
  assert.match(source, /role="alert"/);
  assert.match(source, /<Modal[\s\S]*Enable notifications on this device\?/);
  assert.match(source, /<Modal[\s\S]*Turn off notifications on this device\?/);
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(source, /did not become ready within 4 seconds/);
  assert.match(source, /setState\("off"\)[\s\S]*?partialProblem/);
});

test("a rejected browser unsubscribe still reports box delivery off with the local cause", async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = globalThis.Notification;
  const subscription = {
    endpoint: "https://push.example/rejected-cleanup",
    async unsubscribe() { throw new Error("browser push database is locked"); },
  };
  const registration = { pushManager: { async getSubscription() { return subscription; } } };
  const notification = { permission: "granted", async requestPermission() { return "granted"; } };
  const fakeWindow = { Notification: notification };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  globalThis.window = fakeWindow;
  globalThis.Notification = notification;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
  });
  let removed = 0;

  try {
    const harness = loadInteractiveComponent({
      async fetchPushPublicKey() { return "unused"; },
      async fetchPushSubscriptionStatus() { return { subscribed: true, originReset: false, signingKeyReset: false }; },
      async savePushSubscription() {},
      async removePushSubscription() { removed += 1; },
    });
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Turn off notifications/.test(harness.textFrom(node))).props.onClick();
    tree = harness.render();
    harness.find(tree, (node) => node.type === "button" && /Confirm and turn off/.test(harness.textFrom(node))).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(removed, 1);
    assert.match(harness.textFrom(tree), /Notifications are off/i);
    assert.match(harness.textFrom(tree), /box stopped alerts.*browser could not remove.*database is locked/i);
    assert.match(harness.textFrom(tree), /This browser will stop receiving AgentHost alerts/i);
  } finally {
    globalThis.window = originalWindow;
    globalThis.Notification = originalNotification;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});
