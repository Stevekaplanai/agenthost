#!/bin/bash
# `skills` -- the AgentHost skill inventory. Shows the curated starter stack we
# pre-install, what's live on this box, and how to add ANY skill for free.
# Installed at /usr/local/bin/skills (see Dockerfile); reads the starter-stack
# manifest baked into the image + the box's live ~/.claude state.
set -u

HOME_DIR="${HOME:-/data/home/agent}"
MANIFEST="${AGENTHOST_STARTER_STACK:-/opt/agenthost/starter-stack.json}"
SETTINGS="$HOME_DIR/.claude/settings.json"
SKILLS_DIR="$HOME_DIR/.claude/skills"

# Colors only when stdout is a TTY (piping stays clean).
if [ -t 1 ]; then
    B=$'\033[1m'; DIM=$'\033[2m'; ACC=$'\033[38;5;209m'; OK=$'\033[38;5;42m'
    WARN=$'\033[38;5;214m'; MUT=$'\033[38;5;244m'; R=$'\033[0m'
else
    B=""; DIM=""; ACC=""; OK=""; WARN=""; MUT=""; R=""
fi

if [ ! -f "$MANIFEST" ]; then
    echo "skills: manifest not found at $MANIFEST" >&2
    exit 1
fi

# All rendering + state checks in one python3 pass (python3 ships in the image).
MANIFEST="$MANIFEST" SETTINGS="$SETTINGS" SKILLS_DIR="$SKILLS_DIR" \
B="$B" DIM="$DIM" ACC="$ACC" OK="$OK" WARN="$WARN" MUT="$MUT" R="$R" \
python3 - "$@" <<'PY'
import json, os, sys

def env(k): return os.environ.get(k, "")
B, DIM, ACC, OK, WARN, MUT, R = (env(k) for k in ["B","DIM","ACC","OK","WARN","MUT","R"])

manifest = json.load(open(env("MANIFEST")))
settings = {}
try: settings = json.load(open(env("SETTINGS")))
except Exception: pass
enabled = settings.get("enabledPlugins", {}) if isinstance(settings, dict) else {}
skills_dir = env("SKILLS_DIR")
# A skill is a DIRECTORY under ~/.claude/skills (each holds a SKILL.md). Filter
# to dirs so a stray file (.DS_Store, a README) never inflates the count, and so
# the headline number matches what the inventory below actually lists.
try:
    installed_skills = set(d for d in os.listdir(skills_dir)
                           if os.path.isdir(os.path.join(skills_dir, d)))
except Exception:
    installed_skills = set()

def badge(live, setup):
    if setup: return f"{WARN}needs setup{R}"
    return f"{OK}on{R}" if live else f"{MUT}available{R}"

def row(name, blurb, live, setup):
    print(f"  {ACC}●{R} {B}{name}{R}  {badge(live, setup)}")
    print(f"    {MUT}{blurb}{R}")
    if setup:
        print(f"    {WARN}→ {setup}{R}")

# --- header ---
print()
print(f"{B}Your box's skills{R} {MUT}— we pre-install the best; you can add any skill free{R}")
print()

cats = {}
for p in manifest.get("plugins", []):
    cats.setdefault(p.get("category","other"), []).append(("plugin", p))
for s in manifest.get("skills", []):
    cats.setdefault(s.get("category","other"), []).append(("skill", s))
for m in manifest.get("mcp", []):
    cats.setdefault(m.get("category","other"), []).append(("mcp", m))
for k in manifest.get("keyGated", []):
    cats.setdefault(k.get("category","other"), []).append(("keyed", k))

CAT_TITLE = {"developer":"For developers","marketing":"For marketers","media":"Media","other":"More"}
for cat in ["developer","marketing","media","other"]:
    items = cats.get(cat)
    if not items: continue
    print(f"{B}{CAT_TITLE.get(cat, cat)}{R}")
    for kind, it in items:
        if kind == "plugin":
            live = enabled.get(it["id"]) is True
            row(it["name"], it.get("blurb",""), live, it.get("setup"))
        elif kind == "skill":
            live = it["dir"] in installed_skills
            row(it["name"], it.get("blurb",""), live, it.get("setup"))
        elif kind == "mcp":
            row(it["name"], it.get("blurb",""), False, it.get("setup"))
        elif kind == "keyed":
            row(it["name"], it.get("blurb",""), True, it.get("setup"))
    print()

# --- the free story ---
total = len(installed_skills)
print(f"{B}Add any skill — free{R}")
print(f"  You already have {ACC}{total}{R} skills on this box. Every Claude Code skill and")
print(f"  plugin marketplace works here at no extra cost — it's your box.")
print(f"  {DIM}• A single skill:   git clone <repo> ~/.claude/skills/<name>{R}")
print(f"  {DIM}• A plugin pack:    in claude, /plugin marketplace add <owner>/<repo>{R}")
print(f"  {DIM}• The curated best are listed above — the /brain knows them too.{R}")
print()
PY
