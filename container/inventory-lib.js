"use strict";

// Shared, dependency-free inventory truth helpers. The live gate and the
// laptop discovery report use this same normalization contract so a configured
// connector cannot become "connected" merely because a different surface read
// the file. No helper in this module reads or changes laptop content.

const INVENTORY_KINDS = new Set(["skill", "plugin", "mcp", "tool"]);
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const compareText = (a, b) => String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
const SECRET_SHAPES = Object.freeze([
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj|or|svcacct)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\b(?:xox[baprs]-|xapp-|xoxe[.-])[A-Za-z0-9.-]{10,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{15,}=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:api[-_ ]?key|token|secret|password|credential|authorization)\s*[:=]\s*["']?[^\s"',;]{4,}/i,
]);

function inventoryTextLooksSensitive(value) {
  const text = String(value || "");
  return SECRET_SHAPES.some((pattern) => pattern.test(text));
}

function parseTomlDottedKey(raw) {
  const input = String(raw || "");
  const parts = [];
  let index = 0;
  const skipSpace = () => { while (/\s/.test(input[index] || "")) index += 1; };
  while (index < input.length) {
    skipSpace();
    if (index >= input.length) return null;
    let part = "";
    const quote = input[index] === '"' || input[index] === "'" ? input[index++] : null;
    if (quote) {
      let closed = false;
      while (index < input.length) {
        const char = input[index++];
        if (char === quote) { closed = true; break; }
        if (quote === '"' && char === "\\" && index < input.length) {
          const escaped = input[index++];
          if (escaped !== '"' && escaped !== "\\") return null;
          part += escaped;
        } else {
          part += char;
        }
      }
      if (!closed) return null;
    } else {
      const start = index;
      while (index < input.length && input[index] !== ".") index += 1;
      part = input.slice(start, index).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
    }
    if (!part || /[\u0000-\u001f\u007f]/.test(part)) return null;
    parts.push(part);
    skipSpace();
    if (index >= input.length) break;
    if (input[index] !== ".") return null;
    index += 1;
  }
  return parts;
}

function tomlStructuralLines(text) {
  const structural = [];
  let multiline = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const startedInsideMultiline = multiline !== null;
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (multiline) {
        if (!line.startsWith(multiline, index)) continue;
        if (multiline === '"""') {
          let backslashes = 0;
          for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) backslashes += 1;
          if (backslashes % 2 === 1) { index += 2; continue; }
        }
        multiline = null;
        index += 2;
        continue;
      }
      if (quote) {
        if (quote === '"' && char === "\\") { index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === "#") break;
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        multiline = line.slice(index, index + 3);
        index += 2;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
    }
    if (!startedInsideMultiline) structural.push(line);
  }
  return structural;
}

function parseCodexMcpNamesText(text) {
  const names = new Set();
  for (const line of tomlStructuralLines(text)) {
    const header = line.match(/^\s*\[(?!\[)(.*?)\]\s*(?:#.*)?$/);
    if (!header) continue;
    const parts = parseTomlDottedKey(header[1]);
    // A nested table such as [mcp_servers.foo.http_headers] proves only that a
    // child table exists. It does not prove that foo has a runnable MCP entry.
    if (!parts || parts.length !== 2 || parts[0] !== "mcp_servers") continue;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(parts[1])) names.add(parts[1]);
  }
  return [...names].sort(compareText);
}

function aliasForConnector(connector, aliases) {
  if (!aliases) return null;
  const value = aliases instanceof Map ? aliases.get(connector) : aliases[connector];
  const alias = String(value || "").trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(alias) ? alias : null;
}

function parseInventoryTool(rawName, connectorAliases = null) {
  const head = String(rawName || "").split("(")[0].trim();
  if (inventoryTextLooksSensitive(head)) return null;
  if (!/^[A-Za-z][A-Za-z0-9_. -]{0,159}$/.test(head)) return null;
  if (!head.startsWith("mcp__")) {
    return { name: head, label: head, connector: null, tool: null };
  }
  const rest = head.slice(5);
  const cut = rest.indexOf("__");
  if (cut <= 0) return null;
  let connector = rest.slice(0, cut);
  const tool = rest.slice(cut + 2);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(connector) ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(tool)) return null;
  if (UUID_RE.test(connector)) {
    connector = aliasForConnector(connector, connectorAliases);
    if (!connector) return null;
  }
  return {
    name: `mcp__${connector}__${tool}`,
    label: `${connector} / ${tool}`,
    connector,
    tool,
  };
}

function parseCodexEnabledToolNamesText(text) {
  const names = [];
  let inTools = false;
  for (const line of tomlStructuralLines(text)) {
    const table = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      inTools = table[1].trim() === "tools";
      continue;
    }
    if (!inTools) continue;
    const enabled = line.trim().match(/^([A-Za-z][A-Za-z0-9_.-]{0,95})\s*=\s*true(?:\s*#.*)?$/i);
    if (enabled) names.push(enabled[1]);
  }
  return [...new Set(names)].sort(compareText);
}

function canonicalName(value) {
  return String(value || "").trim().toLowerCase();
}

function truthFrom(values) {
  if (values.some((value) => value === true)) return true;
  if (values.some((value) => value === false)) return false;
  return null;
}

function deterministicText(values, fallback = "") {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length || compareText(a, b))[0] || fallback;
}

function normalizeInventory(records) {
  const groups = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    if (!raw || !INVENTORY_KINDS.has(raw.kind)) continue;
    const canonical = canonicalName(raw.canonicalName || raw.name || raw.id);
    if (!canonical || !/^[a-z0-9][a-z0-9@._ /-]{0,179}$/.test(canonical)) continue;
    const key = `${raw.kind}:${canonical}`;
    if (!groups.has(key)) groups.set(key, {
      key,
      kind: raw.kind,
      canonicalName: canonical,
      names: [],
      descriptions: [],
      statuses: [],
      sources: new Set(),
      configured: [],
      available: [],
      runtimeConnected: [],
      enabled: [],
      duplicateOf: new Set(),
      tools: new Set(),
    });
    const group = groups.get(key);
    group.names.push(raw.name || raw.id || canonical);
    group.descriptions.push(raw.description);
    group.statuses.push(raw.status);
    const sources = Array.isArray(raw.sources) ? raw.sources : [raw.source];
    for (const source of sources) {
      const clean = String(source || "").trim();
      if (clean) group.sources.add(clean);
    }
    group.configured.push(raw.configured ?? null);
    group.available.push(raw.available ?? null);
    group.runtimeConnected.push(raw.runtimeConnected ?? null);
    group.enabled.push(raw.enabled ?? null);
    if (raw.duplicateOf) group.duplicateOf.add(String(raw.duplicateOf).trim().toLowerCase());
    for (const tool of Array.isArray(raw.tools) ? raw.tools : []) {
      const clean = String(tool || "").trim();
      if (clean) group.tools.add(clean);
    }
  }

  return [...groups.values()].sort((a, b) => compareText(a.key, b.key)).map((group) => {
    const sources = [...group.sources].sort(compareText);
    const duplicateOf = [...group.duplicateOf].sort(compareText)[0] || null;
    const tools = [...group.tools].sort(compareText);
    const row = {
      key: group.key,
      kind: group.kind,
      canonicalName: group.canonicalName,
      name: deterministicText(group.names, group.canonicalName),
      description: deterministicText(group.descriptions),
      sources,
      configured: truthFrom(group.configured),
      available: truthFrom(group.available),
      runtimeConnected: truthFrom(group.runtimeConnected),
      duplicateOf,
    };
    const status = deterministicText(group.statuses);
    const enabled = truthFrom(group.enabled);
    if (status) row.status = status;
    if (enabled !== null) row.enabled = enabled;
    if (tools.length) row.tools = tools;
    return row;
  });
}

