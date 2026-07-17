// Minimal, dependency-free flag parser. `--foo bar` -> {foo:"bar"}; flags
// named in `boolean` don't consume the next token; flags named in `array`
// accumulate repeats into a list (e.g. repeatable --env owner/repo:KEY=VALUE).
export function parseFlags(argv, { boolean = [], array = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      if (boolean.includes(key)) {
        out[key] = true;
        continue;
      }
      const val = argv[++i];
      if (array.includes(key)) {
        (out[key] ??= []).push(val);
      } else {
        out[key] = val;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}
