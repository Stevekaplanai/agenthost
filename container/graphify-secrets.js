"use strict";

// One Graphify credential boundary shared by corpus staging, output validation,
// and derived Brand claims. Keys are normalized before matching so camelCase,
// underscore, hyphen, and provider-prefixed forms cannot drift apart.
const TOKEN_SHAPE_RE = /(?:\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:[A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s/@:]*:[^\s/@]+@[^\s/]+)\b|-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----|$))/i;
const BASIC_AUTH_CANDIDATE_RE = /\bBasic\s+([A-Za-z0-9+/]{2,}={0,2})(?![A-Za-z0-9+/=])/gi;
const BEARER_AUTH_CANDIDATE_RE = /\bBearer\s+([A-Za-z0-9._~+\/-]{8,}=*)(?![A-Za-z0-9._~+\/-=])/gi;
const SECRET_KEY_RE = /(?:(?:^|_)(?:api_?key|access_?(?:key|token)|auth(?:orization)?|bearer_?token|client_?secret|cookie|credentials?|pass(?:phrase|word)|private_?key|refresh_?token|signing_?key|encryption_?key|secret|token|(?:database|db|redis|mongo(?:db)?)_?(?:url|uri|dsn)|connection_?string)(?:$|_)|(?:^|_)session(?:$|_?(?:id|token|key)(?:$|_)))/i;
// These scanners consume only an assignment prefix, never its value. That is
// deliberate: a non-secret outer assignment such as `const config = { ... }`
// must not hide a secret assignment nested later on the same line.
const KEY_CODEPOINT_ESCAPE_SOURCE = String.raw`\\u\{[0-9A-Za-z]{0,8}\}`;
const KEY_START_SOURCE = `(?:[A-Za-z_]|\\\\|${KEY_CODEPOINT_ESCAPE_SOURCE})`;
const KEY_BODY_SOURCE = `(?:[A-Za-z0-9_. -]|\\\\|${KEY_CODEPOINT_ESCAPE_SOURCE}){0,127}`;
const KEY_TOKEN_SOURCE = `${KEY_START_SOURCE}${KEY_BODY_SOURCE}`;
const ASSIGNMENT_GAP_SOURCE = String.raw`\s*`;
const ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3${ASSIGNMENT_GAP_SOURCE}([:=])))`, "gim");
const LOGICAL_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3${ASSIGNMENT_GAP_SOURCE}(\\|\\|=|\\?\\?=|&&=)))`, "gim");
const COMPOUND_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3${ASSIGNMENT_GAP_SOURCE}(\\+=|-=|\\*=|\\/=|%=|&=|\\|=|\\^=)))`, "gim");
const OPTIONAL_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3\\?${ASSIGNMENT_GAP_SOURCE}(=)))`, "gim");
const OPTIONAL_TYPED_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3\\?${ASSIGNMENT_GAP_SOURCE}:${ASSIGNMENT_GAP_SOURCE}))`, "gim");
const TYPED_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3\\??${ASSIGNMENT_GAP_SOURCE}:\\s*[A-Za-z_$][A-Za-z0-9_$.[\\] <>|&,?]*\\s*(=)))`, "gim");
const FUNCTION_TYPED_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"\`]?)(${KEY_TOKEN_SOURCE})\\3\\??${ASSIGNMENT_GAP_SOURCE}:\\s*\\([^;{}\\r\\n]*\\)\\s*=>\\s*[A-Za-z_$][A-Za-z0-9_$.[\\] <>|&,?]*\\s*(=)))`, "gim");
const BRACKET_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]${ASSIGNMENT_GAP_SOURCE}([:=])))`, "gim");
const BRACKET_OPTIONAL_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]\\s*\\?${ASSIGNMENT_GAP_SOURCE}(=)))`, "gim");
const BRACKET_OPTIONAL_TYPED_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]\\s*\\?${ASSIGNMENT_GAP_SOURCE}:${ASSIGNMENT_GAP_SOURCE}))`, "gim");
const BRACKET_OPTIONAL_TYPED_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]\\s*\\?${ASSIGNMENT_GAP_SOURCE}:\\s*[A-Za-z_$][A-Za-z0-9_$.[\\] <>|&,?]*\\s*(=)))`, "gim");
const BRACKET_LOGICAL_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]${ASSIGNMENT_GAP_SOURCE}(\\|\\|=|\\?\\?=|&&=)))`, "gim");
const BRACKET_COMPOUND_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=(((?:[A-Za-z_$][A-Za-z0-9_$.-]{0,127})\\s*)?\\[\\s*(['"\`])(${KEY_TOKEN_SOURCE})\\4\\s*\\]${ASSIGNMENT_GAP_SOURCE}(\\+=|-=|\\*=|\\/=|%=|&=|\\|=|\\^=)))`, "gim");
const HASH_QUOTED_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((['"])(` + KEY_TOKEN_SOURCE + String.raw`)\3\s*(=>)))`, "gim");
const HASH_SYMBOL_ASSIGNMENT_PREFIX_RE = new RegExp(`(^|[^A-Za-z0-9])(?=((:)(${KEY_TOKEN_SOURCE})\\s*(=>)))`, "gim");
const DOCKER_ENV_ASSIGNMENT_PREFIX_RE = /^([ \t]*ENV[ \t]+)(?=(([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]+))/gim;
const DEFINE_ASSIGNMENT_PREFIX_RE = /^([ \t]*#[ \t]*define[ \t]+)(?=(([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]+))/gim;
const SQL_PASSWORD_ASSIGNMENT_PREFIX_RE = /(^|[;\r\n])(?=((?:CREATE|ALTER)[ \t]+(?:USER|ROLE)[ \t]+(?:"(?:\\.|[^"\r\n])+"|'(?:''|[^'\r\n])+'|[A-Za-z0-9_.-]+)(?:[ \t]+WITH)?(?:[ \t]+(?:SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|CREATEROLE|NOCREATEROLE|INHERIT|NOINHERIT|LOGIN|NOLOGIN|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS|CONNECTION[ \t]+LIMIT[ \t]+-?[0-9]+|VALID[ \t]+UNTIL[ \t]+(?:"(?:\\.|[^"\r\n])+"|'(?:''|[^'\r\n])+'))){0,32}(?:[ \t]+ENCRYPTED)?[ \t]+(PASSWORD)[ \t]+))/gim;
const KUBERNETES_VALUE_ASSIGNMENT_PREFIX_RE = /(^|[\r\n])(?=((?:[ \t]*-[ \t]+name[ \t]*:[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\3[ \t]*(?:#[^\r\n]*)?\r?\n(?:[ \t]*(?:#[^\r\n]*)?\r?\n){0,16}[ \t]+value[ \t]*:[ \t]*)))/gim;
const CLI_FLAG_ASSIGNMENT_PREFIX_RE = /(^|\s)(?=((--)([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]+))/gim;
const POWERSHELL_ENV_ASSIGNMENT_PREFIX_RE = /(^|[^A-Za-z0-9])(?=((\$env:)([A-Za-z][A-Za-z0-9_.-]{0,127})\s*(=)))/gim;
const ASSIGNMENT_PREFIX_SCANNERS = [
  { regex: CLI_FLAG_ASSIGNMENT_PREFIX_RE, keyGroup: 4, fixedOperator: "cli-flag" },
  { regex: KUBERNETES_VALUE_ASSIGNMENT_PREFIX_RE, keyGroup: 4, fixedOperator: "yaml-value" },
  { regex: SQL_PASSWORD_ASSIGNMENT_PREFIX_RE, keyGroup: 3, fixedOperator: "sql-password" },
  { regex: DOCKER_ENV_ASSIGNMENT_PREFIX_RE, keyGroup: 3, fixedOperator: "docker-env" },
  { regex: DEFINE_ASSIGNMENT_PREFIX_RE, keyGroup: 3, fixedOperator: "define" },
  { regex: HASH_QUOTED_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: HASH_SYMBOL_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: BRACKET_LOGICAL_ASSIGNMENT_PREFIX_RE, keyGroup: 5, operatorGroup: 6 },
  { regex: BRACKET_COMPOUND_ASSIGNMENT_PREFIX_RE, keyGroup: 5, operatorGroup: 6 },
  { regex: BRACKET_OPTIONAL_TYPED_ASSIGNMENT_PREFIX_RE, keyGroup: 5, operatorGroup: 6 },
  { regex: BRACKET_OPTIONAL_TYPED_PREFIX_RE, keyGroup: 5, fixedOperator: "optional-typed" },
  { regex: BRACKET_OPTIONAL_ASSIGNMENT_PREFIX_RE, keyGroup: 5, operatorGroup: 6 },
  { regex: BRACKET_ASSIGNMENT_PREFIX_RE, keyGroup: 5, operatorGroup: 6 },
  { regex: POWERSHELL_ENV_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: FUNCTION_TYPED_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: TYPED_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: OPTIONAL_TYPED_PREFIX_RE, keyGroup: 4, fixedOperator: "optional-typed" },
  { regex: OPTIONAL_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: LOGICAL_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: COMPOUND_ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
  { regex: ASSIGNMENT_PREFIX_RE, keyGroup: 4, operatorGroup: 5 },
];

function decodeSecretKeyEscapes(value) {
  let malformed = false;
  const decoded = String(value || "").replace(/\\(?:u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))/gi, (_match, codePoint, codeUnit, byte) => {
    const number = Number.parseInt(codePoint || codeUnit || byte, 16);
    if (codePoint && number > 0x10ffff) {
      malformed = true;
      return "";
    }
    return codePoint ? String.fromCodePoint(number) : String.fromCharCode(number);
  });
  if (/\\[ux]/i.test(decoded)) malformed = true;
  return { decoded, malformed };
}

function normalizeDecodedSecretKey(value) {
  return String(value || "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function normalizeSecretKey(value) {
  return normalizeDecodedSecretKey(decodeSecretKeyEscapes(value).decoded);
}

function isSecretKey(value) {
  const key = decodeSecretKeyEscapes(value);
  if (key.malformed) return true;
  const normalized = normalizeDecodedSecretKey(key.decoded);
  if (/(?:^|_)token_counts?$/.test(normalized)) return false;
  return SECRET_KEY_RE.test(normalized);
}

function hasCredentialShape(value) {
  const text = String(value || "");
  if (TOKEN_SHAPE_RE.test(text)) return true;
  return [...text.matchAll(BASIC_AUTH_CANDIDATE_RE)].some((match) => isCanonicalBasicCredential(match[1]))
    || [...text.matchAll(BEARER_AUTH_CANDIDATE_RE)].some((match) => isLikelyBearerCredential(
      match[1],
      text.slice(match.index + match[0].length),
    ));
}

function redactCredentialShapes(value, replacement = "[REDACTED]") {
  return String(value || "")
    .replace(new RegExp(TOKEN_SHAPE_RE.source, "gi"), replacement)
    .replace(BASIC_AUTH_CANDIDATE_RE, (match, encoded) => isCanonicalBasicCredential(encoded) ? replacement : match)
    .replace(BEARER_AUTH_CANDIDATE_RE, (match, token, offset, text) => isLikelyBearerCredential(
      token,
      text.slice(offset + match.length),
    ) ? replacement : match);
}

function isLikelyBearerCredential(token, followingText) {
  if (/[^A-Za-z]/.test(token) || /[a-z][A-Z]/.test(token)) return true;
  return token.length >= 16 && !/^[ \t]+[A-Za-z]/.test(followingText);
}

function isCanonicalBasicCredential(encoded) {
  if (encoded.length % 4 !== 0) return false;
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.toString("base64") === encoded && decoded.includes(0x3a);
  } catch {
    return false;
  }
}

function quotedRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (text.startsWith("```", index)) {
      index += 3;
      continue;
    }
    if (!/^["'`]$/.test(char)) {
      index += 1;
      continue;
    }
    const delimiter = (char !== "`" && text.slice(index, index + 3) === char.repeat(3))
      ? char.repeat(3)
      : char;
    const multiline = delimiter.length === 3 || delimiter === "`";
    const start = index;
    let cursor = index + delimiter.length;
    let closed = false;
    while (cursor < text.length) {
      if (!multiline && (text[cursor] === "\r" || text[cursor] === "\n")) break;
      if (text.startsWith(delimiter, cursor)) {
        let slashes = 0;
        for (let check = cursor - 1; check >= start && text[check] === "\\"; check -= 1) slashes += 1;
        if (slashes % 2 === 0) {
          ranges.push({ start, end: cursor, open: delimiter, close: delimiter, closed: true });
          cursor += delimiter.length;
          closed = true;
          break;
        }
      }
      cursor += 1;
    }
    if (!closed) {
      const lineBreak = multiline ? -1 : text.slice(cursor).search(/[\r\n]/);
      const end = lineBreak === -1 ? text.length : cursor + lineBreak;
      ranges.push({ start, end, open: delimiter, close: "", closed: false });
      cursor = end;
    }
    index = Math.max(cursor, index + 1);
  }
  return ranges;
}

function quotedRangeAt(ranges, position) {
  let low = 0;
  let high = ranges.length - 1;
  let found = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].start <= position) {
      found = ranges[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found && position <= found.end ? found : null;
}

function lineEndAt(text, start) {
  const cr = text.indexOf("\r", start);
  const lf = text.indexOf("\n", start);
  if (cr === -1) return lf === -1 ? text.length : lf;
  return lf === -1 ? cr : Math.min(cr, lf);
}

function newlineEndAt(text, lineEnd) {
  if (text.slice(lineEnd, lineEnd + 2) === "\r\n") return lineEnd + 2;
  if (text[lineEnd] === "\r" || text[lineEnd] === "\n") return lineEnd + 1;
  return lineEnd;
}

function yamlBlockValue(text, start) {
  const firstEnd = lineEndAt(text, start);
  const indicator = text.slice(start, firstEnd).trim();
  if (!/^[>|](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?(?:\s+#.*)?$/.test(indicator)) return null;
  const lineStart = Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
  const baseIndent = (text.slice(lineStart).match(/^[ \t]*/) || [""])[0].length;
  let cursor = newlineEndAt(text, firstEnd);
  let end = cursor;
  while (cursor < text.length) {
    const nextEnd = lineEndAt(text, cursor);
    const line = text.slice(cursor, nextEnd);
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    if (line.trim() && indent <= baseIndent) break;
    end = newlineEndAt(text, nextEnd);
    cursor = end;
  }
  const raw = text.slice(start, end);
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : /[\r\n]$/.test(raw) ? raw.slice(-1) : "";
  return { start, end, raw, content: raw, open: "", close: "", trailingNewline };
}

function structuralValue(text, start, ranges) {
  if (text[start] !== "{" && text[start] !== "[") return null;
  const stack = [];
  let cursor = start;
  while (cursor < text.length) {
    const range = quotedRangeAt(ranges, cursor);
    if (range && range.start === cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      continue;
    }
    const char = text[cursor];
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack[stack.length - 1] !== expected) break;
      stack.pop();
      if (stack.length === 0) {
        const end = cursor + 1;
        const raw = text.slice(start, end);
        return { start, end, raw, content: raw, open: "", close: "", trailingNewline: "" };
      }
    }
    cursor += 1;
  }
  return {
    start,
    end: text.length,
    raw: text.slice(start),
    content: text.slice(start),
    open: "",
    close: "",
    trailingNewline: "",
  };
}

function arrowParameterOpenings(text, ranges) {
  const openings = new Set();
  const stack = [];
  let cursor = 0;
  while (cursor < text.length) {
    const range = quotedRangeAt(ranges, cursor);
    if (range && range.start === cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = newlineEndAt(text, lineEndAt(text, cursor + 2));
      continue;
    }
    if (text[cursor] === "(") stack.push(cursor);
    else if (text[cursor] === ")") {
      const opening = stack.pop();
      let next = cursor + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (opening !== undefined && text.startsWith("=>", next)) openings.add(opening);
    }
    cursor += 1;
  }
  return openings;
}

function typeAnnotationBeforeOpening(text, index, parent) {
  if (!/^(?:params|class)$/.test(parent?.kind || "")) return false;
  const segment = text.slice(parent.index + 1, index);
  let start = parent.kind === "class" ? segment.lastIndexOf(";") + 1 : 0;
  if (parent.kind === "params") {
    let angleDepth = 0;
    for (let cursor = 0; cursor < segment.length; cursor += 1) {
      if (segment[cursor] === "<") angleDepth += 1;
      else if (segment[cursor] === ">" && angleDepth > 0) angleDepth -= 1;
      else if (segment[cursor] === "," && angleDepth === 0) start = cursor + 1;
    }
  }
  const current = segment.slice(start);
  const colon = current.indexOf(":");
  if (colon === -1) return false;
  return !/(^|[^=])=($|[^>])/.test(current.slice(colon + 1));
}

function typeAngleDepth(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "<") depth += 1;
    else if (value[index] === ">" && value[index - 1] !== "=" && depth > 0) depth -= 1;
  }
  return depth;
}

function typeExpressionHasInitializer(value) {
  const depth = { angle: 0, round: 0, square: 0, curly: 0 };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "<") depth.angle += 1;
    else if (char === ">" && value[index - 1] !== "=" && depth.angle > 0) depth.angle -= 1;
    else if (char === "(") depth.round += 1;
    else if (char === ")" && depth.round > 0) depth.round -= 1;
    else if (char === "[") depth.square += 1;
    else if (char === "]" && depth.square > 0) depth.square -= 1;
    else if (char === "{") depth.curly += 1;
    else if (char === "}" && depth.curly > 0) depth.curly -= 1;
    else if (char === "=" && value[index + 1] !== ">"
      && depth.angle === 0 && depth.round === 0 && depth.square === 0 && depth.curly === 0) return true;
  }
  return false;
}

function expectsObjectType(value) {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.endsWith("=>") || typeAngleDepth(trimmed) > 0
    || /=>\s*\($/.test(trimmed) || /(?:^|[^|])\|$/.test(trimmed)
    || /(?:^|[^&])&$/.test(trimmed) || /[?:]$/.test(trimmed);
}

function declarationTypeBeforeOpening(text, index, parameterClosings) {
  const windowStart = Math.max(0, index - 4096);
  const prefix = text.slice(windowStart, index);
  const declarations = /(?:\)|\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*/g;
  let declaration;
  let value = null;
  while ((declaration = declarations.exec(prefix)) !== null) {
    const closingOffset = declaration[0].indexOf(")");
    if (closingOffset !== -1 && !parameterClosings.has(windowStart + declaration.index + closingOffset)) continue;
    value = prefix.slice(declaration.index + declaration[0].length);
  }
  return value !== null && !typeExpressionHasInitializer(value) && expectsObjectType(value);
}

function genericDeclarationTypeBeforeOpening(text, index) {
  const prefix = text.slice(Math.max(0, index - 4096), index);
  const declarations = /\b(?:type|interface|class|function)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*</g;
  let declaration;
  let segment = null;
  while ((declaration = declarations.exec(prefix)) !== null) {
    const candidate = prefix.slice(declaration.index + declaration[0].length - 1);
    if (typeAngleDepth(candidate) > 0) segment = candidate.slice(1);
  }
  if (segment === null) return false;
  let markerEnd = -1;
  for (const marker of segment.matchAll(/\bextends\b|=(?!>)/g)) markerEnd = marker.index + marker[0].length;
  return markerEnd !== -1 && expectsObjectType(segment.slice(markerEnd));
}

function typeExpressionContinuesAcrossLine(value, index) {
  const before = value.slice(0, index).trimEnd();
  let next = index + 1;
  while (next < value.length && /\s/.test(value[next])) next += 1;
  const after = value.slice(next, next + 32);
  return /(?:=>|[=|&?:,.<(\[{]|\b(?:extends|keyof|typeof|infer|new|readonly|unique|abstract))$/.test(before)
    || /^(?:=>|extends\b|is\b|[|&?:.,<\[])/.test(after);
}

function hasTopLevelStatementBoundary(value) {
  const stack = [];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (!escaped && char === "\\") escaped = true;
      else if (!escaped && char === quote) quote = "";
      else escaped = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{" || char === "<") stack.push(char);
    else if (char === ")" || char === "]" || char === "}" || char === ">") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : "<";
      if (stack[stack.length - 1] === expected) stack.pop();
    } else if (char === ";" && stack.length === 0) return true;
    else if ((char === "\r" || char === "\n") && stack.length === 0
      && !typeExpressionContinuesAcrossLine(value, index)) return true;
  }
  return false;
}

function completedGenericDeclaration(text, index) {
  const prefix = text.slice(Math.max(0, index - 4096), index);
  const declarations = /\b(type|interface|class|function)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*</g;
  let declaration;
  let completed = null;
  while ((declaration = declarations.exec(prefix)) !== null) {
    const opening = declaration.index + declaration[0].length - 1;
    let depth = 0;
    let closing = -1;
    for (let cursor = opening; cursor < prefix.length; cursor += 1) {
      if (prefix[cursor] === "<") depth += 1;
      else if (prefix[cursor] === ">" && prefix[cursor - 1] !== "=" && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          closing = cursor;
          break;
        }
      }
    }
    if (closing !== -1) {
      const tail = prefix.slice(closing + 1);
      if (!hasTopLevelStatementBoundary(tail)) completed = { kind: declaration[1], tail };
    }
  }
  return completed;
}

function typeAliasBeforeOpening(text, index) {
  const prefix = text.slice(Math.max(0, index - 4096), index);
  const declarations = /(?:^|[;{}\r\n])\s*(?:(?:export|declare)\s+)*type\s+[A-Za-z_$][A-Za-z0-9_$]*/g;
  let declaration;
  let tail = null;
  while ((declaration = declarations.exec(prefix)) !== null) {
    let cursor = declaration.index + declaration[0].length;
    while (cursor < prefix.length && /\s/.test(prefix[cursor])) cursor += 1;
    if (prefix[cursor] === "<") {
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (; cursor < prefix.length; cursor += 1) {
        const char = prefix[cursor];
        if (quote) {
          if (!escaped && char === "\\") escaped = true;
          else if (!escaped && char === quote) quote = "";
          else escaped = false;
          continue;
        }
        if (char === '"' || char === "'" || char === "`") quote = char;
        else if (char === "<") depth += 1;
        else if (char === ">" && prefix[cursor - 1] !== "=" && depth > 0) {
          depth -= 1;
          if (depth === 0) {
            cursor += 1;
            break;
          }
        }
      }
      if (depth !== 0) continue;
      while (cursor < prefix.length && /\s/.test(prefix[cursor])) cursor += 1;
    }
    if (prefix[cursor] !== "=") continue;
    tail = prefix.slice(cursor);
  }
  return tail !== null && !hasTopLevelStatementBoundary(tail);
}

function typeOperatorBeforeOpening(text, index) {
  const prefix = text.slice(Math.max(0, index - 4096), index);
  const operators = /\b(?:as|satisfies)\b/g;
  let operator;
  let value = null;
  while ((operator = operators.exec(prefix)) !== null) value = prefix.slice(operator.index + operator[0].length);
  if (value === null || /;/.test(value) || typeExpressionHasInitializer(value)) return false;
  const stack = [];
  let hasTopLevelExtends = false;
  let hasTopLevelConditional = false;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (stack.length === 0 && value.startsWith("extends", cursor)
      && !/[A-Za-z0-9_$]/.test(value[cursor - 1] || "")
      && !/[A-Za-z0-9_$]/.test(value[cursor + 7] || "")) hasTopLevelExtends = true;
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack[stack.length - 1] !== expected) return false;
      stack.pop();
    } else if (stack.length === 0 && (value.startsWith("??", cursor)
      || value.startsWith("&&", cursor) || value.startsWith("||", cursor))) return false;
    else if (stack.length === 0 && ((char === "?" && value[cursor + 1] !== "?" && value[cursor + 1] !== ".")
      || char === ":")) hasTopLevelConditional = true;
  }
  if (hasTopLevelConditional && !hasTopLevelExtends) return false;
  return expectsObjectType(value);
}

function directRuntimeValueBeforeOpening(text, index, lineStart) {
  const prefix = text.slice(lineStart, index);
  if (/^\s*(?:(?:export|declare)\s+)*(?:type|interface|class|function)\b/.test(prefix)) return false;
  return /(?:^|[^=!<>])=(?!=|>)\s*$/.test(prefix);
}

function delimiterOpeningKind(text, index, char, stack, arrowOpenings, parameterClosings, lineStart) {
  if (char === "{" && directRuntimeValueBeforeOpening(text, index, lineStart)) return "code";
  const prefix = text.slice(Math.max(0, index - 4096), index);
  if (char === "{") {
    const completedGeneric = completedGenericDeclaration(text, index);
    if (/\btype\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>{}\r\n]*>)?\s*=\s*$/.test(prefix)
      || /\binterface\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>{}\r\n]*>)?(?:\s+extends\b[^{}]*)?\s*$/.test(prefix)) return "type";
    if (typeAliasBeforeOpening(text, index)) return "type";
    if (/\bclass\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>{}\r\n]*>)?(?:\s+(?:extends|implements)\b[^{}]*)?\s*$/.test(prefix)) return "class";
    const parent = stack[stack.length - 1];
    if (parent?.kind === "type") return "type";
    if (parent?.kind === "params" && /:\s*$/.test(prefix)) return "type";
    if (typeAnnotationBeforeOpening(text, index, parent)) return "type";
    if (declarationTypeBeforeOpening(text, index, parameterClosings)) return "type";
    if (genericDeclarationTypeBeforeOpening(text, index)) return "type";
    if (typeOperatorBeforeOpening(text, index)) return "type";
    if (completedGeneric?.kind === "type" && /^\s*=/.test(completedGeneric.tail)
      && expectsObjectType(completedGeneric.tail.replace(/^\s*=\s*/, ""))) return "type";
    if (completedGeneric?.kind === "interface" && /^\s*(?:extends\b[^;{}]*)?$/.test(completedGeneric.tail)) return "type";
    if (completedGeneric?.kind === "class" && /^\s*(?:(?:extends|implements)\b[^;{}]*)?$/.test(completedGeneric.tail)) return "class";
    return "code";
  }
  if (char === "(") {
    const completedGeneric = completedGenericDeclaration(text, index);
    if (arrowOpenings.has(index)
      || /\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^(){}\r\n]*>)?)?\s*$/.test(prefix)
      || /\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?$/.test(prefix)
      || /(?:^|[;{}\r\n])\s*(?:(?:public|private|protected|static|readonly|abstract|override|async)\s+)*(?:constructor|[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^(){}\r\n]*>)?)\s*$/.test(prefix)
      || (completedGeneric?.kind === "function" && /^\s*$/.test(completedGeneric.tail))) return "params";
  }
  return "code";
}

