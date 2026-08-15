"use strict";

// Dormant Foundation-B candidate: the framed socket transport (BUILD-PLAN Phase
// 1f, Step 4d infrastructure). Two halves of the wire between the gate-side
// authority client (4b) and the composition root (4a) over a real stream socket:
//
//   serveConnection({ socket, service })   — PID-1 side. Decodes length-prefixed
//     strict-JSON request frames (via the protocol's one-in-flight, deadline-armed
//     RequestFrameDecoder), calls service.handle(request), and writes back the
//     framed reply — or destroys the connection when the dispatcher says close
//     (§2 peer/framing/protocol violations revoke the epoch).
//
//   createSocketTransport({ socket })       — gate side. The transport the client
//     speaks through: frame one request, await exactly one response frame, resolve
//     the dispatcher-shaped { action, response }. One request in flight.
//
// This is pure transport: no authority, no validation beyond framing (the service
// runs the real validateRequest/validateResponse). DORMANT: not wired into any
// boot path; the 4d boot edit has PID 1 create the listener and hand accepted
// sockets to serveConnection.

const FOUR = 4;

// PID-1 side: run the framed request/response loop for one accepted connection.
function serveConnection({ socket, service, protocol, onClose = () => {}, now = Date.now } = {}) {
  if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function") throw new Error("serveConnection requires a stream socket");
  if (!service || typeof service.handle !== "function") throw new Error("serveConnection requires a service with handle()");
  if (!protocol || typeof protocol.encodeFrame !== "function") throw new Error("serveConnection requires the protocol module");
  let closed = false;
  // Track pending frame-deadline timers so close() clears them (an un-cleared
  // timer would keep the event loop alive after teardown).
  const timers = new Set();
  const close = (reason) => { if (closed) return; closed = true; for (const t of timers) clearTimeout(t); timers.clear(); try { socket.destroy(); } catch { /* gone */ } onClose(reason); };
  const decoder = new protocol.RequestFrameDecoder({
    onDeadline: () => close("handshake_deadline"),
    now,
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); if (t.unref) t.unref(); return t; },
    cancelSchedule: (t) => { timers.delete(t); clearTimeout(t); },
  });

  socket.on("data", async (chunk) => {
    if (closed) return;
    let request;
    try { request = decoder.push(chunk); }
    catch (error) { return close(`protocol:${(error && error.code) || "error"}`); }
    if (!request) return; // partial frame
    let out;
    try { out = await service.handle(request); }
    catch (error) { return close(`handler:${(error && error.code) || "fault"}`); } // never leak; fail closed
    if (closed) return;
    if (out.action === "close") return close(out.code || "protocol");
    try {
      socket.write(protocol.encodeFrame(out.response, { maxBytes: protocol.RESPONSE_MAX_BYTES }));
      decoder.responseWritten();
    } catch (error) { return close(`write:${(error && error.code) || "error"}`); }
  });
  socket.on("error", () => close("socket_error"));
  socket.on("close", () => close("eof"));
  return { close };
}

// Gate side: a client transport over a connected stream socket. send(request)
// frames it, awaits exactly one response frame, and resolves the dispatcher-shaped
// result. One request in flight per connection (matches the contract).
function createSocketTransport({ socket, protocol } = {}) {
  if (!socket || typeof socket.on !== "function") throw new Error("socket transport requires a stream socket");
  if (!protocol || typeof protocol.encodeFrame !== "function") throw new Error("socket transport requires the protocol module");
  let buffer = Buffer.alloc(0);
  let expected = null;
  let pending = null;   // { resolve, reject }
  let deadClosed = false;

  function settleReject(err) { if (pending) { const p = pending; pending = null; p.reject(err); } }
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      if (expected === null) {
        if (buffer.length < FOUR) return;
        expected = buffer.readUInt32BE(0);
        if (expected === 0 || expected > protocol.RESPONSE_MAX_BYTES) { settleReject(Object.assign(new Error("bad response frame"), { code: "PROTOCOL_ERROR" })); return; }
      }
      if (buffer.length < expected + FOUR) return;
      const payload = buffer.subarray(FOUR, FOUR + expected);
      buffer = buffer.subarray(FOUR + expected);
      expected = null;
      let response;
      try { response = protocol.parseStrictJson(payload); }
      catch (e) { settleReject(Object.assign(new Error("unparseable response"), { code: "PROTOCOL_ERROR" })); return; }
      if (pending) { const p = pending; pending = null; p.resolve({ action: "reply", response }); }
    }
  });
  socket.on("close", () => { deadClosed = true; settleReject(Object.assign(new Error("connection closed"), { code: "PROTOCOL_ERROR" })); });
  socket.on("error", () => settleReject(Object.assign(new Error("socket error"), { code: "PROTOCOL_ERROR" })));

  function send(request) {
    return new Promise((resolve, reject) => {
      if (deadClosed) return reject(Object.assign(new Error("connection closed"), { code: "PROTOCOL_ERROR" }));
      if (pending) return reject(Object.assign(new Error("one request in flight"), { code: "INFLIGHT_VIOLATION" }));
      pending = { resolve, reject };
      try { socket.write(protocol.encodeFrame(request, { maxBytes: protocol.REQUEST_MAX_BYTES })); }
      catch (e) { pending = null; reject(Object.assign(new Error("frame too large"), { code: "FRAME_TOO_LARGE" })); }
    });
  }
  return { send };
}

module.exports = { serveConnection, createSocketTransport };
