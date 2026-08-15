"use strict";

// Dependency-free ZIP writer (STORED / no compression) for gate.js's Artifacts
// "Download all" button. The container image ships no `zip` binary and we won't
// add one (a Dockerfile/apt change = image rebuild = deploy risk); artifacts are
// small markdown/HTML docs, so stored (uncompressed) entries are fine and a .zip
// opens natively on a phone (unlike .tar.gz on iOS). No ZIP64 — entries and the
// archive stay well under 4GB. Pure + synchronous, so it unit-tests off-box.

// Standard CRC-32 (IEEE 802.3), table-driven. Each ZIP entry header carries it.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// zipStore([{ name, data }]) -> one Buffer (the .zip). `data` is a Buffer (or
// coerced). `name` is stored as-is (forward slashes); callers pass safe basenames.
function zipStore(entries) {
  const local = [];   // local file header + name + data, in order
  const central = [];  // central directory records
  let offset = 0;      // running offset of each local header
  const MOD_DATE = 0x0021; // 1980-01-01, a valid DOS date (time/date fixed — no Date dep)

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    const size = data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4);         // version needed to extract
    lh.writeUInt16LE(0, 6);          // general purpose flags
    lh.writeUInt16LE(0, 8);          // compression method: 0 = stored
    lh.writeUInt16LE(0, 10);         // mod time (fixed)
    lh.writeUInt16LE(MOD_DATE, 12);  // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);      // compressed size (== size, stored)
    lh.writeUInt32LE(size, 22);      // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra field length
    local.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header signature
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0, 8);          // flags
    cd.writeUInt16LE(0, 10);         // method
    cd.writeUInt16LE(0, 12);         // mod time
    cd.writeUInt16LE(MOD_DATE, 14);  // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);         // extra len
    cd.writeUInt16LE(0, 32);         // comment len
    cd.writeUInt16LE(0, 34);         // disk number start
    cd.writeUInt16LE(0, 36);         // internal attributes
    cd.writeUInt32LE(0, 38);         // external attributes
    cd.writeUInt32LE(offset, 42);    // relative offset of local header
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const filesBuf = Buffer.concat(local);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // end of central directory signature
  eocd.writeUInt16LE(0, 4);                   // number of this disk
  eocd.writeUInt16LE(0, 6);                   // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);      // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);  // central directory size
  eocd.writeUInt32LE(filesBuf.length, 16);    // central directory offset
  eocd.writeUInt16LE(0, 20);                  // comment length

  return Buffer.concat([filesBuf, centralBuf, eocd]);
}

module.exports = { zipStore, crc32 };
