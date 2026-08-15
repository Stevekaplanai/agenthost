import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dashboardRoot = path.join(root, "dashboard")
const dashboardRequire = createRequire(path.join(dashboardRoot, "package.json"))


function loadSecrets({
  deleteBoxSecret = async (name) => ({ ok: true, name, deleted: true }),
  fetchBoxSecretStatus,
  storeBoxSecret,
}) {
  const source = fs.readFileSync(path.join(root, "dashboard/components/agenthost/secrets.tsx"), "utf8")
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText

  const hookState = []
  let hookCursor = 0
  let pendingEffects = []
  let mounted = false
  let writesAfterUnmount = 0
  const depsEqual = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]))
  const node = (type, props = {}) => ({ type, props })
  const Fragment = Symbol("Fragment")
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null
    if (typeof type === "function") return type(props)
    return node(type, props)
  }
  const ReactRuntime = {
    useCallback(callback, deps) {
      const index = hookCursor++
      const prior = hookState[index]
      if (!prior || !depsEqual(prior.deps, deps)) hookState[index] = { deps, value: callback }
      return hookState[index].value
    },
    useEffect(effect, deps) {
      const index = hookCursor++
      const prior = hookState[index]
      if (!prior || !depsEqual(prior.deps, deps)) pendingEffects.push({ index, effect, deps, cleanup: prior?.cleanup })
    },
    useRef(initial) {
      const index = hookCursor++
      if (!(index in hookState)) hookState[index] = { current: initial }
      return hookState[index]
    },
    useState(initial) {
      const index = hookCursor++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => {
        if (!mounted) writesAfterUnmount += 1
        hookState[index] = typeof next === "function" ? next(hookState[index]) : next
      }]
    },
  }
  const passthrough = ({ children, ...props }) => node("span", { ...props, children })
  const Btn = ({ children, ...props }) => node("button", { ...props, children })
  const Modal = ({ open, title, subtitle, children, footer, ...props }) => open
    ? node("dialog", { ...props, children: [title, subtitle, children, footer] })
    : null
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => () => node("svg") }),
    "@/lib/api": { deleteBoxSecret, fetchBoxSecretStatus, storeBoxSecret },
    "./primitives": { Btn, Modal, MonoLabel: passthrough, Panel: passthrough },
  }
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  )

  return {
    render() {
      mounted = true
      hookCursor = 0
      pendingEffects = []
      const tree = loaded.exports.Secrets()
      for (const pending of pendingEffects) {
        pending.cleanup?.()
        hookState[pending.index] = { deps: pending.deps, cleanup: pending.effect() }
      }
      return tree
    },
    unmount() {
      mounted = false
      for (const hook of hookState) hook?.cleanup?.()
    },
    writesAfterUnmount() { return writesAfterUnmount },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function walk(value, out = []) {
  if (value === null || value === undefined || typeof value === "boolean") return out
  if (Array.isArray(value)) { for (const child of value) walk(child, out); return out }
  if (typeof value === "object") { out.push(value); walk(value.props?.children, out) }
  return out
}

function visibleText(value) {
  if (value === null || value === undefined || typeof value === "boolean") return ""
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(visibleText).join(" ")
  return visibleText(value.props?.children)
}

function fillRequiredFields(form, secrets) {
  const fields = walk(form).filter((item) => item.type === "input")
  assert.equal(fields.length, 3, "the fixed Environment choice must not become a fourth free-text secret")
  for (let i = 0; i < fields.length; i += 1) fields[i].props.onChange({ target: { value: secrets[i] } })
}


test("general Secrets clears the controlled password as soon as its POST is attempted", async () => {
  const storeReply = deferred()
  const harness = loadSecrets({
    fetchBoxSecretStatus: async () => ({ secrets: [] }),
    storeBoxSecret: () => storeReply.promise,
  })
  let tree = harness.render()
  const nameField = walk(tree).find((item) => item.props?.["aria-label"] === "Secret variable name")
  const valueField = walk(tree).find((item) => item.props?.["aria-label"] === "Secret value")
  nameField.props.onChange({ target: { value: "api_key" } })
  valueField.props.onChange({ target: { value: "never-render-me" } })

  tree = harness.render()
  const submission = walk(tree).find((item) => item.type === "form").props.onSubmit({ preventDefault() {} })
  tree = harness.render()
  const savingName = walk(tree).find((item) => item.props?.["aria-label"] === "Secret variable name")
  const savingValue = walk(tree).find((item) => item.props?.["aria-label"] === "Secret value")
  assert.equal(savingValue.props.value, "",
    "the password must clear while the POST reply is still pending")
  assert.equal(savingName.props.disabled, true)
  assert.equal(savingValue.props.disabled, true)
  savingName.props.onChange({ target: { value: "NEXT_KEY" } })
  savingValue.props.onChange({ target: { value: "next-secret" } })
  tree = harness.render()
  assert.equal(walk(tree).find((item) => item.props?.["aria-label"] === "Secret variable name").props.value, "API_KEY",
    "even a synthetic edit cannot replace the in-flight request identity")
  assert.equal(walk(tree).find((item) => item.props?.["aria-label"] === "Secret value").props.value, "",
    "a new password cannot enter state beside the old in-flight request")

  storeReply.reject(new Error("/secret returned malformed JSON after the POST left the browser"))
  await submission
  tree = harness.render()
  assert.equal(walk(tree).find((item) => item.props?.["aria-label"] === "Secret value").props.value, "")
  assert.match(visibleText(tree), /malformed JSON/, "the ambiguous response must retain its real cause")
  assert.doesNotMatch(visibleText(tree), /never-render-me/, "an attempted secret must never be rendered after failure")
})

test("general Secrets ignores older refresh responses and invalidates pending work on unmount", async () => {
  const older = deferred()
  const newer = deferred()
  let fetchCount = 0
  const harness = loadSecrets({
    fetchBoxSecretStatus: () => (++fetchCount === 1 ? older.promise : newer.promise),
    storeBoxSecret: async (name) => ({ ok: true, name, updated: false }),
  })

  let tree = harness.render()
  walk(tree).find((item) => item.props?.["aria-label"] === "Secret variable name").props.onChange({ target: { value: "NEW_KEY" } })
  walk(tree).find((item) => item.props?.["aria-label"] === "Secret value").props.onChange({ target: { value: "secret-value" } })
  tree = harness.render()
  const submission = walk(tree).find((item) => item.type === "form").props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCount, 2, "a successful save must start a newer status refresh")

  newer.resolve({ secrets: [{ name: "NEWER_STATUS", present: true }] })
  await submission
  tree = harness.render()
  assert.match(visibleText(tree), /NEWER_STATUS/)

  older.resolve({ secrets: [{ name: "STALE_STATUS", present: true }] })
  await new Promise((resolve) => setImmediate(resolve))
  tree = harness.render()
  assert.match(visibleText(tree), /NEWER_STATUS/, "the newest completed refresh must remain authoritative")
  assert.doesNotMatch(visibleText(tree), /STALE_STATUS/, "an older response must not overwrite newer state")

  const pending = deferred()
  const unmounted = loadSecrets({
    fetchBoxSecretStatus: () => pending.promise,
    storeBoxSecret: async () => ({ ok: true, name: "UNUSED", updated: false }),
  })
  unmounted.render()
  await Promise.resolve()
  unmounted.unmount()
  pending.resolve({ secrets: [{ name: "AFTER_UNMOUNT", present: true }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unmounted.writesAfterUnmount(), 0, "a pending refresh must not update state after unmount")
})

test("stored secrets require confirmation before removal and one confirmation sends one DELETE", async () => {
  const removal = deferred()
  let removed = false
  const deleteCalls = []
  const harness = loadSecrets({
    fetchBoxSecretStatus: async () => ({
      secrets: removed ? [] : [{ name: "DEEPSEEK_API_KEY", present: true }],
    }),
    storeBoxSecret: async (name) => ({ ok: true, name, updated: false }),
    deleteBoxSecret: (name) => {
      deleteCalls.push(name)
      return removal.promise
    },
  })

  harness.render()
  await new Promise((resolve) => setImmediate(resolve))
  let tree = harness.render()
  let remove = walk(tree).find((item) => item.props?.["aria-label"] === "Remove DEEPSEEK_API_KEY")
  assert.ok(remove, "a stored DeepSeek key must expose the generic removal control")

  remove.props.onClick()
  tree = harness.render()
  assert.match(visibleText(tree), /key missing/i, "the confirmation must name the state after deletion")
  assert.equal(deleteCalls.length, 0, "opening the confirmation must not delete anything")
  walk(tree).find((item) => item.props?.["aria-label"] === "Cancel secret removal").props.onClick()
  assert.equal(deleteCalls.length, 0, "Cancel must make zero deletion requests")

  tree = harness.render()
  remove = walk(tree).find((item) => item.props?.["aria-label"] === "Remove DEEPSEEK_API_KEY")
  remove.props.onClick()
  tree = harness.render()
  const confirm = walk(tree).find((item) => item.props?.["aria-label"] === "Confirm remove DEEPSEEK_API_KEY")
  const first = confirm.props.onClick()
  const duplicate = confirm.props.onClick()
  assert.equal(deleteCalls.length, 1, "a fast double-confirm must still send exactly one DELETE")

  removed = true
  removal.resolve({ ok: true, name: "DEEPSEEK_API_KEY", deleted: true })
  await Promise.all([first, duplicate])
  tree = harness.render()
  assert.match(visibleText(tree), /DEEPSEEK_API_KEY\s+was removed/i)
  assert.match(visibleText(tree), /key missing/i)
  assert.equal(walk(tree).some((item) => item.props?.["aria-label"] === "Remove DEEPSEEK_API_KEY"), false)
})

test("an ambiguous DELETE reconciles status before claiming whether the secret was removed", async () => {
  let statusCalls = 0
  const deleted = loadSecrets({
    fetchBoxSecretStatus: async () => ({
      secrets: ++statusCalls === 1 ? [{ name: "DEEPSEEK_API_KEY", present: true }] : [],
    }),
    storeBoxSecret: async (name) => ({ ok: true, name, updated: false }),
    deleteBoxSecret: async () => { throw new Error("DELETE reply was lost") },
  })

  deleted.render()
  await new Promise((resolve) => setImmediate(resolve))
  let tree = deleted.render()
  walk(tree).find((item) => item.props?.["aria-label"] === "Remove DEEPSEEK_API_KEY").props.onClick()
  tree = deleted.render()
  walk(tree).find((item) => item.props?.["aria-label"] === "Confirm remove DEEPSEEK_API_KEY").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = deleted.render()
  assert.match(visibleText(tree), /DEEPSEEK_API_KEY\s+was removed/i,
    "an absent status after a lost DELETE reply confirms removal")
  assert.doesNotMatch(visibleText(tree), /was not removed/i)

  let uncertainStatusCalls = 0
  const uncertain = loadSecrets({
    fetchBoxSecretStatus: async () => {
      uncertainStatusCalls += 1
      if (uncertainStatusCalls === 1) return { secrets: [{ name: "DEEPSEEK_API_KEY", present: true }] }
      throw new Error("status endpoint unavailable")
    },
    storeBoxSecret: async (name) => ({ ok: true, name, updated: false }),
    deleteBoxSecret: async () => { throw new Error("DELETE reply was lost") },
  })

  uncertain.render()
  await new Promise((resolve) => setImmediate(resolve))
  tree = uncertain.render()
  walk(tree).find((item) => item.props?.["aria-label"] === "Remove DEEPSEEK_API_KEY").props.onClick()
  tree = uncertain.render()
  walk(tree).find((item) => item.props?.["aria-label"] === "Confirm remove DEEPSEEK_API_KEY").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = uncertain.render()
  assert.match(visibleText(tree), /removal could not be confirmed/i)
  assert.match(visibleText(tree), /DELETE reply was lost/)
  assert.match(visibleText(tree), /status endpoint unavailable/)
  assert.doesNotMatch(visibleText(tree), /was not removed/i)
})