function syntaxContextTracker(text, ranges) {
  const stack = [];
  const arrowOpenings = arrowParameterOpenings(text, ranges);
  const parameterClosings = new Set();
  let cursor = 0;
  let rangeIndex = 0;
  let lineStart = 0;
  function advance(target) {
    while (cursor < target) {
      while (rangeIndex < ranges.length) {
        const range = ranges[rangeIndex];
        const end = range.closed ? range.end + range.close.length : range.end;
        if (end <= cursor) rangeIndex += 1;
        else break;
      }
      const range = ranges[rangeIndex];
      if (range && range.start <= cursor) {
        const end = range.closed ? range.end + range.close.length : range.end;
        for (let scan = cursor; scan < end; scan += 1) {
          if (text[scan] === "\r" || text[scan] === "\n") lineStart = scan + 1;
        }
        cursor = Math.min(target, end);
        continue;
      }
      const limit = range ? Math.min(target, range.start) : target;
      while (cursor < limit) {
        const char = text[cursor];
        if (char === "{" || char === "[" || char === "(") {
          stack.push({ char, kind: delimiterOpeningKind(text, cursor, char, stack, arrowOpenings, parameterClosings, lineStart), index: cursor });
        } else if (char === "}" || char === "]" || char === ")") {
          const expected = char === "}" ? "{" : char === "]" ? "[" : "(";
          for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index].char === expected) {
              if (char === ")" && stack[index].kind === "params") parameterClosings.add(cursor);
              stack.length = index;
              break;
            }
          }
        }
        if (char === "\r" || char === "\n") lineStart = cursor + 1;
        cursor += 1;
      }
    }
    if (quotedRangeAt(ranges, target)) return "";
    const top = stack[stack.length - 1];
    if (/^(?:type|class|params)$/.test(top?.kind || "")) return top.kind;
    return top?.char === "{" && top.kind === "code" ? "object" : "";
  }
  return { advance };
}

