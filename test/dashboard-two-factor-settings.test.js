import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const componentPath = path.join(ROOT, "components", "agenthost", "two-factor-settings.tsx");
const settingsPath = path.join(ROOT, "components", "agenthost", "settings.tsx");
const dialogsPath = path.join(ROOT, "components", "agenthost", "dialogs.tsx");
const commandCenterPath = path.join(ROOT, "components", "agenthost", "command-center.tsx");
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const typescript = dashboardRequire("typescript");

function loadModule() {
  const source = fs.readFileSync(componentPath, "utf8");
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
  const React = dashboardRequire("react");
  const passthrough = ({ children }) => children;
  const runtime = {
    react: React,
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "./primitives": { Btn: passthrough, Modal: passthrough, MonoLabel: passthrough },
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  );
  return { ...loaded.exports, source };
}

function loadInteractiveModule() {
  const source = fs.readFileSync(componentPath, "utf8");
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
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
      const changed = !previous || !dependencies || dependencies.some((value, offset) => value !== previous.dependencies[offset]);
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
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  );

  function render() {
    cursor = 0;
    return loaded.exports.TwoFactorSettings();
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
    return [node.props.title, node.props.subtitle, node.props.children, node.props.footer].map(textFrom).join(" ");
  }

  return {
    ...loaded.exports,
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

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

test("2FA transport uses only the live cookie-auth endpoints and preserves server causes", async () => {
  const {
    fetchTwoFactorStatus,
    startTwoFactorEnrollment,
    submitTwoFactorCode,
  } = loadModule();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/2fa/status") return response(200, JSON.stringify({ available: true, enrolled: false }));
    if (url === "/2fa/enroll") return response(200, JSON.stringify({ secret: "SCREEN-ONLY", otpauth: "otpauth://totp/AgentHost:test" }));
    return response(429, JSON.stringify({ error: "too many attempts -- wait a minute" }));
  };

  assert.deepEqual(await fetchTwoFactorStatus(fetchImpl), { available: true, enrolled: false });
  assert.deepEqual(await startTwoFactorEnrollment("box-access-key", fetchImpl), {
    secret: "SCREEN-ONLY",
    otpauth: "otpauth://totp/AgentHost:test",
  });
  await assert.rejects(
    submitTwoFactorCode("/2fa/disable", "123456", fetchImpl),
    /too many attempts -- wait a minute/,
  );
  assert.deepEqual(calls.map(({ url }) => url), ["/2fa/status", "/2fa/enroll", "/2fa/disable"]);
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(JSON.parse(calls[1].init.body).key, "box-access-key");
  assert.equal(JSON.parse(calls[2].init.body).code, "123456");
});

test("2FA helpers reject malformed success bodies instead of inventing state", async () => {
  const { fetchTwoFactorStatus, startTwoFactorEnrollment } = loadModule();
  await assert.rejects(
    fetchTwoFactorStatus(async () => response(200, "not json")),
    /malformed JSON/i,
  );
  await assert.rejects(
    startTwoFactorEnrollment("box-access-key", async () => response(200, JSON.stringify({ secret: "missing-url" }))),
    /secret and otpauth/i,
  );
});

test("the Settings security pane is native, accessible, and has no retired full-page 2FA door", () => {
  const { source } = loadModule();
  const settings = fs.readFileSync(settingsPath, "utf8");

  assert.match(settings, /anchor: "security-title"[\s\S]{0,100}label: "Security"/);
  assert.match(settings, /<TwoFactorSettings\s*\/>/);
  assert.doesNotMatch(settings, /href=.*\/2fa|window\.location.*\/2fa/);
  assert.match(source, /<form[\s\S]*onSubmit=\{requestActivation\}/, "Enter opens the activation review instead of writing immediately");
  assert.match(source, /<Modal[\s\S]*title="Activate two-factor authentication\?"/);
  assert.match(source, /Activating 2FA revokes every current box session/i);
  assert.match(source, /Future logins require the box access key and a current authenticator code/i);
  assert.match(source, /inputMode="numeric"/);
  assert.match(source, /autoComplete="one-time-code"/);
  assert.match(source, /id="two-factor-access-key"/);
  assert.match(source, /autoComplete="current-password"/);
  assert.match(source, /stolen browser session/i);
  assert.match(source, /window\.location\.pathname\.startsWith\("\/box"\) \? "\/box\/" : "\/"/,
    "2FA policy changes return direct boxes and AgentGlass frames to their own login surface");
  assert.match(source, /if \(reauthenticate\) returnToLogin\(\)/);
  assert.match(source, /pattern="\[0-9\]\{6\}"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /min-h-11/, "phone controls must be at least 44px high");
  assert.match(source, /<Modal[\s\S]*Turn off two-factor authentication\?/);
  assert.match(source, /lose the second factor/i);
});

