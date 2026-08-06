# AGENTS.md

## Cursor Cloud specific instructions

This repo (`agenthost-cli`) is a zero-runtime-dependency Node.js (ESM, `>=18`) project with two parts:

- The **CLI** (`bin/cli.js` + `src/`): the `agenthost` command. It deploys a harness to Fly.io by shelling out to `flyctl`. Commands: `deploy`, `status`, `open`, `logs`, `sync`, `onboard`, `bridge`, `doctor`, `restart`, `fleet`, `snapshot`, `restore`, `destroy`.
- The **container web app** (`container/`): the mobile PWA (terminal shell, `/chat`, `/cron` "Loops", `/cc` Command Center) served in production by `container/gate.js` inside the Fly Docker image.

### Install / test / build / run

- Dependencies: `npm install` (the only dependency is `playwright-core`, a devDependency for UI tests). There is no lockfile by design; do not add one.
- Unit tests: `npm test` (Node's built-in `node --test`, no browser needed). See `package.json`.
- UI tests: `npm run test:ui` (Playwright against the real container HTML via `test/ui/rig.mjs`). It sets `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, which does not exist on this VM — `playwright-core` then automatically falls back to the pre-installed system Chrome (`channel: "chrome"`), so no browser download is required.
- There is no lint config and no build step. `deploy` builds/deploys remotely on Fly.

### Running the app locally (non-obvious)

There is no standalone dev server for the container web app — production boots `ttyd` + `tmux` + agent engines inside the Fly image, which is not reproducible directly on this VM. To exercise the **real** UI locally, drive the container HTML/JS through the UI rig, which serves the actual `appshell.js` / `chat.html` / `cron.html` / `cc.html` / `gate.js` nav with faked backends:

```js
// e.g. node /tmp/run-app.mjs
import { startRig } from "/workspace/test/ui/rig.mjs";
const { port } = await startRig();
console.log(`http://127.0.0.1:${port}`); // routes: /  /chat  /cron  /cc
```

The CLI can be exercised without a Fly account using `--dry-run`. Note `deploy` first calls `detectHarness()`, which requires a `~/.claude` directory to exist (create a minimal one for a dry-run), e.g.:

```
node bin/cli.js deploy --org <org> --app <name> --dry-run
```

### Known pre-existing test failures (not environment problems)

On a clean `main` checkout with no code changes:

- `npm test`: 7 failures. The `legal-pack` tests need `packs/legal/skills`, which is not committed to this repo; the 3 `gate-chat-hooks` cases expect `{}` but get `{ engine: 'claude' }`.
- `npm run test:ui`: 1 failure ("chat active tab is 'chat' and links back to terminal" expects `/` but gets `/cc`).

These are repo/test-content mismatches, unrelated to environment setup.
