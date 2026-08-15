import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const gate = fs.readFileSync("container/gate.js", "utf8")
const growth = fs.readFileSync("container/growth-lib.js", "utf8")
const source = fs.readFileSync("container/brand-dna-source.js", "utf8")
const docker = fs.readFileSync("container/Dockerfile", "utf8")
const profiles = fs.readFileSync("container/maintenance-chat-profiles.js", "utf8")

test("Brand DNA URL generation ships in the image and reaches the fixed model runner", () => {
  assert.match(docker, /COPY brand-dna-source\.js \/opt\/agenthost\/brand-dna-source\.js/)
  assert.match(growth, /asset === "from-url" && req\.method === "POST"/)
  assert.match(gate, /growthLib\.handleGrowth\([\s\S]*?runModel: runBrandDnaModel/)
})

test("attacker-controlled website text has no tools, MCP servers or dangerous permission bypass", () => {
  const legacy = gate.slice(gate.indexOf("function brandDnaSpawnArgs"), gate.indexOf("const BRAND_DNA_ENV_ALLOWLIST"))
  assert.match(legacy, /"--tools", ""/)
  assert.match(legacy, /"--strict-mcp-config"/)
  assert.match(legacy, /"--no-session-persistence"/)
  assert.doesNotMatch(legacy, /dangerously-skip-permissions/)
  const foundation = profiles.slice(profiles.indexOf('"claude-brand-dna":'), profiles.indexOf("// ---- hermes"))
  assert.match(foundation, /arg !== "--dangerously-skip-permissions"/)
  assert.match(foundation, /"--tools", "", "--strict-mcp-config"/)
  assert.match(foundation, /"--no-session-persistence"/)
  // The prompt carries a customer's website copy, so it must not be in argv on
  // EITHER path: argv is readable from any process list and the OS caps its
  // length. Both paths hand it to the engine over stdin instead.
  assert.match(foundation, /arg !== PROMPT/)
  assert.match(foundation, /stdin: "prompt"/)
  assert.doesNotMatch(legacy, /"-p", prompt/)
  assert.match(legacy, /function brandDnaSpawnArgs\(\)/)
  const runner = gate.slice(
    gate.indexOf("function runBrandDnaModel"),
    gate.indexOf("// ---- brain search", gate.indexOf("function runBrandDnaModel")),
  )
  assert.match(runner, /runViaChatSocket\("claude-brand-dna", prompt/)
  assert.doesNotMatch(runner, /runViaChatSocket\("claude-assist", prompt/)
  assert.match(gate.match(/const BRAND_DNA_ENV_ALLOWLIST[\s\S]*?\]\);/)?.[0] || "", /ANTHROPIC_API_KEY/)
})

test("direct Brand DNA accepts either supported Claude credential without carrying other secrets", () => {
  const block = gate.slice(
    gate.indexOf("const BRAND_DNA_ENV_ALLOWLIST"),
    gate.indexOf("const BRAND_DNA_REDACT_ENV_NAMES"),
  )
  const modelEnv = Function(`${block}\nreturn brandDnaModelEnv`)()
  assert.deepEqual(modelEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-only", GITHUB_TOKEN: "drop" }), {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-only",
  })
  assert.deepEqual(modelEnv({ ANTHROPIC_API_KEY: "api-only", GIT_PUSH_TOKEN: "drop" }), {
    ANTHROPIC_API_KEY: "api-only",
  })
})

test("direct Brand DNA stderr redaction deduplicates overlapping values longest-first", () => {
  const block = gate.slice(
    gate.indexOf("const BRAND_DNA_REDACT_ENV_NAMES"),
    gate.indexOf("// Agent prompts use only the newest entries"),
  )
  const redact = Function(`${block}\nreturn redactBrandDnaText`)()
  const shorter = "oauth-overlap-value-123456789"
  const longer = `${shorter}-private-suffix`
  const output = redact(`engine said ${longer}`, {
    CLAUDE_CODE_OAUTH_TOKEN: longer,
    ANTHROPIC_API_KEY: shorter,
  })
  assert.equal(output, "engine said [redacted]")
  assert.doesNotMatch(output, /private-suffix/)
})

test("website pages stay request-local and model output is fully validated before the first write", () => {
  assert.doesNotMatch(source, /require\("fs"\)|writeFile|appendFile|console\./)
  assert.match(source, /parseGeneratedAssets\(raw\)/)
  const generate = growth.slice(growth.indexOf("async function generateDnaFromUrl"), growth.indexOf("// Full extraction"))
  assert.ok(generate.indexOf("const generated = await build") < generate.indexOf("for (const asset of BRAND_ASSETS)"))
  assert.match(generate, /stored \$\{records\.length\} of 5 assets; \$\{asset\} failed/)
})
