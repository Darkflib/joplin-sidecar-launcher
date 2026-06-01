export type SidecarState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'healthy'
  | 'unhealthy'
  | 'stopping'
  | 'crashed';

export type HealthStatus =
  | 'not_configured'
  | 'unknown'
  | 'healthy'
  | 'unhealthy';

export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
  timestamp: string;  // ISO 8601
  stream: LogStream;
  line: string;
}

/**
 * A single managed sidecar. `id` is a stable opaque key used to route status
 * updates and remember the panel selection; `name` is the human label shown in
 * the panel selector. The remaining fields mirror the original single-sidecar
 * config. `dashboardUrl` is the browser URL opened by the *Open dashboard*
 * action — used directly via the OS handler for generic sidecars, or as the
 * port source for sidecars that expose an `open` subcommand (token handoff).
 */
export interface SidecarEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  healthUrl?: string;
  dashboardUrl?: string;
  autostart: boolean;
  stopOnUnload: boolean;
  healthIntervalSeconds: number;
  maxLogLines: number;
  joplinBaseUrl?: string;
  joplinToken?: string;
}

export interface SidecarsConfig {
  sidecars: SidecarEntry[];
}

/** A validation error tagged with the entry it belongs to (for per-sidecar reporting). */
export interface EntryError {
  id: string;
  name: string;
  message: string;
}

/** A short outcome of a button/command action, shown inline beneath the panel buttons. */
export interface ResultLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SidecarStatus {
  id: string;
  state: SidecarState;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  health: HealthStatus;
  lastHealthAt?: string;
  lastHealthError?: string;
  recentLogs: LogLine[];
}
