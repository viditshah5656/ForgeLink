import os from "node:os";

export function getDeviceSummary({ platform = os.platform(), release = os.release(), arch = os.arch(), cpus = os.cpus(), totalMemory = os.totalmem(), freeMemory = os.freemem(), uptime = os.uptime(), nodeVersion = process.versions.node } = {}) {
  return {
    platform,
    release,
    architecture: arch,
    cpu: {
      model: cpus[0]?.model || "Unknown",
      logicalCores: cpus.length,
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: Math.max(0, totalMemory - freeMemory),
    },
    uptimeSeconds: Math.floor(uptime),
    runtimes: { node: nodeVersion },
  };
}

export function normalizeProcessList(value, limit = 150) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.slice(0, limit).flatMap((entry) => {
    const pid = Number(entry.pid ?? entry.Id);
    const parentPid = Number(entry.parentPid ?? entry.ParentProcessId);
    const name = String(entry.name ?? entry.ProcessName ?? entry.comm ?? "").split(/[\\/]/).pop().slice(0, 160);
    const memoryBytes = Number(entry.memoryBytes ?? entry.WorkingSet64 ?? (Number(entry.rss) * 1024));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name) return [];
    return [{
      pid,
      ...(Number.isSafeInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
      name,
      ...(Number.isFinite(memoryBytes) && memoryBytes >= 0 ? { memoryBytes } : {}),
    }];
  });
}

export function normalizeListenerList(value, limit = 300) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.slice(0, limit).flatMap((entry) => {
    const port = Number(entry.port ?? entry.LocalPort);
    const pid = Number(entry.pid ?? entry.OwningProcess);
    const address = String(entry.address ?? entry.LocalAddress ?? "").slice(0, 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
    return [{ address, port, ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) }];
  });
}
