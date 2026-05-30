import { spawn, ChildProcess } from 'child_process';
import { SidecarConfig, SidecarState, SidecarStatus, HealthStatus, LogLine } from './types';
import { checkHealth } from './health';

type StatusChangeCallback = (status: SidecarStatus) => void;

// Python env vars known to poison child interpreters
const PYTHON_ENV_BLOCKLIST = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX'];

export class ProcessManager {
  private config: SidecarConfig | null = null;
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

  constructor(onStatusChange: StatusChangeCallback) {
    this.onStatusChange = onStatusChange;
  }

  getStatus(): SidecarStatus {
    return {
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

  async start(config: SidecarConfig): Promise<{ ok: boolean; message: string }> {
    if (this.state !== 'stopped' && this.state !== 'crashed') {
      return { ok: false, message: `Sidecar is already ${this.state}. Stop it first.` };
    }
    if (!config.command) {
      return { ok: false, message: 'Command is empty. Configure it in Joplin Settings > Sidecar Launcher.' };
    }

    this.config = config;
    this.maxLogLines = config.maxLogLines;
    this.setState('starting');
    this.health = config.healthUrl ? 'unknown' : 'not_configured';
    this.exitCode = undefined;
    this.signal = undefined;
    this.exitedAt = undefined;
    this.startedAt = new Date().toISOString();

    // Build sanitised environment — strip Python env vars that pollute child interpreters
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !PYTHON_ENV_BLOCKLIST.includes(k)) {
        env[k] = v;
      }
    }
    env['JOPLIN_SIDECAR_LAUNCHED_BY'] = 'joplin-sidecar-launcher';

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd || process.env.HOME || undefined,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
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

    return { ok: true, message: `Sidecar started (PID ${child.pid}).` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    if (!this.child || (this.state !== 'running' && this.state !== 'healthy' && this.state !== 'unhealthy' && this.state !== 'starting')) {
      return { ok: false, message: 'Sidecar is not running.' };
    }
    this.setState('stopping');
    this.stopHealthPolling();
    try {
      this.child.kill('SIGTERM');
    } catch (e: unknown) {
      const err = e as Error;
      return { ok: false, message: `Failed to send SIGTERM: ${err.message}` };
    }
    return { ok: true, message: 'Stop signal sent.' };
  }

  async restart(config: SidecarConfig): Promise<{ ok: boolean; message: string }> {
    if (this.child) {
      const stopResult = await this.stop();
      if (!stopResult.ok) return stopResult;
      // Wait up to 3s for the child to exit
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => {
          if (this.child) {
            try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
          }
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
  getConfig(): SidecarConfig | null {
    return this.config;
  }
}