function linePrefix(text, position) {
  const start = Math.max(text.lastIndexOf("\n", position - 1), text.lastIndexOf("\r", position - 1)) + 1;
  return text.slice(start, position);
}

function looksLikeTypeAliasAssignment(text, prefixStart, prefixEnd, operator) {
  if (operator !== "=") return false;
  const start = Math.max(0, prefixStart - 96);
  const window = text.slice(start, Math.min(text.length, prefixEnd + 1));
  const declarations = /(?:^|[;{}\r\n])\s*(?:(?:export|declare)\s+)*type\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^=;{}\r\n]*>)?\s*=/g;
  let declaration;
  while ((declaration = declarations.exec(window)) !== null) {
    const equals = start + declaration.index + declaration[0].lastIndexOf("=");
    if (prefixStart <= equals && equals <= prefixEnd) return true;
  }
  return false;
}

function genericDeclarationHeaderRanges(text, quoted) {
  const declarations = /\b(?:type|interface|class|function)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*</g;
  const headers = [];
  let declaration;
  while ((declaration = declarations.exec(text)) !== null) {
    const opening = declaration.index + declaration[0].length - 1;
    if (quotedRangeAt(quoted, opening)) continue;
    let depth = 0;
    for (let cursor = opening; cursor < text.length; cursor += 1) {
      const range = quotedRangeAt(quoted, cursor);
      if (range) {
        cursor = (range.closed ? range.end + range.close.length : range.end) - 1;
        continue;
      }
      if (text[cursor] === "<") depth += 1;
      else if (text[cursor] === ">" && text[cursor - 1] !== "=" && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          headers.push({ start: opening + 1, end: cursor });
          declarations.lastIndex = cursor + 1;
          break;
        }
      }
    }
  }
  return headers;
}

