// The dependency-free .zip writer behind the Artifacts "Download all" button.
// The image has no `zip` binary, so this code is the archive format itself —
// worth proving byte-exactly. Pure logic; runs anywhere (no Linux, no box).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { zipStore, crc32 } = require("../container/zip-store.js");

test("crc32 matches the standard IEEE check value", () => {
  // The canonical CRC-32 check: crc of the ASCII "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from("123456789")), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0); // empty input -> 0
});

test("zipStore produces a structurally valid archive (signatures + counts)", () => {
  const buf = zipStore([
    { name: "a.md", data: Buffer.from("# Hello\n") },
    { name: "b.txt", data: Buffer.from("second file") },
  ]);
  // Ends with the End-Of-Central-Directory record signature.
  const eocdSig = buf.readUInt32LE(buf.length - 22);
  assert.equal(eocdSig, 0x06054b50, "EOCD signature at the tail");
  assert.equal(buf.readUInt16LE(buf.length - 22 + 10), 2, "total entries == 2");
  // Starts with a local file header signature.
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "first local file header signature");
});

// The real proof: parse the archive back out per the ZIP spec and confirm the
// first entry's name + bytes + CRC round-trip exactly. If the offsets/lengths
// were wrong, this extraction would read garbage.
test("a STORED entry round-trips: name, bytes, and CRC read back correctly", () => {
  const payload = Buffer.from("the actual artifact contents\nline two\n");
  const buf = zipStore([{ name: "doc.md", data: payload }]);

  // Local header: name len @26, extra len @28, name @30, then the stored data.
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(8), 0, "method is STORED (0)");
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const crcInHeader = buf.readUInt32LE(14);
  const size = buf.readUInt32LE(22);
  const name = buf.slice(30, 30 + nameLen).toString("utf8");
  const dataStart = 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + size);

  assert.equal(name, "doc.md");
  assert.equal(size, payload.length);
  assert.deepEqual(data, payload, "stored bytes are the original file, uncompressed");
  assert.equal(crcInHeader, crc32(payload), "header CRC matches the data");
});

test("empty archive is still valid (zero entries)", () => {
  const buf = zipStore([]);
  assert.equal(buf.length, 22, "just the EOCD record");
  assert.equal(buf.readUInt32LE(0), 0x06054b50);
  assert.equal(buf.readUInt16LE(10), 0, "zero entries");
});
