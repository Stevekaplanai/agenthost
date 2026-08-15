"use strict";

// `openclaw message send` starts a heavyweight Node process. Letting several
// replies spawn it at once exhausted the 4 GB box even though engine turns
// themselves were serialized. This tiny owner keeps exactly one delivery
// process active and bounds the in-memory backlog.
function createChannelDeliveryLimiter({ run, maxPending = 32, onQuarantine = null } = {}) {
  if (typeof run !== "function") throw new Error("channel delivery limiter requires run");
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("maxPending must be a positive integer");

  const pending = [];
  let active = false;
  let quarantined = false;
  const quarantineError = "OpenClaw delivery lane quarantined until the box restarts.";

  function notify(done, error) {
    try { if (typeof done === "function") done(error || null); } catch {}
  }

  function quarantine(reason) {
    if (quarantined) return false;
    quarantined = true;
    for (const waiting of pending.splice(0)) notify(waiting.done, quarantineError);
    try { if (typeof onQuarantine === "function") onQuarantine(String(reason || quarantineError)); } catch {}
    return true;
  }

  function drain() {
    if (active || quarantined) return;
    const next = pending.shift();
    if (!next) return;
    active = true;
    let finished = false;
    const finish = (error, options) => {
      if (finished) return;
      finished = true;
      if (options && options.quarantine) {
        quarantine(error);
        notify(next.done, quarantineError);
        return;
      }
      active = false;
      notify(next.done, error);
      queueMicrotask(drain);
    };
    try { run(next.job, finish); }
    catch (error) { finish(String((error && error.message) || error)); }
  }

  function enqueue(job, done) {
    if (quarantined) {
      notify(done, quarantineError);
      return false;
    }
    if (pending.length >= maxPending) {
      notify(done, "OpenClaw delivery queue is full.");
      return false;
    }
    pending.push({ job, done });
    drain();
    return true;
  }

  return Object.freeze({
    enqueue,
    quarantine,
    stats: () => ({ active: active ? 1 : 0, pending: pending.length, quarantined }),
  });
}

function createChannelReplyRunner({
  spawn,
  argsFor,
  environment,
  launchCandidate,
  timeoutMs = 30000,
  killGraceMs = 2000,
} = {}) {
  const brokered = typeof launchCandidate === "function";
  if (!brokered && (typeof spawn !== "function" || typeof argsFor !== "function" || typeof environment !== "function")) {
    throw new Error("channel reply runner requires launchCandidate or spawn, argsFor, and environment");
  }

  return function runChannelReplyDelivery(job, finish) {
    const { channel, candidates, text } = job;
    const env = brokered ? null : environment();
    const attempt = (idx, lastError) => {
      if (idx >= candidates.length) { finish(lastError || "delivery failed"); return; }
      let child;
      try {
        child = brokered
          ? launchCandidate(channel, candidates[idx], text)
          : spawn("openclaw", argsFor(channel, candidates[idx], text), {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
      } catch (error) {
        attempt(idx + 1, String((error && error.message) || error));
        return;
      }

      let errTail = "";
      let settled = false;
      let timer = null;
      let killGrace = null;
      const failure = (code) =>
        `openclaw message send exited ${code}${errTail ? ": " + errTail.trim() : ""}`;
      const settleAttempt = (error, options) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killGrace) clearTimeout(killGrace);
        if (options && options.kill) {
          try { child.kill("SIGKILL"); } catch {}
        }
        if (options && options.quarantine) {
          finish(error, options);
          return;
        }
        if (!error) { finish(null); return; }
        attempt(idx + 1, error);
      };

      try {
        child.stderr.on("data", (chunk) => { errTail = (errTail + chunk).slice(-400); });
        child.once("error", (error) => {
          const unprovenLiveProcess = child.terminationProven === false
            || child.pid && child.exitCode === null && child.signalCode === null;
          settleAttempt(
            String(error.message || error),
            unprovenLiveProcess ? { quarantine: true } : undefined,
          );
        });
        const terminal = (code) => child.terminationProven === false
          ? settleAttempt("delivery broker lost termination proof", { quarantine: true })
          : settleAttempt(code === 0 ? null : failure(code));
        child.once("exit", terminal);
        child.once("close", terminal);
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          killGrace = setTimeout(() => settleAttempt(
            "openclaw message send timed out without a terminal process event",
            { quarantine: true },
          ), killGraceMs);
          killGrace.unref();
        }, timeoutMs);
        timer.unref();
      } catch (error) {
        const message = `openclaw message send setup failed without a terminal process event: ${
          String((error && error.message) || error)
        }`;
        const terminalProven = child.exitCode !== null && child.exitCode !== undefined
          || child.signalCode !== null && child.signalCode !== undefined;
        settleAttempt(message, terminalProven ? undefined : { quarantine: true, kill: true });
      }
    };
    attempt(0, null);
  };
}

module.exports = { createChannelDeliveryLimiter, createChannelReplyRunner };