function looksLikeGenericTypeParameterDefault(text, candidate, genericHeaders) {
  if (candidate.operator !== "=") return false;
  const header = intervalCovering(genericHeaders, candidate.prefixStart);
  if (!header) return false;
  let prior = candidate.prefixStart - 1;
  while (prior >= header.start && /\s/.test(text[prior])) prior -= 1;
  if (prior >= header.start && text[prior] !== ",") return false;
  const assignmentPrefix = text.slice(candidate.prefixStart, candidate.prefixEnd);
  return /^(?:(?:const|in|out)\s+)*[A-Za-z_$][A-Za-z0-9_$]*(?:\s+extends\s+[A-Za-z_$][A-Za-z0-9_$.[\] ]*)?\s*=$/.test(assignmentPrefix);
}

function looksLikeTypeAnnotation(text, candidate, assignment, syntaxContext) {
  if (candidate.operator !== ":" || assignment.open) return false;
  const rest = String(assignment.content || "").trim();
  const isTypeContext = /^(?:type|class|params)$/.test(syntaxContext);
  if (isTypeContext && /^[{[]/.test(rest)) {
    return /^\s*(?:$|[;,) }])/.test(text.slice(assignment.end, assignment.end + 32));
  }
  if (isTypeContext && /^\([^=\r\n]*\)\s*=>/.test(rest)) return true;
  if (isTypeContext && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\[[^\]{};\r\n]+\])+\s*(?:$|[|&;,)}])/.test(rest)) return true;
  const typeHead = /^(?:(?:readonly|keyof|typeof|infer|new)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)(?:\s*<[^;=(){}\r\n]*>)?(?:\s*\[\s*\])*/.exec(rest);
  if (!typeHead) return false;
  const tail = rest.slice(typeHead[0].length);
  const typedInitializer = /^\s*=/.test(tail);
  if (typedInitializer) {
    const declarationPrefix = linePrefix(text, candidate.prefixStart);
    const assignmentPrefix = text.slice(candidate.prefixStart, candidate.prefixEnd);
    const beforeValue = text.slice(Math.max(0, assignment.start - 256), assignment.start);
    return syntaxContext === "class" || syntaxContext === "params"
      || /^\s*(?:(?:export|declare)\s+)*(?:const|let|var)\s+$/.test(declarationPrefix)
      || /^\s*(?:(?:export|declare)\s+)*(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:$/.test(assignmentPrefix)
      || /(?:^|[;{}\r\n])\s*(?:(?:export|declare)\s+)*(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*[A-Za-z_$][A-Za-z0-9_$.[\] <>|&,?]*\s*$/.test(beforeValue);
  }
  if (isTypeContext) return /^\s*(?:$|[|&;,)}])/.test(tail);
  return /^(?:string|number|boolean|bigint|symbol|unknown|never|void|null|undefined|any|object)\b/.test(typeHead[0])
    && /^\s*[|&]/.test(tail);
}

