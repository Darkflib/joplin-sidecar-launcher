import { spawn, ChildProcess } from 'child_process';
import { SidecarEntry, SidecarState, SidecarStatus, HealthStatus, LogLine } from './types';
import { checkHealth } from './health';

type StatusChangeCallback = (status: SidecarStatus) => void;

// Python env vars known to poison child interpreters
const PYTHON_ENV_BLOCKLIST = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX'];

/**
 * Sanitised child environment: strips Python vars that poison child interpreters,
 * marks the launch source, and injects the shared Joplin connection details
 * (token from the keychain). The token is never logged or included in diagnostics.
 */
function buildChildEnv(entry: SidecarEntry): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !PYTHON_ENV_BLOCKLIST.includes(k)) {
      env[k] = v;
    }
  }
  env['JOPLIN_SIDECAR_LAUNCHED_BY'] = 'joplin-sidecar-launcher';
  if (entry.joplinBaseUrl) env['JOPLIN_BASE_URL'] = entry.joplinBaseUrl;
  if (entry.joplinToken) env['JOPLIN_TOKEN'] = entry.joplinToken;
  return env;
}

/** Platform-appropriate "open this URL in the default browser" command. */
function osOpenCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd builtin; the empty "" is the window title placeholder.
      return { cmd: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}

/** Explicit port of an http(s) URL, or null if absent / unparsable. */
function portOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p || null;
  } catch {
    return null;
  }
}

/**
 * Open the sidecar dashboard. When the entry exposes an `open` subcommand
 * (detected by a `serve` arg, the Joplin-sidecar convention), invoke it so the
 * sidecar can read its ephemeral token file and hand the token off via the
 * dashboard URL fragment — without this round-trip the browser loads the
 * dashboard unauthenticated. Sidecars that don't follow that convention fall
 * back to the OS URL handler on `dashboardUrl`.
 */
export function openDashboard(entry: SidecarEntry): Promise<{ ok: boolean; message: string }> {
  const serveIdx = entry.command ? entry.args.indexOf('serve') : -1;
  if (serveIdx >= 0) {
    return openViaSidecarOpener(entry, serveIdx);
  }
  if (!entry.dashboardUrl) {
    return Promise.resolve({ ok: false, message: 'No dashboard URL configured for this sidecar.' });
  }
  const { cmd, args } = osOpenCommand(entry.dashboardUrl);
  return spawnOpener(cmd, args, undefined, undefined, `Opening ${entry.dashboardUrl} …`);
}

/**
 * Run `<command> <prefix> open --port <port>` in the same environment the
 * `serve` process gets (so JOPLIN_TOKEN etc. are available to the opener). The
 * port lets the sidecar locate the right ephemeral token file when more than
 * one instance is running.
 */
function openViaSidecarOpener(
  entry: SidecarEntry,
  serveIdx: number,
): Promise<{ ok: boolean; message: string }> {
  const port = portOf(entry.dashboardUrl) ?? portOf(entry.healthUrl) ?? '8765';
  const prefix = entry.args.slice(0, serveIdx);
  const openArgs = [...prefix, 'open', '--port', port];
  return spawnOpener(
    entry.command,
    openArgs,
    entry.cwd || process.env.HOME || undefined,
    buildChildEnv(entry),
    `Opening dashboard at http://127.0.0.1:${port}/ …`,
  );
}

function spawnOpener(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  successMessage: string,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; message: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, stdio: 'ignore', detached: true });
    } catch (e: unknown) {
      done({ ok: false, message: `Failed to open dashboard: ${(e as Error).message}` });
      return;
    }

    // The opener may fail to launch (ENOENT — no open/xdg-open) asynchronously via
    // 'error'; only report success once the process has actually spawned.
    child.once('error', (err) => {
      done({ ok: false, message: `Failed to open dashboard (${cmd}): ${err.message}` });
    });
    child.once('spawn', () => {
      child.unref();
      done({ ok: true, message: successMessage });
    });
  });
}

export class ProcessManager {
  private readonly id: string;
  private config: SidecarEntry | null = null;
  private child: ChildProcess | null = null;
  private state: SidecarState = 'stopped';
  private pid: number | undefined;
  private startedAt: string | undefined;
  private exitedAt: string | undefined;
  private exitCode: number | null | undefined;
  private signal: string | null | undefined;
  private health: HealthStatus = 'not_configured';
  private lastHealthAt: string | undefined;
  private lastHealthError: string | undefined;
  private logs: LogLine[] = [];
  private maxLogLines: number = 100;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private partialStdout: string = '';
  private partialStderr: string = '';

  private onStatusChange: StatusChangeCallback;

  constructor(id: string, onStatusChange: StatusChangeCallback) {
    this.id = id;
    this.onStatusChange = onStatusChange;
  }

  getStatus(): SidecarStatus {
    return {
      id: this.id,
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      health: this.health,
      lastHealthAt: this.lastHealthAt,
      lastHealthError: this.lastHealthError,
      recentLogs: [...this.logs],
    };
  }

