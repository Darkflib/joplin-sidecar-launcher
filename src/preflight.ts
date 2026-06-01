import { SidecarEntry } from './types';
import { isLocalhostUrl, isHttpUrl } from './settings';

export type PreflightLevel = 'ok' | 'warn' | 'error';

export interface PreflightResult {
  level: PreflightLevel;
  message: string;
}

function isAbsolutePath(command: string): boolean {
  return command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command);
}

function commandIsExecutable(command: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  try {
    fs.accessSync(command, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(dir: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Static checks that catch the common launcher misconfigurations before the
 * process is spawned (so the user sees a clear explanation rather than the
 * cryptic "Spawn returned no PID").
 */
export function runPreflight(config: SidecarEntry): PreflightResult[] {
  const results: PreflightResult[] = [];

  // --- Command: the #1 failure cause ---
  if (!config.command) {
    results.push({ level: 'error', message: 'Command is not set.' });
  } else if (!isAbsolutePath(config.command)) {
    results.push({
      level: 'error',
      message:
        `Command "${config.command}" is not an absolute path. Joplin launched from the ` +
        `Dock/Finder does not inherit your shell PATH, so spawning it fails ("Spawn returned ` +
        `no PID"). Use the full path — run \`which ${config.command}\` in a terminal.`,
    });
  } else if (!commandIsExecutable(config.command)) {
    results.push({
      level: 'error',
      message: `Command not found or not executable: ${config.command}`,
    });
  } else {
    results.push({ level: 'ok', message: `Command is an executable absolute path: ${config.command}` });
  }

  // --- Health URL ---
  if (!config.healthUrl) {
    results.push({ level: 'warn', message: 'No health check URL set — health cannot be reported.' });
  } else if (!isLocalhostUrl(config.healthUrl)) {
    results.push({
      level: 'error',
      message: `Health URL must be a localhost http URL. Got: ${config.healthUrl}`,
    });
  } else {
    let path = '/';
    try {
      path = new URL(config.healthUrl).pathname;
    } catch {
      /* isLocalhostUrl already validated it parses */
    }
    if (path === '/' || path === '') {
      results.push({
        level: 'warn',
        message: 'Health URL path is "/" — prefer the /health endpoint (e.g. http://127.0.0.1:8765/health).',
      });
    } else {
      results.push({ level: 'ok', message: `Health URL: ${config.healthUrl}` });
    }
  }

  // --- Working directory ---
  if (config.cwd) {
    if (directoryExists(config.cwd)) {
      results.push({ level: 'ok', message: `Working directory exists: ${config.cwd}` });
    } else {
      results.push({ level: 'error', message: `Working directory does not exist: ${config.cwd}` });
    }
  }

  // --- Dashboard URL ---
  if (config.dashboardUrl) {
    if (!isHttpUrl(config.dashboardUrl)) {
      results.push({ level: 'error', message: `Dashboard URL must be http(s). Got: ${config.dashboardUrl}` });
    } else if (!isLocalhostUrl(config.dashboardUrl)) {
      results.push({
        level: 'warn',
        message: `Dashboard URL is not localhost: ${config.dashboardUrl}. It will open in your browser as-is.`,
      });
    } else {
      results.push({ level: 'ok', message: `Dashboard URL: ${config.dashboardUrl}` });
    }
  }

  // --- Joplin token ---
  if (!config.joplinToken) {
    results.push({
      level: 'warn',
      message: 'No Joplin API token set — the sidecar cannot index. Use "Authorise Joplin API token".',
    });
  } else {
    results.push({ level: 'ok', message: 'Joplin API token is configured.' });
  }

  return results;
}

export function hasErrors(results: PreflightResult[]): boolean {
  return results.some((r) => r.level === 'error');
}

export function formatPreflight(results: PreflightResult[]): string {
  const tag = (l: PreflightLevel) => (l === 'ok' ? 'OK  ' : l === 'warn' ? 'WARN' : 'FAIL');
  return results.map((r) => `${tag(r.level)}: ${r.message}`).join('\n');
}