function objectScalarEnd(text, start, ranges) {
  const stack = [];
  const lineEnd = lineEndAt(text, start);
  let cursor = start;
  while (cursor < lineEnd) {
    const range = quotedRangeAt(ranges, cursor);
    if (range && range.start === cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      continue;
    }
    const char = text[cursor];
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack[stack.length - 1] === expected) stack.pop();
      else if (stack.length === 0) break;
    } else if (stack.length === 0 && (char === "," || char === ";")) break;
    cursor += 1;
  }
  while (cursor > start && /[ \t]/.test(text[cursor - 1])) cursor -= 1;
  return cursor;
}

function continuedPhysicalLineEnd(text, start) {
  let end = lineEndAt(text, start);
  while (/\\[ \t]*$/.test(text.slice(start, end))) {
    const next = newlineEndAt(text, end);
    if (next >= text.length) break;
    end = lineEndAt(text, next);
  }
  return end;
}

function codeExpressionEnd(text, start, ranges) {
  const stack = [];
  let cursor = start;
  let lastSignificant = "";
  while (cursor < text.length) {
    const range = quotedRangeAt(ranges, cursor);
    if (range && range.start === cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      lastSignificant = "v";
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = lineEndAt(text, cursor + 2);
      continue;
    }
    const char = text[cursor];
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack[stack.length - 1] === expected) stack.pop();
      else if (stack.length === 0) break;
    } else if (stack.length === 0 && (char === "," || char === ";")) {
      break;
    } else if (stack.length === 0 && (char === "\r" || char === "\n")) {
      const nextLine = newlineEndAt(text, cursor);
      let next = nextLine;
      while (next < text.length && /[ \t]/.test(text[next])) next += 1;
      const nextChar = text[next] || "";
      if (!/[?:+\-*/%&|^=!.<>]/.test(lastSignificant) && !/^[?:+\-*/%&|^!.<>]/.test(nextChar)) break;
      cursor = next;
      continue;
    }
    if (!/\s/.test(char)) lastSignificant = char;
    cursor += 1;
  }
  while (cursor > start && /[ \t]/.test(text[cursor - 1])) cursor -= 1;
  return cursor;
}

function looksLikeCodeAssignment(text, prefixStart, prefixEnd, operator, syntaxContext, ranges, valueStart) {
  if (/^(?:cli-flag|docker-env|define|sql-password|yaml-value)$/.test(operator)) return false;
  if (/^(?:\|\|=|\?\?=|&&=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=>)$/.test(operator)
    || /^(?:object|class|params)$/.test(syntaxContext)) return true;
  const lineStart = Math.max(text.lastIndexOf("\n", prefixStart - 1), text.lastIndexOf("\r", prefixStart - 1)) + 1;
  const prefix = text.slice(lineStart, prefixStart);
  const assignmentPrefix = text.slice(prefixStart, prefixEnd);
  if (/\b(?:const|let|var|return|throw|yield|await|static)\b/.test(`${prefix}${assignmentPrefix}`)
    || /(?:\.|\]|\bthis\b|\bprocess\b)\s*$/.test(prefix)
    || assignmentPrefix.includes("[")
    || /\/[/*]/.test(assignmentPrefix)) return true;
  const range = quotedRangeAt(ranges, valueStart);
  if (range && range.start === valueStart) {
    const literalEnd = range.closed ? range.end + range.close.length : range.end;
    return /^\s*(?:\+|\?|&&|\|\||\?\?|\.)/.test(text.slice(literalEnd, lineEndAt(text, literalEnd)));
  }
  const firstEnd = lineEndAt(text, valueStart);
  const nextLine = nextNonblankLine(text, newlineEndAt(text, firstEnd));
  return Boolean(nextLine && /^\s*[?:+\-*/%&|^!.<>]/.test(text.slice(nextLine.start, nextLine.end)));
}

