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

export interface SidecarConfig {
  command: string;
  args: string[];
  cwd?: string;
  healthUrl?: string;
  autostart: boolean;
  stopOnUnload: boolean;
  healthIntervalSeconds: number;
  maxLogLines: number;
}

export interface SidecarStatus {
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
