// Pure-function tests for `agenthost bridge` (src/commands/bridge.js).
// The tailscale/flyctl plumbing is exercised live; these lock down the
// parsers those flows depend on, against output shapes captured from a real
// Windows machine (tailscale 1.98.4) on 2026-07-14.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFunnelApprovalUrl, parseFunnelUrl, validateBridgePort } from "../src/commands/bridge.js";

const NOT_ENABLED = `
Funnel is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/funnel?node=n6gg7Kueq521CNTRL

`;

const FUNNEL_STATUS = `# Funnel on:
#     - https://desktop-70brf7t.tail4bf092.ts.net

https://desktop-70brf7t.tail4bf092.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:27123
`;

test("approval URL is extracted from the not-enabled response", () => {
  assert.equal(
    parseFunnelApprovalUrl(NOT_ENABLED),
    "https://login.tailscale.com/f/funnel?node=n6gg7Kueq521CNTRL"
  );
});

test("no approval URL when funnel is already enabled", () => {
  assert.equal(parseFunnelApprovalUrl(FUNNEL_STATUS), null);
  assert.equal(parseFunnelApprovalUrl(""), null);
  assert.equal(parseFunnelApprovalUrl(undefined), null);
});

test("public URL is matched to its proxied port", () => {
  assert.equal(
    parseFunnelUrl(FUNNEL_STATUS, 27123),
    "https://desktop-70brf7t.tail4bf092.ts.net"
  );
});

test("no URL for a port the funnel does not serve", () => {
  assert.equal(parseFunnelUrl(FUNNEL_STATUS, 8080), null);
  assert.equal(parseFunnelUrl("No serve config", 27123), null);
  assert.equal(parseFunnelUrl("", 27123), null);
});

test("port matching is exact, not prefix (27123 must not match 2712)", () => {
  assert.equal(parseFunnelUrl(FUNNEL_STATUS, 2712), null);
});

test("multi-host status picks the host serving the requested port", () => {
  const multi = `https://desktop-aaa.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:3000

https://desktop-bbb.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:27123
`;
  assert.equal(parseFunnelUrl(multi, 27123), "https://desktop-bbb.ts.net");
  assert.equal(parseFunnelUrl(multi, 3000), "https://desktop-aaa.ts.net");
});

test("port validation accepts real ports and rejects junk", () => {
  assert.equal(validateBridgePort("27123"), 27123);
  assert.equal(validateBridgePort(443), 443);
  for (const bad of ["0", "65536", "abc", "", undefined, "12.5"]) {
    assert.throws(() => validateBridgePort(bad), /not a valid port/);
  }
});