function skipCommentedAssignmentTrivia(text, start) {
  let cursor = start;
  let sawComment = false;
  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text.startsWith("/*", cursor)) {
      sawComment = true;
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      sawComment = true;
      cursor = newlineEndAt(text, lineEndAt(text, cursor + 2));
      continue;
    }
    break;
  }
  if (!sawComment) {
    cursor = start;
    while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  }
  return { cursor, sawComment };
}

function optionalTypedInitializerEnd(text, start, ranges) {
  const stack = [];
  let cursor = start;
  while (cursor < text.length) {
    const range = quotedRangeAt(ranges, cursor);
    if (range && range.start === cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = lineEndAt(text, cursor + 2);
      continue;
    }
    const char = text[cursor];
    if (cursor > start && stack.length === 0 && /[A-Za-z_$]/.test(char)) {
      const nextMember = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}\s*\?\s*:/.exec(text.slice(cursor, cursor + 256));
      if (nextMember) return -1;
    }
    if (char === "(" || char === "[" || char === "{" || char === "<") {
      stack.push(char);
    } else if (char === ")" || char === "]" || char === "}" || char === ">") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : "<";
      if (char === ">" && text[cursor - 1] === "=") {
        cursor += 1;
        continue;
      }
      if (stack[stack.length - 1] !== expected) return -1;
      stack.pop();
    } else if (char === "=" && text[cursor + 1] !== ">" && stack.length === 0) {
      return cursor + 1;
    } else if ((char === ";" || char === "}" || char === ",") && stack.length === 0) {
      return -1;
    } else if ((char === "\r" || char === "\n") && stack.length === 0) {
      let next = newlineEndAt(text, cursor);
      while (next < text.length && /[ \t]/.test(text[next])) next += 1;
      if (!/^[=|&]/.test(text[next] || "")) return -1;
      cursor = next;
      continue;
    }
    cursor += 1;
  }
  return -1;
}

function readInlineAssignmentValue(text, start, ranges, operator = "", syntaxContext = "", prefixStart = start, prefixEnd = start) {
  const continuedCli = operator === "cli-flag" && /^\\[ \t]*(?:\r?\n|$)/.test(text.slice(start, start + 64));
  if (continuedCli || operator === "docker-env" || operator === "define") {
    const end = continuedPhysicalLineEnd(text, start);
    const raw = text.slice(start, end);
    return { start, end, raw, content: raw, open: "", close: "", trailingNewline: "" };
  }
  const redactedTerminator = /^(?:[ \t]{0,16}(?:;|\r?\n|$))/.test(text.slice(start + 10, start + 28));
  const redactedContainerEnd = /^(?:[ \t]{0,16}(?:[,}\]]))/.test(text.slice(start + 10, start + 28))
    && syntaxContext === "object";
  const redacted = /^\[redacted\]/i.exec(text.slice(start, start + 16));
  if (redacted && (redactedTerminator || redactedContainerEnd)) {
    const end = start + redacted[0].length;
    return { start, end, raw: redacted[0], content: redacted[0], open: "", close: "", trailingNewline: "" };
  }
  const range = quotedRangeAt(ranges, start);
  if (range) {
    if (range.start === start) {
      const literalEnd = range.closed ? range.end + range.close.length : range.end;
      const literalContent = text.slice(start + range.open.length, range.end);
      const literalTerminator = /^(?:[ \t]{0,16}(?:;|\r?\n|$))/.test(text.slice(literalEnd, literalEnd + 18));
      const literalContainerEnd = /^(?:[ \t]{0,16}(?:[,}\]]))/.test(text.slice(literalEnd, literalEnd + 18))
        && syntaxContext === "object";
      if (/^\[redacted\]$/i.test(literalContent) && (literalTerminator || literalContainerEnd)) {
        return {
          start,
          end: literalEnd,
          raw: text.slice(start, literalEnd),
          content: literalContent,
          open: range.open,
          close: range.close,
          trailingNewline: "",
        };
      }
      const end = looksLikeCodeAssignment(text, prefixStart, prefixEnd, operator, syntaxContext, ranges, start)
        ? codeExpressionEnd(text, start, ranges)
        : literalEnd;
      return {
        start,
        end,
        raw: text.slice(start, end),
        content: text.slice(start + range.open.length, end - range.close.length),
        open: range.open,
        close: range.close,
        trailingNewline: "",
      };
    }
    const end = range.end;
    return {
      start,
      end,
      raw: text.slice(start, end),
      content: text.slice(start, end),
      open: "",
      close: "",
      trailingNewline: "",
    };
  }

  const block = yamlBlockValue(text, start);
  if (block) return block;
  const structural = /^\[redacted\]/i.test(text.slice(start, start + 16)) ? null : structuralValue(text, start, ranges);
  if (structural) return structural;
  const end = looksLikeCodeAssignment(text, prefixStart, prefixEnd, operator, syntaxContext, ranges, start)
    ? codeExpressionEnd(text, start, ranges)
    : operator === ":" && syntaxContext === "object"
    ? objectScalarEnd(text, start, ranges)
    : lineEndAt(text, start);
  const raw = text.slice(start, end);
  return { start, end, raw, content: raw, open: "", close: "", trailingNewline: "" };
}

function nextNonblankLine(text, start) {
  let cursor = start;
  while (cursor < text.length) {
    const end = lineEndAt(text, cursor);
    if (text.slice(cursor, end).trim()) return { start: cursor, end };
    cursor = newlineEndAt(text, end);
  }
  return null;
}

function yamlContinuationValue(text, prefixStart, prefixEnd) {
  const keyLineStart = Math.max(text.lastIndexOf("\n", prefixStart - 1), text.lastIndexOf("\r", prefixStart - 1)) + 1;
  const baseIndent = (text.slice(keyLineStart, prefixStart).match(/^[ \t]*/) || [""])[0].length;
  const blockStart = newlineEndAt(text, lineEndAt(text, prefixEnd));
  const first = nextNonblankLine(text, blockStart);
  if (!first) return null;
  const firstLine = text.slice(first.start, first.end);
  const firstIndent = (firstLine.match(/^[ \t]*/) || [""])[0].length;
  const indentationlessSequence = firstIndent === baseIndent && /^\s*-(?:\s|$)/.test(firstLine);
  if (firstIndent <= baseIndent && !indentationlessSequence) return null;

  let cursor = blockStart;
  let end = blockStart;
  while (cursor < text.length) {
    const lineEnd = lineEndAt(text, cursor);
    const line = text.slice(cursor, lineEnd);
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    const belongs = !line.trim() || indent > baseIndent
      || (indentationlessSequence && indent === baseIndent && /^\s*-(?:\s|$)/.test(line));
    if (!belongs) break;
    end = newlineEndAt(text, lineEnd);
    cursor = end;
  }
  const raw = text.slice(prefixEnd, end);
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : /[\r\n]$/.test(raw) ? raw.slice(-1) : "";
  return { start: prefixEnd, end, raw, content: raw, open: "", close: "", trailingNewline };
}