function buildConsolidationProposal(records, options = {}) {
  const curated = new Set((options.curatedKeys || []).map((key) => String(key).trim().toLowerCase()));
  const rows = normalizeInventory(records).map((item) => {
    let recommendation = "review";
    let reason = "Evidence shows this item exists, but not enough to safely consolidate or archive it.";
    if (item.enabled === false) {
      recommendation = "archive";
      reason = "Operator-review recommendation only: explicitly disabled in configuration. Archive only after the operator confirms it is no longer needed; this proposal applies nothing.";
    } else if (item.duplicateOf) {
      recommendation = "merge";
      reason = `An authoritative alias points to ${item.duplicateOf}; merge only after the operator confirms the target.`;
    } else if (curated.has(item.key) || item.runtimeConnected === true) {
      recommendation = "keep";
      reason = curated.has(item.key)
        ? "Part of the AgentHost curated starter stack."
        : "A runtime probe observed this item connected.";
    } else if (item.sources.length > 1) {
      reason = `This item appears in ${item.sources.length} sources, but separate agent configurations may be intentional; review them without assuming duplication.`;
    }
    return {
      key: item.key,
      kind: item.kind,
      canonicalName: item.canonicalName,
      sources: item.sources,
      configured: item.configured,
      available: item.available,
      runtimeConnected: item.runtimeConnected,
      duplicateOf: item.duplicateOf,
      recommendation,
      reason,
      operatorDecision: "",
    };
  });
  return {
    schemaVersion: 1,
    summary: "Read-only consolidation proposal. No files, configs, plugins, skills, tools, or connectors were changed.",
    rows,
  };
}

function markdownCell(value) {
  if (value == null) return "unknown";
  if (Array.isArray(value)) return value.length ? value.join("<br>") : "none";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderConsolidationMarkdown(proposal) {
  const rows = proposal && Array.isArray(proposal.rows) ? proposal.rows : [];
  return [
    "# Inventory consolidation proposal",
    "",
    "This is a read-only proposal. Nothing on the laptop was deleted, moved, disabled, or rewritten. Fill in **Operator decision** before any later apply step is designed or run.",
    "",
    "`unknown` means the discovery source did not prove that state. In particular, configuration does not prove a live runtime connection.",
    "",
    "| Key | Sources | Configured | Available | Runtime connected | Duplicate of | Recommendation | Reason | Operator decision |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${markdownCell(row.key)} | ${markdownCell(row.sources)} | ${markdownCell(row.configured)} | ${markdownCell(row.available)} | ${markdownCell(row.runtimeConnected)} | ${markdownCell(row.duplicateOf)} | ${markdownCell(row.recommendation)} | ${markdownCell(row.reason)} |  |`),
    "",
  ].join("\n");
}

module.exports = {
  parseCodexMcpNamesText,
  parseCodexEnabledToolNamesText,
  parseInventoryTool,
  inventoryTextLooksSensitive,
  normalizeInventory,
  buildConsolidationProposal,
  renderConsolidationMarkdown,
};
