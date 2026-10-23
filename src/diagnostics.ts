import joplin from 'api';
import { SidecarEntry, SidecarStatus } from './types';
import { runPreflight, formatPreflight } from './preflight';

/**
 * Env section for the report: non-secret vars with their values, secret vars by
 * name only as ***set*** / ***unset***. Secret values are never read here beyond
 * a presence check.
 */
export function envDiagnosticLines(config: SidecarEntry | null): string[] {
  const env = config?.env ?? {};
  const secretNames = config?.secretEnv ?? [];
  const secretValues = config?.secretValues ?? {};
  const lines: string[] = [];
  const keys = Object.keys(env);
  lines.push(keys.length ? 'Env:' : 'Env: (none)');
  for (const k of keys) lines.push(`  ${k}=${env[k]}`);
  lines.push(secretNames.length ? 'Secret env:' : 'Secret env: (none)');
  for (const n of secretNames) {
    lines.push(`  ${n}=${Object.prototype.hasOwnProperty.call(secretValues, n) ? '***set***' : '***unset***'}`);
  }
  return lines;
}

export async function buildDiagnostics(
  config: SidecarEntry | null,
  status: SidecarStatus,
  pluginVersion: string,
): Promise<string> {
  const versionInfo = await joplin.versionInfo();
  const lines: string[] = [
    '=== Sidecar Launcher Diagnostics ===',
    `Plugin version: ${pluginVersion}`,
    `Platform: ${versionInfo.platform ?? 'unknown'}`,
    `Joplin version: ${versionInfo.version ?? 'unknown'}`,
    '',
    '--- Configuration ---',
    `Name: ${config?.name || '(not set)'}`,
    `Command: ${config?.command || '(not set)'}`,
    `Args: ${JSON.stringify(config?.args ?? [])}`,
    `Working directory: ${config?.cwd || '(default)'}`,
    `Health URL: ${config?.healthUrl || '(not set)'}`,
    `Dashboard URL: ${config?.dashboardUrl || '(not set)'}`,
    `Autostart: ${config?.autostart ?? false}`,
    `Stop on unload: ${config?.stopOnUnload ?? true}`,
    `Health interval: ${config?.healthIntervalSeconds ?? 5}s`,
    `Max log lines: ${config?.maxLogLines ?? 100}`,
    ...envDiagnosticLines(config),
    '',
    '--- Current Status ---',
    `State: ${status.state}`,
    `PID: ${status.pid ?? '—'}`,
    `Started at: ${status.startedAt ?? '—'}`,
    `Exited at: ${status.exitedAt ?? '—'}`,
    `Exit code: ${status.exitCode ?? '—'}`,
    `Signal: ${status.signal ?? '—'}`,
    `Health: ${status.health}`,
    `Last health at: ${status.lastHealthAt ?? '—'}`,
    `Last health error: ${status.lastHealthError ?? '—'}`,
    '',
    '--- Preflight ---',
    config ? formatPreflight(runPreflight(config)) : '(config not loaded)',
    '',
    '--- Last 20 Log Lines ---',
    ...status.recentLogs.slice(-20).map(
      l => `[${l.timestamp}] [${l.stream}] ${l.line}`,
    ),
    '',
    '(Inherited environment, JOPLIN_TOKEN and secret values not included)',
  ];
  return lines.join('\n');
}

export async function copyDiagnostics(
  config: SidecarEntry | null,
  status: SidecarStatus,
  pluginVersion: string,
): Promise<{ ok: boolean; message: string }> {
  const text = await buildDiagnostics(config, status, pluginVersion);
  try {
    await joplin.clipboard.writeText(text);
    return { ok: true, message: 'Diagnostics copied to clipboard.' };
  } catch {
    // Clipboard not available — show in dialog
    const dialog = await joplin.views.dialogs.create('sidecarDiagDialog');
    await joplin.views.dialogs.setHtml(dialog, `<pre style="font-size:11px;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</pre>`);
    await joplin.views.dialogs.setButtons(dialog, [{ id: 'ok', title: 'Close' }]);
    await joplin.views.dialogs.open(dialog);
    return { ok: true, message: 'Clipboard unavailable — diagnostics shown in a dialog.' };
  }
}