function readContinuedAssignmentValue(text, prefixStart, prefixEnd, operator, ranges, syntaxContext) {
  if (operator === ":") return yamlContinuationValue(text, prefixStart, prefixEnd);
  const blockStart = newlineEndAt(text, lineEndAt(text, prefixEnd));
  const trivia = skipCommentedAssignmentTrivia(text, blockStart);
  if (trivia.sawComment && trivia.cursor < text.length) {
    return readInlineAssignmentValue(text, trivia.cursor, ranges, operator, syntaxContext, prefixStart, prefixEnd);
  }
  const line = nextNonblankLine(text, blockStart);
  if (!line) return null;
  const keyLineStart = Math.max(text.lastIndexOf("\n", prefixStart - 1), text.lastIndexOf("\r", prefixStart - 1)) + 1;
  const baseIndent = (text.slice(keyLineStart, prefixStart).match(/^[ \t]*/) || [""])[0].length;
  const rawLine = text.slice(line.start, line.end);
  const indent = (rawLine.match(/^[ \t]*/) || [""])[0].length;
  const start = line.start + indent;
  if (indent <= baseIndent && !/^(?:["'`{]|\[)/.test(text[start] || "")) return null;
  return readInlineAssignmentValue(text, start, ranges, operator, syntaxContext, prefixStart, prefixEnd);
}

function readAssignmentValue(text, prefixStart, prefixEnd, operator, ranges, syntaxContext) {
  const trivia = skipCommentedAssignmentTrivia(text, prefixEnd);
  let start = trivia.cursor;
  if (start >= text.length) return null;
  if (trivia.sawComment) return readInlineAssignmentValue(text, start, ranges, operator, syntaxContext, prefixStart, prefixEnd);
  if (text[start] === "\r" || text[start] === "\n") {
    return readContinuedAssignmentValue(text, prefixStart, prefixEnd, operator, ranges, syntaxContext);
  }
  return readInlineAssignmentValue(text, start, ranges, operator, syntaxContext, prefixStart, prefixEnd);
}

function extendRedactedYamlAssignment(text, prefixStart, operator, assignment) {
  if (operator !== ":" || !assignmentIsRedacted(assignment)) return assignment;
  const currentLineEnd = lineEndAt(text, assignment.end);
  const continuation = yamlContinuationValue(text, prefixStart, currentLineEnd);
  if (!continuation) return assignment;
  return {
    ...assignment,
    end: continuation.end,
    raw: text.slice(assignment.start, continuation.end),
    content: `${assignment.content}${continuation.content}`,
    trailingNewline: continuation.trailingNewline,
  };
}

function unclosedTripleRangeAfter(ranges, position) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].start < position) low = middle + 1;
    else high = middle;
  }
  return ranges[low] || null;
}

