import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

class FakeClassList {
  constructor(owner) { this.owner = owner; }
  names() { return new Set(this.owner.className.split(/\s+/).filter(Boolean)); }
  write(names) { this.owner.className = [...names].join(" "); }
  add(name) { const names = this.names(); names.add(name); this.write(names); }
  remove(name) { const names = this.names(); names.delete(name); this.write(names); }
  contains(name) { return this.names().has(name); }
  toggle(name, force) {
    const names = this.names();
    const add = force === undefined ? !names.has(name) : force;
    if (add) names.add(name); else names.delete(name);
    this.write(names);
  }
}

class FakeElement {
  constructor() {
    this.children = [];
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.value = "";
    this._text = "";
    this.listeners = new Map();
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    const index = this.children.indexOf(before);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name) { const listener = this.listeners.get(name); if (listener) listener({}); }
  focus() {}
  querySelectorAll(selector) {
    const match = /^(?:\.([\w-]+))(?:\:not\(\.([\w-]+)\))?$/.exec(selector);
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (match && child.classList && child.classList.contains(match[1]) &&
            (!match[2] || !child.classList.contains(match[2]))) found.push(child);
        if (child.children) visit(child);
      }
    };
    visit(this);
    return found;
  }
  get scrollHeight() { return this.children.length; }
}

function bootRoom(fetchImpl = async () => {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(here, "..", "desktop", "room", "room.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = {
    body: new FakeElement(),
    createElement: () => new FakeElement(),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
  };
  let stream;
  class FakeEventSource {
    constructor() { this.listeners = new Map(); stream = this; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, data) { this.listeners.get(name)({ data: JSON.stringify(data) }); }
  }
  vm.runInNewContext(script, { document, EventSource: FakeEventSource, fetch: fetchImpl });
  return { messages: document.getElementById("messages"), stream, elements };
}

test("live SSE uses causal order while preserving the timestamp shown to the operator", () => {
  const { messages, stream } = bootRoom();
  stream.emit("message", { id: "box-first", seq: 1, at: 3000, orderAt: 3000, who: "box:claude", text: "box first" });
  stream.emit("message", { id: "local", seq: 2, at: 2000, orderAt: 2000, who: "steve", text: "local middle" });
  stream.emit("message", { id: "box-second", seq: 3, at: 1000, orderAt: 3000, who: "box:codex", text: "box second after clock correction" });

  const texts = messages.children.map((message) => message.querySelectorAll(".msg-text")[0].textContent);
  assert.deepEqual(texts, ["local middle", "box first", "box second after clock correction"]);
});

test("Replay keeps the server's causal order when a box clock moved backwards", async () => {
  const entries = [
    { at: 2000, orderAt: 2000, who: "steve", text: "local middle" },
    { at: 3000, orderAt: 3000, who: "box:claude", text: "box first" },
    { at: 1000, orderAt: 3000, who: "box:codex", text: "box second after clock correction" },
  ];
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => url === "/timeline/bounds"
      ? { bounds: { first: 2000, last: 3000, count: 3 } }
      : { entries, states: {}, omitted: 0 },
  });
  const { messages, elements } = bootRoom(fetchImpl);
  elements.get("replay-btn").emit("click");
  for (let i = 0; i < 20 && messages.children.length < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const texts = messages.children.map((message) => message.querySelectorAll(".msg-text")[0].textContent);
  assert.deepEqual(texts, ["local middle", "box first", "box second after clock correction"]);
});

test("an untimed legacy message stays after timed live history", () => {
  const { messages, stream } = bootRoom();
  stream.emit("message", { id: "timed", seq: 1, at: 2000, orderAt: 2000, who: "steve", text: "timed" });
  stream.emit("message", { id: "untimed", seq: 2, at: 0, orderAt: 0, who: "steve", text: "untimed legacy" });

  const texts = messages.children.map((message) => message.querySelectorAll(".msg-text")[0].textContent);
  assert.deepEqual(texts, ["timed", "untimed legacy"]);
});

test("a timed live message inserts before an existing untimed legacy message", () => {
  const { messages, stream } = bootRoom();
  stream.emit("message", { id: "untimed", seq: 1, at: 0, orderAt: 0, who: "steve", text: "untimed legacy" });
  stream.emit("message", { id: "timed", seq: 2, at: 2000, orderAt: 2000, who: "steve", text: "timed" });

  const texts = messages.children.map((message) => message.querySelectorAll(".msg-text")[0].textContent);
  assert.deepEqual(texts, ["timed", "untimed legacy"]);
});
