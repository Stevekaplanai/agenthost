import crypto from "node:crypto";
import https from "node:https";
import * as fly from "../fly.js";
import { appStatePath, loadOriginState, updateAppState } from "../state.js";
import { resolveApp } from "./resolve-app.js";

const ACCESS_KEY_HISTORY_LIMIT = 64;
const ACCESS_KEY_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REMOTE_PREFIX = "AGENTHOST_AUTH_SNAPSHOT_V1:";
const REMOTE_ERROR_PREFIX = "AGENTHOST_AUTH_SNAPSHOT_ERROR_V1:";
const REMOTE_OUTPUT_MAX_BYTES = 32768;
const POST_DEPLOY_POLL_ATTEMPTS = 30;

export function accessKeyFingerprint(value) {
  return crypto.createHash("sha256")
    .update("agenthost-auth-access-key-v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function retiredAccessKeyHistory(existing, currentFingerprint) {
  const value = existing.retiredAccessKeyFingerprints;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ACCESS_KEY_HISTORY_LIMIT ||
      value.some((fingerprint) => typeof fingerprint !== "string" || !ACCESS_KEY_FINGERPRINT_RE.test(fingerprint)) ||
      new Set(value).size !== value.length || value.includes(currentFingerprint)) {
    throw new Error("saved retired access-key history is invalid; no Fly changes were made");
  }
  return [...value];
}

function sameFingerprintHistory(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((fingerprint, index) => fingerprint === right[index]);
}

