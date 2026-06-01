import { spawnSync } from 'child_process';
import * as net from 'net';
import { SidecarEntry } from './types';

const PORT_PROBE_TIMEOUT_MS = 400;
const PROBE_HOST = '127.0.0.1';

function isLocalhostHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** The explicit port of a URL, but only if it points at localhost (any protocol). */
function localhostPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!isLocalhostHost(u.hostname) || !u.port) return null;
    const n = Number(u.port);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The local TCP port a sidecar is expected to bind, inferred from its health URL
 * (or, failing that, its dashboard URL). Only localhost URLs count — the reclaim
 * probe targets 127.0.0.1, so a remote dashboard's port must not drive it.
 * Returns null if neither carries a usable localhost port.
 */
export function sidecarPort(entry: SidecarEntry): number | null {
  return localhostPort(entry.healthUrl) ?? localhostPort(entry.dashboardUrl);
}

/** True if something is already accepting connections on 127.0.0.1:port. */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false)); // ECONNREFUSED → nothing listening
    socket.connect(port, PROBE_HOST);
  });
}

/**
 * PIDs listening on the given TCP port. Best-effort and platform-specific
 * (lsof on macOS/Linux, netstat on Windows); returns [] if the tool is missing
 * or nothing is found.
 */
export function findListenerPids(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      if (!out.stdout) return [];
      const pids = new Set<number>();
      for (const line of out.stdout.split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (!out.stdout) return [];
    return out.stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** SIGKILL (taskkill /T /F on Windows) the given pids. Returns the pids signalled without error. */
export function killPids(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
      } else {
        process.kill(pid, 'SIGKILL');
      }
      killed.push(pid);
    } catch {
      /* already gone or no permission */
    }
  }
  return killed;
}
