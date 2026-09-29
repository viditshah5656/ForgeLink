// One connection attempt owns one App instance. A timed-out handshake is closed
// before retrying, so late replies cannot revive an obsolete viewer session.
export function createViewerBridge({ createApp, onConnected = () => {}, onUnavailable = () => {}, timeoutMs = 12_000, schedule = setTimeout, cancel = clearTimeout }) {
  let app = createApp();
  let attempt = null;
  let timer = null;
  let generation = 0;
  let connected = false;
  let disposed = false;

  const close = (instance) => {
    try { Promise.resolve(instance.close()).catch(() => {}); } catch {}
  };
  const retire = (instance) => {
    close(instance);
    if (!disposed && app === instance) app = createApp();
  };

  async function connect() {
    if (disposed) return false;
    if (connected) return true;
    if (attempt) return attempt;
    const instance = app;
    const ticket = ++generation;
    attempt = new Promise((resolve) => {
      let finished = false;
      const finish = (success, error) => {
        if (finished) return;
        finished = true;
        if (timer !== null) { cancel(timer); timer = null; }
        if (ticket !== generation || disposed) { close(instance); resolve(false); return; }
        if (success) {
          connected = true;
          onConnected(instance);
        } else {
          retire(instance);
          onUnavailable(error);
        }
        resolve(success);
      };
      timer = schedule(() => finish(false, new Error('MCP Apps bridge handshake timed out')), timeoutMs);
      Promise.resolve().then(() => instance.connect()).then(
        () => finish(true),
        (error) => finish(false, error),
      );
    }).finally(() => { attempt = null; });
    return attempt;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    if (timer !== null) { cancel(timer); timer = null; }
    close(app);
  }

  return { get app() { return app; }, get connected() { return connected; }, connect, dispose };
}
