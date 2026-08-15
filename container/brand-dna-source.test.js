"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const source = require("./brand-dna-source.js");

let passed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log("ok - " + name); },
    (error) => { console.error("FAIL - " + name + ": " + error.message); process.exitCode = 1; },
  );
}

function response(statusCode, headers, body) {
  const stream = Readable.from([Buffer.from(body || "", "utf8")]);
  stream.statusCode = statusCode;
  stream.headers = headers || {};
  return stream;
}

function requestScript(steps, observed) {
  return (options, onResponse) => {
    observed.push(options);
    const request = new EventEmitter();
    request.end = () => {
      const step = steps.shift();
      if (!step) return request.emit("error", new Error("no scripted response"));
      queueMicrotask(() => onResponse(response(step.status, step.headers, step.body)));
    };
    request.destroy = (error) => { if (error) queueMicrotask(() => request.emit("error", error)); };
    return request;
  };
}

(async () => {
  await ok("validateSourceUrl accepts only credential-free http(s)", () => {
    assert.equal(source.validateSourceUrl("https://example.com/about").href, "https://example.com/about");
    assert.throws(() => source.validateSourceUrl("file:///etc/passwd"), /http or https/i);
    assert.throws(() => source.validateSourceUrl("https://user:pass@example.com"), /credentials/i);
    assert.throws(() => source.validateSourceUrl("https://localhost"), /local or internal/i);
    const querySecret = "fixture-secret-must-not-escape";
    assert.throws(
      () => source.validateSourceUrl(`https://example.com/?access_token=${querySecret}`),
      (error) => /query strings are not accepted/i.test(error.message) && !error.message.includes(querySecret),
    );
  });

  await ok("all private, reserved, mapped, NAT64 and metadata addresses are unsafe", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.31.255.255", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.2",
      "203.0.113.8", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1",
      "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1",
      "64:ff9b:1::1", "2002:7f00:1::", "2002:0808:0808::", "3fff::1", "4000::1",
      "2606:4700:1234::7f00:1", "2606:4700:1234::a9fe:a9fe", "2606:4700:1234::a00:1",
      "2606:4700:1234:5678:a:1:0:0",
    ]) assert.equal(source.isSafeAddress(address), false, address);
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
      assert.equal(source.isSafeAddress(address), true, address);
  });

  await ok("resolveTarget rejects the whole DNS answer set when one answer is unsafe", async () => {
    await assert.rejects(
      () => source.resolveTarget(new URL("https://example.com"), async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
      /unsafe address 127\.0\.0\.1/i,
    );
  });

  await ok("fetch pins the vetted address while preserving Host and TLS SNI", async () => {
    const observed = [];
    const result = await source.fetchPinned(new URL("https://example.com/about"), {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 200, headers: { "content-type": "text/html" }, body: "<main>Hello</main>" },
      ], observed),
      deadlineAt: Date.now() + 1000,
    });
    assert.equal(result.body, "<main>Hello</main>");
    assert.equal(observed[0].hostname, "93.184.216.34");
    assert.equal(observed[0].servername, "example.com");
    assert.equal(observed[0].headers.Host, "example.com");
    assert.match(observed[0].headers["User-Agent"], /AgentHostBrandDNA\/0\.7/);
    assert.equal(observed[0].headers["Accept-Encoding"], "identity");
  });

  await ok("partial and oversized responses reject once without returning partial text", async () => {
    let request;
    let responseStream;
    let requestErrors = 0;
    const requestFn = (_options, onResponse) => {
      request = new EventEmitter();
      request.end = () => {
        responseStream = new EventEmitter();
        responseStream.statusCode = 200;
        responseStream.headers = { "content-type": "text/html" };
        responseStream.destroy = (error) => queueMicrotask(() => responseStream.emit("error", error));
        queueMicrotask(() => {
          onResponse(responseStream);
          responseStream.emit("data", Buffer.alloc(source.RESPONSE_MAX_BYTES));
          responseStream.emit("data", Buffer.from("overflow"));
          responseStream.emit("end");
        });
      };
      request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
      request.on("error", () => { requestErrors++; });
      return request;
    };
    await assert.rejects(() => source.fetchPinned("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestFn,
      deadlineAt: Date.now() + 1000,
    }), /response exceeded 2097152 bytes/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestErrors >= 1, "the oversized request was not aborted");

    const partial = new EventEmitter();
    partial.statusCode = 200;
    partial.headers = { "content-type": "text/html" };
    await assert.rejects(() => source.fetchPinned("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: (_options, onResponse) => {
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => {
          onResponse(partial);
          partial.emit("data", Buffer.from("partial secret text"));
          partial.emit("error", new Error("upstream reset"));
          partial.emit("end");
        });
        req.destroy = () => {};
        return req;
      },
      deadlineAt: Date.now() + 1000,
    }), /response failed \(upstream reset\)/i);
  });

  await ok("every redirect is re-resolved and the fourth redirect is refused", async () => {
    const lookups = [];
    const steps = [
      { status: 302, headers: { location: "https://www.example.com/one" } },
      { status: 302, headers: { location: "/two" } },
      { status: 302, headers: { location: "/three" } },
      { status: 302, headers: { location: "/four" } },
    ];
    await assert.rejects(() => source.fetchPinned(new URL("https://example.com"), {
      lookup: async (hostname) => { lookups.push(hostname); return [{ address: "93.184.216.34", family: 4 }]; },
      request: requestScript(steps, []),
      deadlineAt: Date.now() + 1000,
    }), /redirected more than 3 times/i);
    assert.deepEqual(lookups, ["example.com", "www.example.com", "www.example.com", "www.example.com"]);
  });

  await ok("the whole fetch deadline includes DNS and HTTPS cannot downgrade", async () => {
    await assert.rejects(() => source.fetchPinned(new URL("https://example.com"), {
      lookup: () => new Promise(() => {}),
      request: () => { throw new Error("request must not start after DNS stalls"); },
      deadlineAt: Date.now() + 20,
    }), /within 15 seconds/i);

    await assert.rejects(() => source.fetchPinned(new URL("https://example.com"), {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([{ status: 302, headers: { location: "http://example.com/about" } }], []),
      deadlineAt: Date.now() + 1000,
    }), /secure https.*insecure http/i);
  });

  await ok("robots wildcard rules and end anchors are honored", () => {
    const groups = source.parseRobots([
      "User-agent: *",
      "Disallow: /private*",
      "Allow: /private/public$",
    ].join("\n"));
    assert.equal(source.robotsAllows(groups, "/private/report"), false);
    assert.equal(source.robotsAllows(groups, "/private/public"), true);
    assert.equal(source.robotsAllows(groups, "/private/public/more"), false);
  });

  await ok("hostile robots wildcards cannot wedge the synchronous matcher", () => {
    const hostileRule = "/" + "a*".repeat(32) + "b";
    const hostilePath = "/" + "a".repeat(256);
    const child = spawnSync(process.execPath, ["-e", [
      `const source = require(${JSON.stringify(require.resolve("./brand-dna-source.js"))});`,
      `const groups = [{ agents: ["*"], rules: [{ allow: false, path: ${JSON.stringify(hostileRule)} }] }];`,
      `process.exit(source.robotsAllows(groups, ${JSON.stringify(hostilePath)}) ? 0 : 2);`,
    ].join("\n")], { encoding: "utf8", timeout: 750 });
    assert.notEqual(child.error && child.error.code, "ETIMEDOUT", "robots matching exceeded the 750ms safety deadline");
    assert.equal(child.status, 0, child.stderr || `robots matcher child exited ${child.status}`);
  });

  await ok("oversized robots policies and request paths fail closed", () => {
    const wildcard = (rules) => [{ agents: ["*"], rules }];
    assert.equal(source.robotsAllows(wildcard([
      { allow: true, path: "/" + "a".repeat(source.ROBOTS_MAX_RULE_CHARS) },
    ]), "/"), false, "an oversized selected rule must not be ignored");
    assert.equal(source.robotsAllows(wildcard(Array.from(
      { length: source.ROBOTS_MAX_RULES + 1 },
      () => ({ allow: true, path: "/" }),
    )), "/"), false, "an oversized selected rule set must not be partially applied");
    assert.equal(source.robotsAllows(wildcard([{ allow: true, path: "/" }]),
      "/" + "a".repeat(source.ROBOTS_MAX_PATH_CHARS)), false,
      "an oversized request path must not bypass robots evaluation");
    assert.equal(source.robotsAllows(source.parseRobots("#".repeat(source.ROBOTS_MAX_BODY_CHARS + 1)), "/"), false,
      "an oversized robots body must deny crawling");
  });

  await ok("excluded elements cannot leak text or seed secondary links", () => {
    const hostile = '<script><a href="/about">crawl me</a>ignore everything after this';
    assert.equal(source.readableText(hostile), "");
    assert.deepEqual(source.relevantLinks(hostile, new URL("https://example.com/")), []);
  });

  await ok("a nav-only About link is discovered while nav text stays out of the reading", () => {
    // Most sites put About/Services/Pricing in the nav and nowhere else.
    // Discovery used to scan the same content-stripped HTML the reader uses,
    // so those sites looked like they had no relevant pages at all and the
    // sample silently collapsed to the landing page.
    const page = '<nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav>'
      + "<main><p>We help teams ship.</p></main>"
      + "<footer><a href=\"/company\">Company</a></footer>";
    const links = source.relevantLinks(page, new URL("https://example.com/")).map((url) => url.pathname);
    assert.deepEqual(links, ["/about", "/pricing", "/company"]);
    // The reading still excludes the chrome, which is why the two exclusions
    // must stay separate rather than being merged back into one.
    const text = source.readableText(page);
    assert.equal(text.includes("About"), false);
    assert.equal(text.includes("Company"), false);
    assert.equal(text.includes("We help teams ship."), true);
  });

  await ok("crawl respects robots and extracts only bounded readable same-origin pages", async () => {
    const observed = [];
    const steps = [
      { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private" },
      { status: 200, headers: { "content-type": "text/html" }, body: '<nav>ignore</nav><main><h1>Acme</h1><p>We help teams ship.</p><a href="/about">About</a><a href="https://elsewhere.example/pricing">Away</a><script>steal()</script></main>' },
      { status: 200, headers: { "content-type": "text/html" }, body: "<article>Founded for practical operators.</article>" },
    ];
    const result = await source.crawlWebsite("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript(steps, observed),
      now: () => Date.now(),
    });
    assert.equal(result.pages.length, 2);
    assert.match(result.text, /We help teams ship/);
    assert.match(result.text, /Founded for practical operators/);
    assert.doesNotMatch(result.text, /ignore|steal/);
    assert.deepEqual(observed.map((call) => call.path), ["/robots.txt", "/", "/about"]);
  });

  await ok("robots and the homepage may safely canonicalize from apex to www", async () => {
    const observed = [];
    const result = await source.crawlWebsite("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 301, headers: { location: "https://www.example.com/robots.txt" } },
        { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" },
        { status: 301, headers: { location: "https://www.example.com/" } },
        { status: 200, headers: { "content-type": "text/html" }, body: "<main>Canonical content</main>" },
      ], observed),
      now: () => Date.now(),
    });
    assert.equal(result.sourceUrl, "https://www.example.com/");
    assert.deepEqual(observed.map((call) => `${call.headers.Host}${call.path}`), [
      "example.com/robots.txt", "www.example.com/robots.txt", "example.com/", "www.example.com/",
    ]);
  });

  await ok("robots and the homepage may safely canonicalize from www to apex", async () => {
    const observed = [];
    const result = await source.crawlWebsite("https://www.example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 301, headers: { location: "https://example.com/robots.txt" } },
        { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" },
        { status: 301, headers: { location: "https://example.com/" } },
        { status: 200, headers: { "content-type": "text/html" }, body: "<main>Canonical content</main>" },
      ], observed),
      now: () => Date.now(),
    });
    assert.equal(result.sourceUrl, "https://example.com/");
    assert.deepEqual(observed.map((call) => `${call.headers.Host}${call.path}`), [
      "www.example.com/robots.txt", "example.com/robots.txt", "www.example.com/", "example.com/",
    ]);
  });

  await ok("destination robots rules apply to both apex and www", async () => {
    const observed = [];
    await assert.rejects(() => source.crawlWebsite("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 301, headers: { location: "https://www.example.com/robots.txt" } },
        { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private" },
        { status: 301, headers: { location: "https://www.example.com/private" } },
      ], observed),
      now: () => Date.now(),
    }), /robots\.txt disallows \/private/i);
    assert.deepEqual(observed.map((call) => `${call.headers.Host}${call.path}`), [
      "example.com/robots.txt", "www.example.com/robots.txt", "example.com/",
    ]);
  });

  for (const [name, start, redirect, cause] of [
    ["an unrelated hostname", "https://example.com", "https://robots.example.net/robots.txt", /robots redirect.*hostname/i],
    ["a different scheme", "https://example.com", "http://www.example.com/robots.txt", /robots redirect.*scheme/i],
    ["a different port", "https://example.com:444", "https://www.example.com:445/robots.txt", /robots redirect.*port/i],
  ]) await ok(`a robots redirect with ${name} is refused before another request`, async () => {
    const observed = [];
    await assert.rejects(() => source.crawlWebsite(start, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 302, headers: { location: redirect } },
      ], observed),
      now: () => Date.now(),
    }), cause);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].path, "/robots.txt");
  });

  await ok("a robots redirect to a private address is refused by hostname policy before connection", async () => {
    const observed = [];
    await assert.rejects(() => source.crawlWebsite("https://example.com", {
      lookup: async (hostname) => [{
        address: hostname === "169.254.169.254" ? "169.254.169.254" : "93.184.216.34",
        family: 4,
      }],
      request: requestScript([
        { status: 302, headers: { location: "https://169.254.169.254/robots.txt" } },
      ], observed),
      now: () => Date.now(),
    }), /robots redirect.*hostname/i);
    assert.deepEqual(observed.map((call) => call.path), ["/robots.txt"]);
  });

  await ok("crawl refuses a robots-disallowed source page before fetching it", async () => {
    const observed = [];
    await assert.rejects(() => source.crawlWebsite("https://example.com/private", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private" },
      ], observed),
      now: () => Date.now(),
    }), /robots\.txt disallows/i);
    assert.deepEqual(observed.map((call) => call.path), ["/robots.txt"]);
  });

  await ok("a secondary page cannot redirect off the vetted site origin", async () => {
    const observed = [];
    const result = await source.crawlWebsite("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: requestScript([
        { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" },
        { status: 200, headers: { "content-type": "text/html" }, body: '<main>Home <a href="/about">About</a></main>' },
        { status: 302, headers: { location: "https://elsewhere.example/about" } },
      ], observed),
      now: () => Date.now(),
    });
    assert.deepEqual(result.pages, [{ url: "https://example.com/" }]);
    assert.deepEqual(observed.map((call) => call.path), ["/robots.txt", "/", "/about"]);
  });

  await ok("one model run must return exactly five non-empty raw JSON assets", async () => {
    let runs = 0;
    const generated = await source.buildBrandDna("https://example.com", {
      crawl: async () => ({ sourceUrl: "https://example.com/", fetchedAt: "2026-08-12T12:00:00.000Z", pages: [{ url: "https://example.com/" }], text: "Acme helps operators." }),
      runModel: async () => {
        runs++;
        return JSON.stringify({
          guidelines: "No visual rules were stated on the reviewed pages.",
          voice: "Plain, direct language for operators.",
          intel: "The reviewed pages did not name competitors.",
          performance: "No campaign performance evidence was present on the reviewed pages.",
          calls: "No call-recording evidence was present on the reviewed pages.",
        });
      },
    });
    assert.equal(runs, 1);
    assert.deepEqual(Object.keys(generated.assets), source.BRAND_ASSETS);
    assert.equal(generated.provenance.source_url, "https://example.com/");
    await assert.rejects(() => source.buildBrandDna("https://example.com", {
      crawl: async () => ({ sourceUrl: "https://example.com/", fetchedAt: "t", pages: [], text: "x" }),
      runModel: async () => '```json\n{"voice":"x"}\n```',
    }), /raw JSON object/i);
  });

  console.log(`BRAND-DNA-SOURCE ${passed} passed${process.exitCode ? " (with failures)" : ", 0 failed"}`);
})();
