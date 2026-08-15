// The Files panel (GET /files, GET /files/dl) lets a logged-in human download
// files off the box. It reads real files from disk, so its ONLY job besides
// listing is to never let a crafted path escape the curated allowlist. These
// tests boot the REAL gate and attack the download route: traversal, absolute
// paths, symlink escapes, unknown roots, and no-auth. A regression here is a
// box-filesystem read primitive, so every attack must 4xx and the secrets file
// must be unreachable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-files-test-key";
let box = {};

function bootGate(home) {
  const child = spawn("node", [GATE], {
    env: { ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true", GATE_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gatefiles-"));
  // Seed the allowlisted outbox with a real file.
  fs.mkdirSync(path.join(home, "outbox"), { recursive: true });
  fs.writeFileSync(path.join(home, "outbox", "report.pdf"), "PDFDATA-real-file-here");
  fs.writeFileSync(path.join(home, "outbox", ".hidden"), "should never be listed");
  // Seed a SECRET outside every root -- the thing the allowlist must protect.
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), "POSTIZ_API_KEY=supersecret");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });

  const { child, port } = bootGate(home);
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${await port}`;
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
});

after(async () => {
  await stopChild(box.gate);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

const auth = (p) => fetch(box.base + p, { headers: { cookie: box.cookie }, redirect: "manual" });
const noauth = (p) => fetch(box.base + p, { redirect: "manual" });

test("GET /files lists allowlisted roots and the real outbox file", async () => {
  const r = await auth("/files");
  assert.equal(r.status, 200);
  const data = await r.json();
  const keys = data.roots.map((x) => x.key).sort();
  assert.deepEqual(keys, ["graphics", "inbox", "outbox", "renders", "uploads"], "the five curated roots");
  const outbox = data.roots.find((x) => x.key === "outbox");
  assert.equal(outbox.files.length, 1, "one visible file (dotfile excluded)");
  assert.equal(outbox.files[0].name, "report.pdf");
  assert.equal(outbox.files[0].rel, "outbox/report.pdf");
  assert.ok(!JSON.stringify(data).includes(".hidden"), "dotfiles never listed");
});

test("GET /files/dl serves a previewable file INLINE (so it opens to view, not a stuck download)", async () => {
  // Previewable types (image/PDF) must be inline: a phone that ignores the
  // download attribute would otherwise strand Steve on a stuck attachment
  // preview with no way back to the box (2026-07-18).
  const r = await auth("/files/dl?p=" + encodeURIComponent("outbox/report.pdf"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition") || "", /^inline; filename="report.pdf"/);
  assert.equal(await r.text(), "PDFDATA-real-file-here");
});

test("GET /files/dl serves a non-previewable file as an attachment download", async () => {
  fs.writeFileSync(path.join(box.home, "outbox", "clip.mp4"), "MP4BYTES");
  const r = await auth("/files/dl?p=" + encodeURIComponent("outbox/clip.mp4"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "video/mp4");
  assert.match(r.headers.get("content-disposition") || "", /^attachment; filename="clip.mp4"/);
});

test("path traversal, absolute paths, and unknown roots are all rejected", async () => {
  const attacks = [
    "outbox/../.agenthost/secrets.env",      // climb out of the root
    "outbox/../../etc/passwd",               // climb to system
    "outbox/....//....//.agenthost/secrets.env", // doubled-dot bypass attempt
    "/etc/passwd",                            // no root key
    "..%2f.agenthost%2fsecrets.env",         // encoded traversal, no root
    "secrets/secrets.env",                    // unknown root key
    "outbox",                                 // root with no sub
    "",                                       // empty
  ];
  for (const p of attacks) {
    const r = await auth("/files/dl?p=" + encodeURIComponent(p));
    assert.ok(r.status === 400 || r.status === 404, `attack "${p}" must be blocked, got ${r.status}`);
    if (r.status !== 404) {
      const body = await r.text();
      assert.ok(!body.includes("supersecret"), `attack "${p}" must not leak the secret`);
    }
  }
});

test("the secrets file is structurally unreachable (never in any root)", async () => {
  // Even naming the real root that is CLOSEST to the secret can't reach it,
  // because .agenthost is not one of the roots and traversal is blocked.
  const r = await auth("/files/dl?p=" + encodeURIComponent("uploads/../secrets.env"));
  assert.ok(r.status === 400 || r.status === 404);
});

test("both file routes require login", async () => {
  assert.equal((await noauth("/files")).status, 401);
  assert.equal((await noauth("/files/dl?p=outbox/report.pdf")).status, 401);
});

test("a symlink pointing out of a root does not escape it", async () => {
  // Drop a symlink inside the outbox that targets the secret, then try to
  // download it. realpath resolution must catch that the target is outside.
  const linkPath = path.join(box.home, "outbox", "escape.env");
  try { fs.symlinkSync(path.join(box.home, ".agenthost", "secrets.env"), linkPath); }
  catch { return; } // symlinks unavailable on this FS (e.g. Windows w/o priv): skip
  const r = await auth("/files/dl?p=" + encodeURIComponent("outbox/escape.env"));
  assert.ok(r.status === 400 || r.status === 404, `symlink escape blocked, got ${r.status}`);
  if (r.status !== 404) assert.ok(!(await r.text()).includes("supersecret"));
});

// ---- Upload (POST /files/upload -> ~/inbox): the PC->box pipe. It WRITES to
// disk from an X-Filename header, so a crafted filename must never escape the
// inbox, and bad types / no-auth must be refused. ----

function upload(name, body, opts) {
  const headers = { "X-Filename": name, "Content-Type": "application/octet-stream", origin: box.base };
  if (opts && opts.noauth) { /* omit cookie */ } else headers.cookie = box.cookie;
  return fetch(box.base + "/files/upload", { method: "POST", headers, body });
}

test("a legit upload lands in ~/inbox and appears in the listing", async () => {
  const r = await upload("promo.png", "PNGBYTES-here");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.name, "promo.png");
  assert.equal(d.rel, "inbox/promo.png");
  assert.equal(fs.readFileSync(path.join(box.home, "inbox", "promo.png"), "utf8"), "PNGBYTES-here");
  const list = await (await auth("/files")).json();
  const inbox = list.roots.find((x) => x.key === "inbox");
  assert.ok(inbox.files.some((f) => f.name === "promo.png"), "uploaded file shows in inbox listing");
});

test("a malicious X-Filename is sanitized to a basename inside the inbox", async () => {
  const r = await upload("../../.agenthost/secrets.env", "OVERWRITE-ATTEMPT");
  // Either the ext is rejected (.env not allowed) OR the name is basenamed and
  // written INSIDE the inbox -- never at the traversal target. Both are safe.
  const secretPath = path.join(box.home, ".agenthost", "secrets.env");
  assert.equal(fs.readFileSync(secretPath, "utf8"), "POSTIZ_API_KEY=supersecret", "the real secret is untouched");
  if (r.status === 200) {
    const d = await r.json();
    assert.ok(!d.boxPath.includes(".agenthost"), "never written outside the inbox");
    assert.ok(d.boxPath.replace(/\\/g, "/").includes("/inbox/"), "written inside the inbox");
  } else {
    assert.equal(r.status, 400); // .env type refused
  }
});

test("uploads of unsupported types are refused", async () => {
  for (const bad of ["evil.sh", "run.exe", "x.js", "noext"]) {
    const r = await upload(bad, "x");
    assert.equal(r.status, 400, `${bad} refused`);
  }
});

test("an empty upload and a missing filename are refused", async () => {
  assert.equal((await upload("empty.png", "")).status, 400);
  assert.equal((await upload("", "data")).status, 400);
});

test("upload requires login", async () => {
  const r = await upload("nope.png", "x", { noauth: true });
  assert.equal(r.status, 401);
  assert.ok(!fs.existsSync(path.join(box.home, "inbox", "nope.png")));
});

test("a re-upload of the same name never clobbers the first (collision-safe)", async () => {
  await upload("dup.png", "FIRST");
  const r2 = await upload("dup.png", "SECOND");
  const d2 = await r2.json();
  assert.notEqual(d2.name, "dup.png", "second upload got a suffixed name");
  assert.equal(fs.readFileSync(path.join(box.home, "inbox", "dup.png"), "utf8"), "FIRST", "original preserved");
  assert.equal(fs.readFileSync(path.join(box.home, "inbox", d2.name), "utf8"), "SECOND", "second saved under new name");
});
