import joplin from 'api';
import { SidecarEntry, SidecarStatus } from './types';
import { runPreflight, formatPreflight } from './preflight';

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
    '(Environment variables not included)',
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
