import joplin from 'api';
import { SidecarStatus } from './types';

let panelHandle: string | undefined;

const PANEL_ID = 'sidecarLauncherPanel';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stateColour(state: string): string {
  switch (state) {
    case 'healthy': return '#4caf50';
    case 'running': return '#2196f3';
    case 'unhealthy': return '#ff9800';
    case 'crashed': return '#f44336';
    case 'stopped': return '#9e9e9e';
    case 'stopping': return '#ff9800';
    case 'starting': return '#2196f3';
    default: return '#9e9e9e';
  }
}

function renderLogs(logs: SidecarStatus['recentLogs']): string {
  if (!logs.length) return '<em style="color:#777">No output yet.</em>';
  return logs
    .slice(-30)
    .map(l => {
      const ts = l.timestamp.slice(11, 23);
      const colour = l.stream === 'stderr' ? '#f44336' : '#aaa';
      return `<div style="font-family:monospace;font-size:11px;margin:1px 0"><span style="color:#555">${escHtml(ts)}</span> <span style="color:${colour}">[${l.stream}]</span> ${escHtml(l.line)}</div>`;
    })
    .join('');
}

export async function createPanel(): Promise<void> {
  panelHandle = await joplin.views.panels.create(PANEL_ID);
  await joplin.views.panels.setHtml(panelHandle, buildHtml(null));

  // Handle messages from panel buttons
  await joplin.views.panels.onMessage(panelHandle, async (msg: unknown) => {
    if (msg && typeof msg === 'object' && 'type' in msg && typeof (msg as Record<string, unknown>)['type'] === 'string') {
      const type = (msg as Record<string, string>)['type'];
      await joplin.commands.execute(`sidecarLauncher.${type}`);
    }
  });
}

export async function updatePanel(status: SidecarStatus | null): Promise<void> {
  if (!panelHandle) return;
  await joplin.views.panels.setHtml(panelHandle, buildHtml(status));
}

export async function togglePanel(): Promise<void> {
  if (!panelHandle) return;
  const visible = await joplin.views.panels.visible(panelHandle);
  await joplin.views.panels.show(panelHandle, !visible);
}

function buildHtml(status: SidecarStatus | null): string {
  if (!status) {
    return `<div style="padding:12px;font-family:sans-serif"><h3>Sidecar Launcher</h3><p style="color:#777">Loading…</p></div>`;
  }

  const { state, pid, startedAt, exitedAt, exitCode, signal, health, lastHealthAt, lastHealthError, recentLogs } = status;
  const stateColor = stateColour(state);

  const btn = (label: string, type: string) =>
    `<button onclick="webviewApi.postMessage({type:'${type}'})" style="margin:2px 4px 2px 0;padding:4px 10px;cursor:pointer">${label}</button>`;

  return `
<div style="padding:12px;font-family:sans-serif;font-size:13px;line-height:1.5">
  <h3 style="margin:0 0 8px;font-size:15px">Sidecar Launcher</h3>

  <table style="border-collapse:collapse;width:100%;margin-bottom:8px">
    <tr><td style="color:#777;padding:1px 8px 1px 0;white-space:nowrap">State</td>
        <td><strong style="color:${stateColor}">${escHtml(state)}</strong></td></tr>
    <tr><td style="color:#777;padding:1px 8px 1px 0">PID</td>
        <td>${pid != null ? pid : '—'}</td></tr>
    <tr><td style="color:#777;padding:1px 8px 1px 0">Health</td>
        <td>${escHtml(health)}${lastHealthError ? ` — <span style="color:#f44336">${escHtml(lastHealthError)}</span>` : ''}
            ${lastHealthAt ? `<span style="color:#777;font-size:11px"> (${lastHealthAt.slice(11, 19)})</span>` : ''}</td></tr>
    <tr><td style="color:#777;padding:1px 8px 1px 0">Started</td>
        <td>${startedAt ? escHtml(startedAt.slice(0, 19).replace('T', ' ')) : '—'}</td></tr>
    <tr><td style="color:#777;padding:1px 8px 1px 0">Exited</td>
        <td>${exitedAt ? escHtml(exitedAt.slice(0, 19).replace('T', ' ')) : '—'}</td></tr>
    <tr><td style="color:#777;padding:1px 8px 1px 0">Exit code</td>
        <td>${exitCode != null ? exitCode : '—'}${signal ? ` (signal: ${escHtml(signal)})` : ''}</td></tr>
  </table>

  <div style="margin-bottom:8px">
    ${btn('Start', 'start')}
    ${btn('Stop', 'stop')}
    ${btn('Restart', 'restart')}
    ${btn('Copy diag', 'copyDiagnostics')}
  </div>

  <div style="border-top:1px solid #333;padding-top:8px">
    <div style="color:#777;font-size:11px;margin-bottom:4px">Recent output (last 30 lines)</div>
    <div style="background:#111;border-radius:3px;padding:6px;max-height:240px;overflow-y:auto">
      ${renderLogs(recentLogs)}
    </div>
  </div>
</div>`;
}
