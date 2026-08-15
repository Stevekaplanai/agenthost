// Cron parsing/matching for the gate's scheduler. Zero dependencies, all UTC:
// jobs store UTC expressions and the UI does timezone math, so nothing here
// may ever consult the container's local clock settings.
//
// Field syntax is the classic 5-field subset: numbers, "*", "*/n", "a-b",
// "a-b/n", comma lists. dom/dow keep the standard cron quirk -- when BOTH are
// restricted (neither is "*") the job fires when EITHER matches, not both.

"use strict";

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 }, // 0 and 7 both mean Sunday
];

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`invalid step "/${stepText}" in ${field.name} field "${text}"`);
      }
      step = Number(stepText);
    }
    let lo, hi;
    if (range === "*") {
      lo = field.min;
      hi = field.max;
    } else if (/^\d+$/.test(range)) {
      if (slash !== -1) {
        throw new Error(`step needs "*" or a range before the "/" in ${field.name} field "${text}"`);
      }
      lo = hi = Number(range);
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) {
        throw new Error(`cannot parse "${part}" in ${field.name} field "${text}"`);
      }
      lo = Number(m[1]);
      hi = Number(m[2]);
      if (lo > hi) {
        throw new Error(`range "${range}" is reversed in ${field.name} field "${text}"`);
      }
    }
    if (lo < field.min || hi > field.max) {
      throw new Error(`${field.name} value in "${part}" is out of range ${field.min}-${field.max}`);
    }
    for (let v = lo; v <= hi; v += step) {
      // Normalize the two spellings of Sunday to one so matching is a Set hit.
      values.add(field.max === 7 && v === 7 ? 0 : v);
    }
  }
  return values;
}

function parseCron(expr) {
  if (typeof expr !== "string" || expr.trim() === "") {
    throw new Error("cron expression must be a non-empty string");
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5 cron fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const [min, hour, dom, mon, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    min, hour, dom, mon, dow,
    // Vixie star-flag semantics: a field starting with "*" (including "*/n")
    // is UNrestricted; only such-restricted dom/dow pairs get the OR rule.
    domRestricted: parts[2][0] !== "*",
    dowRestricted: parts[4][0] !== "*",
  };
}

function matches(c, date) {
  if (!c.min.has(date.getUTCMinutes())) return false;
  if (!c.hour.has(date.getUTCHours())) return false;
  if (!c.mon.has(date.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(date.getUTCDate());
  const dowOk = c.dow.has(date.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function cronMatches(expr, date) {
  return matches(parseCron(expr), date);
}

// Day-first scan: check the date fields once per day and only expand into
// hours/minutes on matching days. Worst case (never-matching expression) is
// ~1462 day checks, not half a million minute checks -- cheap enough that the
// gate can call this per job on every /cron/jobs request. The 4-year horizon
// exists so "0 0 29 2 *" (leap day) still reports its real next run.
function dayMatches(c, d) {
  if (!c.mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextRun(expr, from) {
  const c = parseCron(expr);
  const hours = [...c.hour].sort((a, b) => a - b);
  const mins = [...c.min].sort((a, b) => a - b);
  // Strictly after 'from': start from the next minute boundary.
  const start = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  let day = new Date(start);
  day = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  for (let i = 0; i < 1462; i++, day += 24 * 60 * 60000) {
    const d = new Date(day);
    if (!dayMatches(c, d)) continue;
    for (const h of hours) {
      for (const m of mins) {
        const t = day + (h * 60 + m) * 60000;
        if (t >= start) return new Date(t);
      }
    }
  }
  return null;
}

module.exports = { parseCron, cronMatches, nextRun };
