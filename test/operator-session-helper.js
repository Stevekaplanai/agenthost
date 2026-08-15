export async function mintOperatorSession(base, key, options = {}) {
  const origin = options.origin || base;
  const response = await fetch(base + "/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      ...(options.headers || {}),
    },
    body: JSON.stringify({ key }),
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status !== 204) {
    throw new Error(`operator session mint failed (${response.status}): ${text.slice(0, 512)}`);
  }
  const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (!/^agenthost_auth=/.test(cookie)) {
    throw new Error("operator session mint succeeded without an agenthost_auth cookie");
  }
  return { cookie, response };
}