  async start(config: SidecarEntry): Promise<{ ok: boolean; message: string }> {
    if (this.state !== 'stopped' && this.state !== 'crashed') {
      return { ok: false, message: `"${config.name}" is already ${this.state}. Stop it first.` };
    }
    if (!config.command) {
      return { ok: false, message: 'Command is empty. Configure it in the Sidecars JSON.' };
    }

    this.config = config;
    this.maxLogLines = config.maxLogLines;
    this.setState('starting');
    this.health = config.healthUrl ? 'unknown' : 'not_configured';
    this.exitCode = undefined;
    this.signal = undefined;
    this.exitedAt = undefined;
    this.startedAt = new Date().toISOString();

    // Sanitised environment (strips poisoning Python vars; injects Joplin details).
    const env = buildChildEnv(config);

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd || process.env.HOME || undefined,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Make the child its own process-group leader so we can signal the WHOLE
        // tree. Wrappers like `uv run python -m uvicorn` don't forward SIGTERM to
        // the grandchild that holds the port — killing only the immediate child
        // leaves it bound ("address already in use" on the next start).
        detached: true,
      });
    } catch (e: unknown) {
      const err = e as Error;
      this.setState('crashed');
      this.exitedAt = new Date().toISOString();
      this.appendLog('stderr', `Failed to spawn: ${err.message}`);
      return { ok: false, message: `Failed to start: ${err.message}` };
    }

    this.child = child;

    if (!child.pid) {
      // Spawned but got no PID — treat as immediate crash
      this.setState('crashed');
      this.exitedAt = new Date().toISOString();
      this.appendLog('stderr', 'Spawn returned no PID — process may not exist');
      return { ok: false, message: 'Process did not start (no PID).' };
    }

    this.pid = child.pid;
    this.setState('running');

    // stdout handler
    child.stdout?.on('data', (data: Buffer) => {
      this.partialStdout += data.toString('utf8');
      const lines = this.partialStdout.split('\n');
      this.partialStdout = lines.pop() ?? '';
      for (const line of lines) {
        if (line) this.appendLog('stdout', line);
      }
    });

    // stderr handler
    child.stderr?.on('data', (data: Buffer) => {
      this.partialStderr += data.toString('utf8');
      const lines = this.partialStderr.split('\n');
      this.partialStderr = lines.pop() ?? '';
      for (const line of lines) {
        if (line) this.appendLog('stderr', line);
      }
    });

    // exit handler
    child.on('exit', (code, sig) => {
      this.stopHealthPolling();
      // Flush partial buffers
      if (this.partialStdout) { this.appendLog('stdout', this.partialStdout); this.partialStdout = ''; }
      if (this.partialStderr) { this.appendLog('stderr', this.partialStderr); this.partialStderr = ''; }
      this.exitCode = code;
      this.signal = sig;
      this.exitedAt = new Date().toISOString();
      this.pid = undefined;
      this.child = null;
      if (this.state !== 'stopping') {
        this.setState('crashed');
        this.appendLog('stderr', `Process exited unexpectedly: code=${code ?? '-'} signal=${sig ?? '-'}`);
      } else {
        this.setState('stopped');
      }
    });

    child.on('error', (err) => {
      this.stopHealthPolling();
      this.exitedAt = new Date().toISOString();
      this.pid = undefined;
      this.child = null;
      this.setState('crashed');
      this.appendLog('stderr', `Process error: ${err.message}`);
    });

    // Start health polling if configured
    if (config.healthUrl) {
      this.startHealthPolling(config.healthUrl, config.healthIntervalSeconds);
    }

    return { ok: true, message: `"${config.name}" started (PID ${child.pid}).` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    if (!this.child || (this.state !== 'running' && this.state !== 'healthy' && this.state !== 'unhealthy' && this.state !== 'starting')) {
      return { ok: false, message: 'Sidecar is not running.' };
    }
    this.setState('stopping');
    this.stopHealthPolling();
    try {
      this.signalTree('SIGTERM');
    } catch (e: unknown) {
      const err = e as Error;
      return { ok: false, message: `Failed to send SIGTERM: ${err.message}` };
    }
    return { ok: true, message: 'Stop signal sent.' };
  }

  /** SIGKILL the whole process group. Best-effort; safe to call when stopped. */
  forceKill(): void {
    if (!this.child || this.pid == null) return;
    try {
      this.signalTree('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /**
   * Deliver a signal to the child's entire process group (negative pid) so
   * wrapper-spawned grandchildren receive it too. Falls back to signalling the
   * immediate child if the group send fails. On Windows there are no process
   * groups, so use taskkill /T to walk the tree.
   */
  private signalTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.child || this.pid == null) return;
    if (process.platform === 'win32') {
      const args = ['/pid', String(this.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const killer = spawn('taskkill', args, { stdio: 'ignore' });
      killer.on('error', () => { /* best-effort */ });
      return;
    }
    try {
      process.kill(-this.pid, signal); // negative pid → process group
    } catch {
      this.child.kill(signal); // group gone; signal the child directly
    }
  }

  async restart(config: SidecarEntry): Promise<{ ok: boolean; message: string }> {
    if (this.child) {
      const stopResult = await this.stop();
      if (!stopResult.ok) return stopResult;
      // Wait up to 3s for the child to exit
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => {
          if (this.child) this.forceKill();
          resolve();
        }, 3000);
        const check = setInterval(() => {
          if (!this.child) { clearTimeout(deadline); clearInterval(check); resolve(); }
        }, 100);
      });
    }
    return this.start(config);
  }

  isRunning(): boolean {
    return this.state === 'running' || this.state === 'healthy' || this.state === 'unhealthy';
  }

  /**
   * True while a child process exists — including 'starting' and 'stopping'
   * states that isRunning() excludes. Used by the unload backstop so a process
   * that ignores/delays SIGTERM is still force-killed.
   */
  isAlive(): boolean {
    return this.child != null;
  }

  private setState(state: SidecarState): void {
    this.state = state;
    this.onStatusChange(this.getStatus());
  }

  private appendLog(stream: 'stdout' | 'stderr', line: string): void {
    this.logs.push({ timestamp: new Date().toISOString(), stream, line });
    if (this.logs.length > this.maxLogLines) {
      this.logs = this.logs.slice(this.logs.length - this.maxLogLines);
    }
    this.onStatusChange(this.getStatus());
  }

  private startHealthPolling(url: string, intervalSeconds: number): void {
    const poll = async () => {
      if (!this.isRunning()) return;
      const result = await checkHealth(url);
      this.health = result.status;
      this.lastHealthAt = new Date().toISOString();
      this.lastHealthError = result.error;
      if (this.state === 'running' || this.state === 'unhealthy') {
        this.setState(result.status === 'healthy' ? 'healthy' : 'unhealthy');
      } else {
        this.onStatusChange(this.getStatus());
      }
    };
    void poll();
    this.healthTimer = setInterval(() => { void poll(); }, intervalSeconds * 1000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // Expose config for diagnostics (read-only accessor)
  getConfig(): SidecarEntry | null {
    return this.config;
  }
}

/** A 'stopped' placeholder status for an id with no live manager yet. */
export function emptyStatus(id: string): SidecarStatus {
  return { id, state: 'stopped', health: 'not_configured', recentLogs: [] };
}

/**
 * Owns one ProcessManager per sidecar id. Routes lifecycle calls to the right
 * manager and forwards every status change (already tagged with its id) up to a
 * single callback.
 */
export class ManagerPool {
  private managers = new Map<string, ProcessManager>();
  private onStatusChange: StatusChangeCallback;

  constructor(onStatusChange: StatusChangeCallback) {
    this.onStatusChange = onStatusChange;
  }

  private ensure(id: string): ProcessManager {
    let m = this.managers.get(id);
    if (!m) {
      m = new ProcessManager(id, this.onStatusChange);
      this.managers.set(id, m);
    }
    return m;
  }

  start(id: string, entry: SidecarEntry): Promise<{ ok: boolean; message: string }> {
    return this.ensure(id).start(entry);
  }

  restart(id: string, entry: SidecarEntry): Promise<{ ok: boolean; message: string }> {
    return this.ensure(id).restart(entry);
  }

  async stop(id: string): Promise<{ ok: boolean; message: string }> {
    const m = this.managers.get(id);
    if (!m) return { ok: false, message: 'Sidecar is not running.' };
    return m.stop();
  }

  getStatus(id: string): SidecarStatus {
    return this.managers.get(id)?.getStatus() ?? emptyStatus(id);
  }

  getConfig(id: string): SidecarEntry | null {
    return this.managers.get(id)?.getConfig() ?? null;
  }

  isRunning(id: string): boolean {
    return this.managers.get(id)?.isRunning() ?? false;
  }

  /** True if any managed sidecar still has a live child process. */
  anyAlive(): boolean {
    for (const m of this.managers.values()) {
      if (m.isAlive()) return true;
    }
    return false;
  }

  /**
   * Gracefully stop sidecars with a live child. With no predicate, stops all;
   * otherwise only those whose id satisfies `shouldStop` (used on unload to
   * honour each entry's stopOnUnload flag while still cleaning up orphans).
   */
  async stopAll(shouldStop?: (id: string) => boolean): Promise<void> {
    const stops: Promise<unknown>[] = [];
    for (const [id, m] of this.managers.entries()) {
      if (m.isAlive() && (!shouldStop || shouldStop(id))) stops.push(m.stop());
    }
    await Promise.all(stops);
  }

  /**
   * SIGKILL the process group of any sidecar still holding a live child — covers
   * 'stopping' processes that ignored SIGTERM. forceKill() no-ops when the child
   * has already exited, so calling it on every match is safe.
   */
  forceKillAll(shouldStop?: (id: string) => boolean): void {
    for (const [id, m] of this.managers.entries()) {
      if (m.isAlive() && (!shouldStop || shouldStop(id))) m.forceKill();
    }
  }
}
