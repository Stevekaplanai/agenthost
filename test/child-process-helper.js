export function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    child.once("exit", done);
    if (child.exitCode !== null || child.signalCode !== null) return done();
    try { child.kill(signal); } catch { return done(); }
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 2500);
    timer.unref();
  });
}