function safeDetail(value, secret) {
  const detail = String(value || "unknown Fly failure");
  return detail.split(secret).join("[REDACTED]").slice(0, 1000);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function validateRemoteMarker(marker) {
  const expected = [
    "keyFingerprint", "mode", "ownerGid", "ownerUid", "retiredKeyFingerprints",
    "rotationRequired", "version",
  ];
  if (!exactKeys(marker, expected)) throw new Error("remote authentication marker has an invalid schema");
  if (marker.version !== 2 || marker.mode !== "foundation") {
    throw new Error("remote authentication marker is not Foundation schema version 2");
  }
  if (!ACCESS_KEY_FINGERPRINT_RE.test(marker.keyFingerprint) || typeof marker.rotationRequired !== "boolean") {
    throw new Error("remote authentication marker has an invalid fingerprint or rotation state");
  }
  if (!Number.isInteger(marker.ownerUid) || marker.ownerUid < 0 ||
      !Number.isInteger(marker.ownerGid) || marker.ownerGid < 0) {
    throw new Error("remote authentication marker has invalid owner ids");
  }
  const history = marker.retiredKeyFingerprints;
  if (!Array.isArray(history) || history.length > ACCESS_KEY_HISTORY_LIMIT ||
      history.some((value) => typeof value !== "string" || !ACCESS_KEY_FINGERPRINT_RE.test(value)) ||
      new Set(history).size !== history.length) {
    throw new Error("remote authentication marker has an invalid retired-key history");
  }
  return {
    ...marker,
    retiredKeyFingerprints: [...history],
  };
}

function validateRemoteSnapshot(snapshot) {
  if (!exactKeys(snapshot, [
    "appName", "canonicalHost", "dataIdentity", "marker", "pending", "recoveryRequired", "rotationRequired",
  ])) {
    throw new Error("remote authentication snapshot has an invalid schema");
  }
  if (typeof snapshot.appName !== "string" || !APP_NAME_RE.test(snapshot.appName)) {
    throw new Error("remote authentication snapshot has an invalid Fly app name");
  }
  if (typeof snapshot.canonicalHost !== "string" ||
      (snapshot.canonicalHost !== "" && (
        snapshot.canonicalHost.length > 253 ||
        !snapshot.canonicalHost.split(".").every((label) =>
          label.length >= 1 && label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
      ))) {
    throw new Error("remote authentication snapshot has an invalid canonical hostname");
  }
  if (!exactKeys(snapshot.dataIdentity, ["dev", "ino"]) ||
      !/^\d+$/.test(snapshot.dataIdentity.dev) || !/^\d+$/.test(snapshot.dataIdentity.ino)) {
    throw new Error("remote data-volume identity is invalid");
  }
  if (typeof snapshot.pending !== "boolean" || typeof snapshot.recoveryRequired !== "boolean" ||
      typeof snapshot.rotationRequired !== "boolean") {
    throw new Error("remote authentication-state flags are invalid");
  }
  return { ...snapshot, marker: validateRemoteMarker(snapshot.marker) };
}

function recoveryOrigin(snapshot, requestedApp) {
  if (snapshot.appName !== requestedApp) {
    throw new Error("remote Fly app identity does not match the requested app; no Fly changes were made");
  }
  return snapshot.canonicalHost
    ? `https://${snapshot.canonicalHost}`
    : `https://${requestedApp}.fly.dev`;
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePreRotation(snapshot) {
  const state = validateRemoteSnapshot(snapshot);
  if (state.pending) throw new Error("remote authentication transition has a pending journal");
  if (!state.marker.rotationRequired || !state.rotationRequired || state.recoveryRequired) {
    throw new Error("remote authentication state does not prove that access-key rotation is required");
  }
  if (!state.marker.retiredKeyFingerprints.includes(state.marker.keyFingerprint)) {
    throw new Error("remote current access-key fingerprint is missing from its retired-key history");
  }
  return state;
}

function validateActivated(snapshot, candidateFingerprint, expected = null) {
  const state = validateRemoteSnapshot(snapshot);
  if (state.pending) throw new Error("remote authentication transition has a pending journal");
  if (state.rotationRequired || state.marker.rotationRequired) {
    throw new Error("remote authentication state still requires access-key rotation");
  }
  if (state.marker.keyFingerprint !== candidateFingerprint) {
    throw new Error("remote authentication marker does not identify the supplied recovery key");
  }
  if (state.marker.retiredKeyFingerprints.includes(candidateFingerprint)) {
    throw new Error("remote authentication marker retired the supplied recovery key");
  }
  if (state.marker.retiredKeyFingerprints.length === 0) {
    throw new Error("remote authentication marker has no retired-key history");
  }
  if (expected) {
    if (state.dataIdentity.dev !== expected.dataIdentity.dev || state.dataIdentity.ino !== expected.dataIdentity.ino) {
      throw new Error("remote data-volume identity changed during access-key recovery");
    }
    if (state.appName !== expected.appName || state.canonicalHost !== expected.canonicalHost) {
      throw new Error("remote application identity changed during access-key recovery");
    }
    if (state.marker.ownerUid !== expected.marker.ownerUid || state.marker.ownerGid !== expected.marker.ownerGid ||
        !sameFingerprintHistory(state.marker.retiredKeyFingerprints, expected.marker.retiredKeyFingerprints)) {
      throw new Error("remote access-key history or owner identity changed during recovery");
    }
  }
  return state;
}

const REMOTE_SNAPSHOT_SOURCE = String.raw`
const fs=require("fs");
const root="/data/agenthost-gate-state",auth=root+"/auth",O_NOFOLLOW=fs.constants.O_NOFOLLOW||0,O_NONBLOCK=fs.constants.O_NONBLOCK||0;
function exact(st,uid,gid,mode,label){if(st.isSymbolicLink()||st.uid!==uid||st.gid!==gid||(st.mode&0o777)!==mode)throw new Error(label+" ownership or mode is unsafe")}
function bounded(file,max,required=false,uid=0,gid=0,mode=0o600){let before;try{before=fs.lstatSync(file)}catch(e){if(e&&e.code==="ENOENT"&&!required)return null;throw e}if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.size<1||before.size>max)throw new Error("unsafe protected authentication file");exact(before,uid,gid,mode,"protected authentication file");let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|O_NOFOLLOW|O_NONBLOCK);const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error("protected authentication file changed while opening");exact(opened,uid,gid,mode,"opened authentication file");const buf=Buffer.alloc(opened.size);let off=0;while(off<buf.length){const count=fs.readSync(fd,buf,off,buf.length-off,off);if(!count)throw new Error("protected authentication file ended unexpectedly");off+=count}return buf.toString("utf8")}finally{if(fd!==undefined)fs.closeSync(fd)}}
try{const data=fs.lstatSync("/data");if(data.isSymbolicLink()||!data.isDirectory())throw new Error("data volume path is unsafe");const appName=String(process.env.FLY_APP_NAME||"");if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appName))throw new Error("FLY_APP_NAME is invalid");const canonicalHost=String(process.env.AGENTHOST_CANONICAL_HOST||"");if(canonicalHost!==""&&(canonicalHost.length>253||!canonicalHost.split(".").every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))))throw new Error("AGENTHOST_CANONICAL_HOST is invalid");const rootStat=fs.lstatSync(root);if(!rootStat.isDirectory())throw new Error("gate-state root is unsafe");exact(rootStat,0,0,0o711,"gate-state root");const marker=JSON.parse(bounded(root+"/auth-transition.json",16384,true,0,0,0o600));if(!Number.isInteger(marker.ownerUid)||!Number.isInteger(marker.ownerGid)||marker.ownerUid<0||marker.ownerGid<0)throw new Error("authentication marker owner ids are invalid");const authStat=fs.lstatSync(auth);if(!authStat.isDirectory())throw new Error("authentication directory is unsafe");exact(authStat,marker.ownerUid,marker.ownerGid,0o700,"authentication directory");const pending=bounded(root+"/auth-transition.pending.json",16384,false,0,0,0o600)!==null;const rotation=bounded(auth+"/auth.rotation-required",256,false,marker.ownerUid,marker.ownerGid,0o600);const recovery=bounded(auth+"/auth.recovery-required",256,false,marker.ownerUid,marker.ownerGid,0o600);if(rotation!==null&&rotation!=="rotate-operator-access-key-v1\n")throw new Error("rotation marker is corrupt");if(recovery!==null&&recovery!=="confirm-key-only-recovery-v1\n")throw new Error("recovery marker is corrupt");const out={appName,canonicalHost,dataIdentity:{dev:String(data.dev),ino:String(data.ino)},marker,pending,recoveryRequired:recovery!==null,rotationRequired:rotation!==null};process.stdout.write("${REMOTE_PREFIX}"+Buffer.from(JSON.stringify(out)).toString("base64")+"\n")}catch(e){const cause=String(e&&e.message||e).replace(/[\r\n]/g," ").slice(0,240);process.stdout.write("${REMOTE_ERROR_PREFIX}"+Buffer.from(cause).toString("base64")+"\n");process.exitCode=1}
`;
const REMOTE_SNAPSHOT_COMMAND = `node -e "eval(Buffer.from('${Buffer.from(REMOTE_SNAPSHOT_SOURCE).toString("base64")}','base64').toString('utf8'))"`;

function defaultListMachines(app) {
  const result = fly.run(["machines", "list", "-a", app, "--json"]);
  if (!result || result.code !== 0) {
    throw new Error(`could not list Fly machines: ${String(result?.stderr || result?.stdout || "unknown flyctl failure").slice(0, 500)}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Fly machine list returned invalid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("Fly machine list returned an invalid shape");
  return parsed.map((machine) => ({
    id: machine?.id || machine?.ID,
    state: String(machine?.state || machine?.State || "").toLowerCase(),
  }));
}

function defaultReadRemoteAuthState(app, machineId) {
  const output = fly.sshConsoleOutput(app, REMOTE_SNAPSHOT_COMMAND, machineId);
  if (Buffer.byteLength(output, "utf8") > REMOTE_OUTPUT_MAX_BYTES) {
    throw new Error("remote authentication snapshot exceeded 32768 bytes");
  }
  const lines = String(output).split(/\r?\n/);
  const errors = lines.filter((line) => line.startsWith(REMOTE_ERROR_PREFIX));
  if (errors.length) {
    let detail = "remote snapshot helper failed";
    try { detail = Buffer.from(errors[0].slice(REMOTE_ERROR_PREFIX.length), "base64").toString("utf8"); } catch {}
    throw new Error(`remote authentication snapshot failed: ${detail.slice(0, 240)}`);
  }
  const matches = lines.filter((line) => line.startsWith(REMOTE_PREFIX));
  if (matches.length !== 1) throw new Error("remote authentication snapshot was missing or ambiguous");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(matches[0].slice(REMOTE_PREFIX.length), "base64").toString("utf8"));
  } catch {
    throw new Error("remote authentication snapshot was not valid bounded JSON");
  }
  return validateRemoteSnapshot(parsed);
}

function defaultAcknowledgeRecovery(origin, accessKey, request = https.request) {
  const url = new URL("/session", origin);
  const body = JSON.stringify({ key: accessKey, recoverWithout2fa: true });
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Host": url.host,
        "Origin": origin,
      },
      timeout: 30000,
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) req.destroy(new Error("session recovery response exceeded 4096 bytes"));
      });
      res.on("aborted", () => reject(new Error("session recovery response was aborted")));
      res.on("error", reject);
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        cookie: Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] : res.headers["set-cookie"],
      }));
    });
    req.on("timeout", () => req.destroy(new Error("session recovery request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function validateAccessKey(accessKey) {
  if (typeof accessKey !== "string" || accessKey.length < 16) {
    throw new Error("the new access key must be at least 16 characters");
  }
  if (Buffer.byteLength(accessKey, "utf8") > 256) {
    throw new Error("the new access key must be at most 256 UTF-8 bytes");
  }
  if (/[\u0000-\u001f\u007f]/.test(accessKey)) {
    throw new Error("the new access key cannot contain control characters or line breaks");
  }
}

function saveRecoveryState(app, accessKey, origin, history, { saveState, loadState }) {
  try {
    saveState(app, { origin, ttydPassword: accessKey, retiredAccessKeyFingerprints: history });
  } catch (error) {
    let installed = null;
    try { installed = loadState(app); } catch {}
    if (installed?.ttydPassword === accessKey && installed?.origin === origin &&
        sameFingerprintHistory(installed.retiredAccessKeyFingerprints, history)) {
      throw new Error(
        `Fly recovery finished for '${app}', and the local record contains it, but crash-safe durability `
        + `could not be confirmed because ${safeDetail(error?.message, accessKey)}. Do not run rotate-key again. `
        + `Before restarting this computer, copy '${appStatePath(app)}' to a safe local location.`,
      );
    }
    throw new Error(
      `Fly recovery finished for '${app}', but local saved state could not be updated: `
      + `${safeDetail(error?.message, accessKey)}. Run rotate-key again with the same key and recovery flags.`,
    );
  }
}

async function recoverMissingState(app, flags, accessKey, deps) {
  if (deps.loadState(app) !== null) {
    throw new Error(`saved state for '${app}' is incomplete or already exists; missing-state recovery requires the trusted app record to be truly absent`);
  }
  const machines = deps.listMachines(app);
  if (!Array.isArray(machines) || machines.length !== 1 || !machines[0]?.id || machines[0].state !== "started") {
    throw new Error("missing-state recovery requires exactly one started machine on Fly");
  }
  const machineId = machines[0].id;
  const candidateFingerprint = accessKeyFingerprint(accessKey);
  const first = validateRemoteSnapshot(await deps.readRemoteAuthState(app, machineId));
  const origin = recoveryOrigin(first, app);

  let activated;
  if (!first.pending && !first.rotationRequired && !first.marker.rotationRequired &&
      first.marker.keyFingerprint === candidateFingerprint &&
      !first.marker.retiredKeyFingerprints.includes(candidateFingerprint)) {
    activated = validateActivated(first, candidateFingerprint);
  } else {
    if (candidateFingerprint === first.marker.keyFingerprint ||
        first.marker.retiredKeyFingerprints.includes(candidateFingerprint)) {
      throw new Error("the supplied recovery key matches a current or retired remote key; choose a key that has never been used");
    }
    const pre = validatePreRotation(first);
    const immediate = validatePreRotation(await deps.readRemoteAuthState(app, machineId));
    if (!sameSnapshot(pre, immediate)) {
      throw new Error("remote authentication state changed immediately before staging; no Fly changes were made");
    }
    try {
      await deps.stageSecrets(app, { TTYD_PASSWORD: accessKey });
    } catch (error) {
      throw new Error(`Fly could not stage the recovery key for '${app}': ${safeDetail(error?.message, accessKey)}. Local state was not created.`);
    }
    let release;
    try { release = await deps.deployStagedSecrets(app); }
    catch (error) {
      throw new Error(`Fly staged the recovery key for '${app}' but could not apply it: ${safeDetail(error?.message, accessKey)}. Local state was not created.`);
    }
    if (!release || release.code !== 0) {
      throw new Error(
        `Fly staged the recovery key for '${app}' but could not apply it: `
        + `${safeDetail(release?.stderr || release?.stdout, accessKey)}. Local state was not created.`,
      );
    }
    let lastCause = "the restarted machine did not return an authentication snapshot";
    for (let attempt = 0; attempt < deps.pollAttempts; attempt += 1) {
      if (attempt > 0) await deps.sleep(2000);
      try {
        const candidate = validateActivated(
          await deps.readRemoteAuthState(app, machineId),
          candidateFingerprint,
          pre,
        );
        if (!candidate.recoveryRequired) throw new Error("remote key-only recovery marker was not created");
        activated = candidate;
        break;
      } catch (error) {
        lastCause = safeDetail(error?.message, accessKey);
      }
    }
    if (!activated) {
      throw new Error(
        `Fly applied the staged recovery release, but post-restart proof timed out because ${lastCause}. `
        + "Local state was not created; retry with the same key and recovery flags.",
      );
    }
  }

  if (activated.recoveryRequired) {
    let acknowledged;
    try { acknowledged = await deps.acknowledgeRecovery(origin, accessKey); }
    catch (error) {
      throw new Error(`the new key is active, but key-only recovery could not be acknowledged because ${safeDetail(error?.message, accessKey)}. Run the same recovery command again.`);
    }
    if (acknowledged?.statusCode !== 204 ||
        typeof acknowledged.cookie !== "string" || !/^agenthost_auth=[^;]+(?:;|$)/.test(acknowledged.cookie)) {
      throw new Error(
        `the new key is active, but canonical session recovery returned HTTP ${acknowledged?.statusCode ?? "unknown"} `
        + "without the required in-memory session cookie. Run the same recovery command again.",
      );
    }
  }

  const finalState = validateActivated(
    await deps.readRemoteAuthState(app, machineId),
    candidateFingerprint,
    activated,
  );
  if (finalState.recoveryRequired) {
    throw new Error("key-only recovery was acknowledged, but the protected recovery marker remains; local state was not created");
  }
  saveRecoveryState(app, accessKey, origin, finalState.marker.retiredKeyFingerprints, deps);
  deps.log(`Access-key recovery completed for '${app}'. The canonical operator session was verified.`);
  return { app };
}

export async function rotateKeyCommand(flags, {
  stageSecrets = fly.stageSecretsViaApi,
  deployStagedSecrets = fly.deployStagedSecrets,
  loadState = loadOriginState,
  saveState = updateAppState,
  listMachines = defaultListMachines,
  readRemoteAuthState = defaultReadRemoteAuthState,
  acknowledgeRecovery = defaultAcknowledgeRecovery,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollAttempts = POST_DEPLOY_POLL_ATTEMPTS,
  log = console.log,
} = {}) {
  const app = resolveApp(flags);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(app)) {
    throw new Error("invalid Fly app name; use lowercase letters, numbers, and hyphens");
  }
  const accessKey = flags["access-key"];
  validateAccessKey(accessKey);

  const dependencies = {
    stageSecrets, deployStagedSecrets, loadState, saveState, listMachines,
    readRemoteAuthState, acknowledgeRecovery, sleep, pollAttempts, log,
  };
  if (flags.origin !== undefined) {
    throw new Error("--origin is not accepted; missing-state recovery derives the only allowed origin from the protected box identity");
  }
  if (flags["recover-missing-state"]) {
    return recoverMissingState(app, flags, accessKey, dependencies);
  }

  // Fly never returns secret values, so the trusted local record is the only
  // safe way to prove this is a different key before touching the live box.
  const existing = loadState(app);
  if (!existing || typeof existing.ttydPassword !== "string" || !existing.ttydPassword) {
    throw new Error(
      `no trusted saved access key exists for '${app}' on this machine; `
      + "rotate it from the machine that deployed this box",
    );
  }

  const currentFingerprint = accessKeyFingerprint(existing.ttydPassword);
  const candidateFingerprint = accessKeyFingerprint(accessKey);
  const retiredFingerprints = retiredAccessKeyHistory(existing, currentFingerprint);
  if (candidateFingerprint === currentFingerprint) {
    throw new Error("the new access key matches the saved key; choose a different key");
  }
  if (retiredFingerprints.includes(candidateFingerprint)) {
    throw new Error("the new access key was previously retired; choose a key that has never been used");
  }
  if (retiredFingerprints.length >= ACCESS_KEY_HISTORY_LIMIT) {
    throw new Error("retired access-key history is full; refusing to forget an older key");
  }
  const nextRetiredFingerprints = [...retiredFingerprints, currentFingerprint];

  try {
    await stageSecrets(app, { TTYD_PASSWORD: accessKey });
  } catch (error) {
    throw new Error(
      `Fly could not stage the new access key for '${app}': `
      + `${safeDetail(error?.message, accessKey)}. Local saved key was not changed.`,
    );
  }

  let deployed;
  try {
    deployed = await deployStagedSecrets(app);
  } catch (error) {
    throw new Error(
      `Fly staged the new access key for '${app}' but could not apply it: `
      + `${safeDetail(error?.message, accessKey)}. Local saved key was not changed.`,
    );
  }
  if (!deployed || deployed.code !== 0) {
    throw new Error(
      `Fly staged the new access key for '${app}' but could not apply it: `
      + `${safeDetail(deployed?.stderr || deployed?.stdout, accessKey)}. `
      + "Local saved key was not changed.",
    );
  }

  try {
    saveState(app, {
      ttydPassword: accessKey,
      retiredAccessKeyFingerprints: nextRetiredFingerprints,
    });
  } catch (error) {
    let installed = null;
    try { installed = loadState(app); } catch {}
    if (installed?.ttydPassword === accessKey &&
        sameFingerprintHistory(installed.retiredAccessKeyFingerprints, nextRetiredFingerprints)) {
      throw new Error(
        `Fly applied the new access key for '${app}', and the local record contains it, `
        + `but crash-safe durability could not be confirmed because ${safeDetail(error?.message, accessKey)}. `
        + `Do not run rotate-key again. Before restarting this computer, copy '${appStatePath(app)}' `
        + "to a safe local location.",
      );
    }
    throw new Error(
      `Fly applied the new access key for '${app}', but local saved state could not be updated: `
      + `${safeDetail(error?.message, accessKey)}. Run rotate-key again with the same key.`,
    );
  }

  log(`Access key rotated for '${app}'. Fly restarted the box once; reopen it when boot finishes.`);
  return { app };
}
