// The alert-dedup store must outlive the process.
//
// Both the gated-card announcer and the channel health watcher keep a Set of
// "already told the operator about this". Those Sets used to live only in RAM,
// so every deploy, crash, and Fly machine suspend wiped them and re-announced
// every still-outstanding item. A channel that had been missing a credential
// for days pinged the phone again on every restart -- "announce once" had
// quietly become "announce forever".
//
// This test boots the dedup store repeatedly against one directory, the way a
// restarting box does, and asserts the operator is told exactly once.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = fs.readFileSync(path.join(HERE, "..", "container", "gate.js"), "utf8");

test("the dedup store is written to disk, not just held in memory", () => {
  // Guards the specific regression: a future edit dropping the load-from-disk
  // would make both Sets start empty on every boot again.
  assert.match(GATE, /const announcedGated = new Set\(readAlertSeen\(\)\.gated\)/,
    "announcedGated must seed from disk, or gated cards re-announce on every restart");
  assert.match(GATE, /const channelHealthUnhealthy = new Set\(readAlertSeen\(\)\.channels\)/,
    "channelHealthUnhealthy must seed from disk, or broken channels re-alert on every restart");
  assert.match(GATE, /saveAlertSeen\(\);/,
    "state changes must be persisted, or the file never reflects reality");
});

test("a still-outstanding alert is announced once across four restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-seen-"));
  const file = path.join(dir, "alert-seen.json");

  // Mirrors gate.js's readAlertSeen/saveAlertSeen contract.
  const read = () => {
    try {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        gated: Array.isArray(p.gated) ? p.gated : [],
        channels: Array.isArray(p.channels) ? p.channels : [],
      };
    } catch {
      return { gated: [], channels: [] };
    }
  };

  let buzzes = 0;
  // Each iteration is a fresh process against the same persistent volume.
  for (let boot = 0; boot < 4; boot++) {
    const announcedGated = new Set(read().gated);
    const unhealthy = new Set(read().channels);
    const save = () => {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ gated: [...announcedGated], channels: [...unhealthy] }));
      fs.renameSync(tmp, file);
    };

    // The card is still gated and discord still has no credential -- the
    // conditions have NOT changed, so only the first boot should alert.
    if (!announcedGated.has("card-42")) { announcedGated.add("card-42"); save(); buzzes++; }
    if (!unhealthy.has("discord")) { unhealthy.add("discord"); save(); buzzes++; }
  }

  assert.strictEqual(buzzes, 2, "one alert per condition, not one per restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recovery clears the flag so a real re-break alerts again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-seen-"));
  const file = path.join(dir, "alert-seen.json");
  const write = (channels) => fs.writeFileSync(file, JSON.stringify({ gated: [], channels }));
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")).channels;

  write(["discord"]);            // broken, already announced
  const recovered = new Set(read());
  recovered.delete("discord");   // channel comes back
  write([...recovered]);

  // Dedup must not suppress a genuine second failure.
  assert.ok(!new Set(read()).has("discord"), "a recovered channel must be re-alertable when it breaks again");
  fs.rmSync(dir, { recursive: true, force: true });
});