function extendRedactedTomlAssignment(text, assignment, ranges) {
  if (!assignmentIsRedacted(assignment) || assignment.open !== '"' || assignment.close !== '"') return assignment;
  const dangling = unclosedTripleRangeAfter(ranges, assignment.end);
  if (dangling) {
    const blockEnd = dangling.start + dangling.open.length;
    return {
      ...assignment,
      end: blockEnd,
      raw: text.slice(assignment.start, blockEnd),
      content: text.slice(assignment.start + assignment.open.length, blockEnd),
    };
  }
  let cursor = newlineEndAt(text, assignment.end);
  if (cursor === assignment.end) return assignment;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const physicalEnd = newline === -1 ? text.length : newline;
    const end = physicalEnd > cursor && text[physicalEnd - 1] === "\r" ? physicalEnd - 1 : physicalEnd;
    const line = text.slice(cursor, end);
    const delimiter = /(?:"""|''')/.exec(line);
    if (delimiter) {
      if (/=\s*$/.test(line.slice(0, delimiter.index))) return assignment;
      const blockEnd = cursor + delimiter.index + delimiter[0].length;
      return {
        ...assignment,
        end: blockEnd,
        raw: text.slice(assignment.start, blockEnd),
        content: text.slice(assignment.start + assignment.open.length, blockEnd),
      };
    }
    if (/^[ \t]*(?:[A-Za-z0-9_.-]+[ \t]*=|\[)/.test(line)) return assignment;
    cursor = newline === -1 ? text.length : newline + 1;
  }
  return assignment;
}

function assignmentIsRedacted(assignment) {
  return /^\[redacted\]$/i.test(String(assignment.content || "").trim());
}

function assignmentPrefixScanText(text, ranges) {
  const chunks = [];
  const comments = [];
  let cursor = 0;
  let preserved = 0;
  let rangeIndex = 0;
  while (cursor < text.length) {
    while (rangeIndex < ranges.length) {
      const range = ranges[rangeIndex];
      const end = range.closed ? range.end + range.close.length : range.end;
      if (end <= cursor) rangeIndex += 1;
      else break;
    }
    const range = ranges[rangeIndex];
    if (range && range.start <= cursor) {
      cursor = range.closed ? range.end + range.close.length : range.end;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const closing = text.indexOf("*/", cursor + 2);
      const end = closing === -1 ? text.length : closing + 2;
      comments.push({ start: cursor, end: closing === -1 ? text.length : closing });
      chunks.push(text.slice(preserved, cursor), text.slice(cursor, end).replace(/[^\r\n]/g, " "));
      cursor = end;
      preserved = end;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      const end = lineEndAt(text, cursor + 2);
      comments.push({ start: cursor, end });
      chunks.push(text.slice(preserved, cursor), text.slice(cursor, end).replace(/[^\r\n]/g, " "));
      cursor = end;
      preserved = end;
      continue;
    }
    cursor += 1;
  }
  if (chunks.length < 1) return { text, comments };
  chunks.push(text.slice(preserved));
  return { text: chunks.join(""), comments };
}

function secretAssignmentCandidates(text, ranges) {
  const prefixScan = assignmentPrefixScanText(text, ranges);
  const scanText = prefixScan.text;
  const scanTexts = scanText === text ? [text] : [text, scanText];
  const candidates = new Map();
  for (const { regex, keyGroup, operatorGroup, fixedOperator } of ASSIGNMENT_PREFIX_SCANNERS) {
    for (const source of scanTexts) {
      const scanner = new RegExp(regex.source, regex.flags);
      let match;
      while ((match = scanner.exec(source)) !== null) {
        if (match[0].length === 0) scanner.lastIndex = match.index + 1;
        if (!isSecretKey(match[keyGroup])) continue;
        const operator = fixedOperator || match[operatorGroup];
        const prefixStart = match.index + match[1].length;
        const prefixEnd = prefixStart + match[2].length;
        if (operator === "=" && (text[prefixEnd] === "=" || text[prefixEnd] === ">")) continue;
        candidates.set(`${prefixStart}:${prefixEnd}`, { operator, prefixStart, prefixEnd });
      }
    }
  }
  return {
    candidates: [...candidates.values()].sort((left, right) => left.prefixStart - right.prefixStart || right.prefixEnd - left.prefixEnd),
    comments: prefixScan.comments,
    syntaxText: scanText,
  };
}

function commentRangeAt(comments, position) {
  let low = 0;
  let high = comments.length - 1;
  let found = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (comments[middle].start <= position) {
      found = comments[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found && position < found.end ? found : null;
}

function limitAssignmentToComment(text, assignment, comments) {
  const comment = commentRangeAt(comments, assignment.start);
  if (!comment || assignment.end <= comment.end) return assignment;
  const raw = text.slice(assignment.start, comment.end);
  const trailing = (raw.match(/[ \t]*$/) || [""])[0];
  const core = raw.slice(0, raw.length - trailing.length);
  return {
    ...assignment,
    end: comment.end,
    raw,
    content: assignment.open ? core.slice(assignment.open.length) : core,
    close: "",
    trailingNewline: trailing,
  };
}

function intervalCovering(intervals, position) {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const interval = intervals[middle];
    if (position < interval.start) high = middle - 1;
    else if (position >= interval.end) low = middle + 1;
    else return interval;
  }
  return null;
}

function positionCovered(intervals, position) {
  return intervalCovering(intervals, position) !== null;
}

function addCoveredInterval(intervals, start, end) {
  if (end <= start) return;
  const last = intervals[intervals.length - 1];
  if (!last || start >= last.end) {
    intervals.push({ start, end });
    return;
  }
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle].end < start) low = middle + 1;
    else high = middle;
  }
  let index = low;
  let mergedStart = start;
  let mergedEnd = end;
  let remove = 0;
  while (index + remove < intervals.length && intervals[index + remove].start <= mergedEnd) {
    mergedStart = Math.min(mergedStart, intervals[index + remove].start);
    mergedEnd = Math.max(mergedEnd, intervals[index + remove].end);
    remove += 1;
  }
  intervals.splice(index, remove, { start: mergedStart, end: mergedEnd });
}

function findSecretAssignments(value, { stopOnLeak = false } = {}) {
  const text = String(value || "");
  const ranges = quotedRanges(text);
  const danglingTripleRanges = ranges.filter((range) => !range.closed && /^(?:"""|''')$/.test(range.open));
  const { candidates, comments, syntaxText } = secretAssignmentCandidates(text, ranges);
  const genericHeaders = genericDeclarationHeaderRanges(syntaxText, ranges);
  const tracker = syntaxContextTracker(syntaxText, ranges);
  const matches = [];
  const covered = [];
  const handledPrefixes = new Set();
  for (const discovered of candidates) {
      let candidate = discovered;
      const trackedContext = tracker.advance(candidate.prefixStart);
      const syntaxContext = commentRangeAt(comments, candidate.prefixStart) ? "" : trackedContext;
      if (candidate.operator === "optional-typed") {
        if (syntaxContext !== "class") continue;
        const prefixEnd = optionalTypedInitializerEnd(text, candidate.prefixEnd, ranges);
        if (prefixEnd === -1) continue;
        candidate = { ...candidate, operator: "=", prefixEnd };
      }
      if (handledPrefixes.has(candidate.prefixStart)) continue;
      if (positionCovered(covered, candidate.prefixStart)) continue;
      if (looksLikeTypeAliasAssignment(text, candidate.prefixStart, candidate.prefixEnd, candidate.operator)) continue;
      if (looksLikeGenericTypeParameterDefault(text, candidate, genericHeaders)) continue;
      let assignment = readAssignmentValue(text, candidate.prefixStart, candidate.prefixEnd, candidate.operator, ranges, syntaxContext);
      if (!assignment || assignment.raw.length < 1) continue;
      assignment = limitAssignmentToComment(text, assignment, comments);
      assignment = extendRedactedYamlAssignment(text, candidate.prefixStart, candidate.operator, assignment);
      assignment = extendRedactedTomlAssignment(text, assignment, danglingTripleRanges);
      if (looksLikeTypeAnnotation(text, candidate, assignment, syntaxContext)) continue;
      handledPrefixes.add(candidate.prefixStart);
      addCoveredInterval(covered, assignment.start, assignment.end);
      if (stopOnLeak) {
        if (!assignmentIsRedacted(assignment)) return [assignment];
        continue;
      }
      matches.push(assignment);
  }
  return matches.sort((left, right) => left.start - right.start || right.end - left.end);
}

function nonOverlappingAssignments(assignments) {
  const selected = [];
  for (const assignment of assignments) {
    const prior = selected[selected.length - 1];
    if (prior && assignment.start < prior.end) continue;
    selected.push(assignment);
  }
  return selected;
}

function redactSecretAssignments(value, replacement = "[REDACTED]") {
  const text = String(value || "");
  const json = parseJsonDocument(text);
  if (json) return redactJsonDocument(text, json, replacement);
  return redactGenericAssignments(text, replacement);
}

function redactGenericAssignments(value, replacement) {
  const text = String(value || "");
  const assignments = nonOverlappingAssignments(findSecretAssignments(text));
  if (assignments.length < 1) return text;
  const chunks = [];
  let cursor = 0;
  for (const assignment of assignments) {
    const wrapped = `${assignment.open}${replacement}${assignment.close}${assignment.trailingNewline}`;
    chunks.push(text.slice(cursor, assignment.start), wrapped);
    cursor = assignment.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

function hasSecretAssignment(value) {
  const text = String(value || "");
  const json = parseJsonDocument(text);
  if (json) return jsonHasSecret(json, false) || rawJsonHasSecret(text);
  return findSecretAssignments(text, { stopOnLeak: true }).length > 0;
}

function parseJsonDocument(text) {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function jsonHasSecret(value, protectedValue) {
  if (Array.isArray(value)) return value.some((child) => jsonHasSecret(child, protectedValue));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => jsonHasSecret(child, protectedValue || isSecretKey(key)));
  }
  if (protectedValue) return !(typeof value === "string" && /^\[redacted\]$/i.test(value));
  return typeof value === "string" && findSecretAssignments(value, { stopOnLeak: true }).length > 0;
}

function rawJsonHasDuplicateKey(text) {
  const stack = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '"') {
      const start = cursor;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") cursor += 2;
        else if (text[cursor] === '"') break;
        else cursor += 1;
      }
      const end = Math.min(cursor + 1, text.length);
      let next = end;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      const scope = stack[stack.length - 1];
      if (text[next] === ":" && scope?.char === "{") {
        let key;
        try { key = JSON.parse(text.slice(start, end)); } catch { key = null; }
        if (typeof key === "string") {
          if (scope.keys.has(key)) return true;
          scope.keys.add(key);
        }
      }
      cursor = end;
      continue;
    }
    if (char === "{") stack.push({ char, keys: new Set() });
    else if (char === "[") stack.push({ char, keys: null });
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].char === expected) {
          stack.length = index;
          break;
        }
      }
    }
    cursor += 1;
  }
  return false;
}

function rawJsonHasSecret(text) {
  if (rawJsonHasDuplicateKey(text)) return true;
  return findSecretAssignments(text).some((assignment) => {
    if (assignmentIsRedacted(assignment)) return false;
    const raw = assignment.raw.trim();
    if (raw[0] !== "{" && raw[0] !== "[") return true;
    try {
      return jsonHasSecret(JSON.parse(raw), true);
    } catch {
      return true;
    }
  });
}

function redactJsonDocument(text, parsed, replacement) {
  let changed = false;
  function visit(value, protectedValue) {
    if (Array.isArray(value)) return value.map((child) => visit(child, protectedValue));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .map(([key, child]) => [key, visit(child, protectedValue || isSecretKey(key))]));
    }
    if (protectedValue) {
      if (typeof value === "string" && value === replacement) return value;
      changed = true;
      return replacement;
    }
    if (typeof value === "string") {
      const safe = redactGenericAssignments(value, replacement);
      if (safe !== value) changed = true;
      return safe;
    }
    return value;
  }
  const safe = visit(parsed, false);
  if (!changed && !rawJsonHasSecret(text)) return text;
  const pretty = /[\r\n]/.test(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /(?:\r\n|\r|\n)$/.test(text) ? newline : "";
  const serialized = JSON.stringify(safe, null, pretty ? 2 : 0);
  return `${newline === "\n" ? serialized : serialized.replace(/\n/g, newline)}${trailingNewline}`;
}

module.exports = {
  TOKEN_SHAPE_RE,
  hasCredentialShape,
  hasSecretAssignment,
  isSecretKey,
  normalizeSecretKey,
  redactCredentialShapes,
  redactSecretAssignments,
};