test("the native /2fa shell entry opens Settings directly on Security", () => {
  const settings = fs.readFileSync(settingsPath, "utf8");
  const dialogs = fs.readFileSync(dialogsPath, "utf8");
  const commandCenter = fs.readFileSync(commandCenterPath, "utf8");

  assert.match(commandCenter, /window\.location\.pathname === "\/2fa"/);
  assert.match(commandCenter, /setSettingsInitialPane\("security-title"\)/);
  assert.match(commandCenter, /setSettingsOpen\(true\)/);
  assert.match(commandCenter, /initialPane=\{settingsInitialPane\}/);
  assert.match(dialogs, /initialPane\?: SettingsPane/);
  assert.match(dialogs, /initialPane=\{initialPane\}/);
  assert.match(settings, /initialPane\?: SettingsPane/);
  assert.match(settings, /useState<SettingsPane>\(initialPane \?\? "mode-title"\)/);
});

test("disable is a synchronous one-shot consequence path; Cancel cannot call it and failure stays open", () => {
  const { source } = loadModule();
  const cancelBody = source.match(/function cancelDisable\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const confirmBody = source.match(/async function confirmDisable\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.ok(cancelBody, "the disable confirmation needs an explicit Cancel path");
  assert.doesNotMatch(cancelBody, /submitTwoFactorCode|fetch\s*\(/, "Cancel makes a disable request");
  assert.ok(confirmBody, "the disable confirmation needs an explicit Confirm path");
  assert.match(confirmBody, /disableSubmittingRef\.current/);
  assert.match(confirmBody, /disableSubmittingRef\.current\s*=\s*true[\s\S]*await submitTwoFactorCode/,
    "the one-shot guard must close synchronously before the request starts");
  assert.equal((confirmBody.match(/submitTwoFactorCode\s*\(/g) ?? []).length, 1,
    "Confirm must own exactly one disable call");
  assert.match(confirmBody, /setDisableProblem/);
  assert.doesNotMatch(confirmBody, /catch[\s\S]*setDisableConfirmOpen\(false\)/,
    "a failed disable must keep its consequence dialog open");
});

test("secrets are displayed transiently and never logged or persisted in browser storage", () => {
  const { source } = loadModule();
  assert.match(source, /enrollment\.secret/);
  assert.match(source, /enrollment\.otpauth/);
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test("rendered disable journey is Cancel=0, Confirm=1, and a server failure remains visible in the open modal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let releaseDisable;
  const disableResponse = new Promise((resolve) => { releaseDisable = resolve; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/2fa/status") return response(200, JSON.stringify({ available: true, enrolled: true }));
    if (url === "/2fa/disable") return disableResponse;
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const harness = loadInteractiveModule();
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    assert.match(harness.textFrom(tree), /second factor on/i);

    const input = harness.find(tree, (node) => node.props.id === "two-factor-disable-code");
    assert.ok(input, "the enrolled state has no current-code input");
    input.props.onChange({ target: { value: "123456" } });
    tree = harness.render();

    const form = harness.find(tree, (node) => node.type === "form");
    form.props.onSubmit({ preventDefault() {} });
    tree = harness.render();
    assert.match(harness.textFrom(tree), /lose the second factor/i);

    const cancel = harness.find(tree, (node) => node.type === "button" && /Cancel/.test(harness.textFrom(node)));
    cancel.props.onClick();
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/disable").length, 0, "Cancel called disable");

    harness.find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    tree = harness.render();
    const confirm = harness.find(tree, (node) => node.type === "button" && /Confirm and turn off/.test(harness.textFrom(node)));
    confirm.props.onClick();
    confirm.props.onClick();
    assert.equal(calls.filter(({ url }) => url === "/2fa/disable").length, 1, "double click sent more than one disable request");

    releaseDisable(response(400, JSON.stringify({ error: "code didn't match" })));
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.match(harness.textFrom(tree), /code didn't match/i);
    assert.match(harness.textFrom(tree), /lose the second factor/i, "the failed disable closed its consequence modal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rendered activation is Cancel=0, Confirm=1, keeps failure open, and revokes sessions only after review", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let confirmAttempt = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/2fa/status") return response(200, JSON.stringify({ available: true, enrolled: false }));
    if (url === "/2fa/enroll") return response(200, JSON.stringify({ secret: "LIVE-SETUP-SECRET", otpauth: "otpauth://totp/AgentHost:live" }));
    if (url === "/2fa/confirm") {
      confirmAttempt += 1;
      return confirmAttempt === 1
        ? response(400, JSON.stringify({ error: "authenticator code expired" }))
        : response(200, JSON.stringify({ ok: true, reauthenticate: false }));
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const harness = loadInteractiveModule();
    let tree = harness.render();
    await harness.flushEffects();
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/enroll").length, 0, "opening Security started enrollment");

    const keyInput = harness.find(tree, (node) => node.props.id === "two-factor-access-key");
    assert.ok(keyInput, "enrollment must require the access key again");
    keyInput.props.onChange({ target: { value: "live-box-key" } });
    tree = harness.render();
    const startForm = harness.find(tree, (node) => node.type === "form");
    startForm.props.onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/enroll").length, 1);
    assert.equal(JSON.parse(calls.find(({ url }) => url === "/2fa/enroll").init.body).key, "live-box-key");
    assert.match(harness.textFrom(tree), /LIVE-SETUP-SECRET/);
    assert.match(harness.textFrom(tree), /otpauth:\/\/totp\/AgentHost:live/);

    const input = harness.find(tree, (node) => node.props.id === "two-factor-activation-code");
    input.props.onChange({ target: { value: "654321" } });
    tree = harness.render();
    const form = harness.find(tree, (node) => node.type === "form");
    form.props.onSubmit({ preventDefault() {} });
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/confirm").length, 0, "Enter bypassed the activation review");
    assert.match(harness.textFrom(tree), /revokes every current box session/i);
    assert.match(harness.textFrom(tree), /Future logins require the box access key and a current authenticator code/i);

    const cancel = harness.find(tree, (node) => node.type === "button" && /Cancel/.test(harness.textFrom(node)));
    cancel.props.onClick();
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/confirm").length, 0, "Cancel activated 2FA");

    harness.find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    tree = harness.render();
    let confirm = harness.find(tree, (node) => node.type === "button" && /Confirm and activate/.test(harness.textFrom(node)));
    confirm.props.onClick();
    confirm.props.onClick();
    assert.equal(calls.filter(({ url }) => url === "/2fa/confirm").length, 1, "rapid Confirm sent more than one activation request");
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.match(harness.textFrom(tree), /authenticator code expired/i);
    assert.match(harness.textFrom(tree), /revokes every current box session/i, "failure closed the activation review");

    confirm = harness.find(tree, (node) => node.type === "button" && /Confirm and activate/.test(harness.textFrom(node)));
    confirm.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    tree = harness.render();
    assert.equal(calls.filter(({ url }) => url === "/2fa/confirm").length, 2);
    assert.equal(JSON.parse(calls.find(({ url }) => url === "/2fa/confirm").init.body).code, "654321");
    assert.match(harness.textFrom(tree), /second factor on/i);
    assert.doesNotMatch(harness.textFrom(tree), /LIVE-SETUP-SECRET/, "the setup secret remained rendered after activation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
