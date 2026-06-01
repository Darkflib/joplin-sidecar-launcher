import joplin from 'api';
import { SidecarStatus, ResultLine } from './types';

let panelHandle: string | undefined;

const PANEL_ID = 'sidecarLauncherPanel';

export interface PanelMessage {
  type: string;
  id?: string;
  open?: boolean;
}

export interface PanelModel {
  sidecars: { id: string; name: string }[];
  selectedId: string;
  status: SidecarStatus;
  result: ResultLine | null;
  logsOpen: boolean;
}

export type PanelMessageHandler = (msg: PanelMessage) => Promise<ResultLine | null>;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a value as a single-quoted JS string literal safe to embed inside a
 * double-quoted HTML attribute (e.g. an onclick handler). Escapes JS string
 * metacharacters, then HTML-escapes so a stray quote can't break out of the
 * attribute.
 */
function jsStringLiteralAttr(value: string): string {
  const js = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return js
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function resultColour(level: ResultLine['level']): string {
  switch (level) {
    case 'error': return '#f44336';
    case 'warn': return '#ff9800';
    default: return '#4caf50';
  }
}

function renderLogs(logs: SidecarStatus['recentLogs']): string {
  if (!logs.length) return '<em style="color:#777">No output yet.</em>';
  return logs
    .slice(-200)
    .map(l => {
      const ts = l.timestamp.slice(11, 23);
      const colour = l.stream === 'stderr' ? '#f44336' : '#aaa';
      return `<div style="font-family:monospace;font-size:11px;margin:1px 0"><span style="color:#555">${escHtml(ts)}</span> <span style="color:${colour}">[${l.stream}]</span> ${escHtml(l.line)}</div>`;
    })
    .join('');
}

export async function createPanel(onMessage: PanelMessageHandler): Promise<void> {
  panelHandle = await joplin.views.panels.create(PANEL_ID);
  await joplin.views.panels.setHtml(panelHandle, buildHtml(null));

  await joplin.views.panels.onMessage(panelHandle, async (msg: unknown): Promise<ResultLine | null> => {
    if (msg && typeof msg === 'object' && 'type' in msg && typeof (msg as Record<string, unknown>)['type'] === 'string') {
      const m = msg as PanelMessage;
      return onMessage(m);
    }
    return null;
  });
}

export async function updatePanel(model: PanelModel | null): Promise<void> {
  if (!panelHandle) return;
  await joplin.views.panels.setHtml(panelHandle, buildHtml(model));
}

export async function togglePanel(): Promise<void> {
  if (!panelHandle) return;
  const visible = await joplin.views.panels.visible(panelHandle);
  await joplin.views.panels.show(panelHandle, !visible);
}

function buildHtml(model: PanelModel | null): string {
  if (!model) {
    return `<div style="padding:12px;font-family:sans-serif"><h3>Sidecar Launcher</h3><p style="color:#777">Loading…</p></div>`;
  }

  const { sidecars, selectedId, status, result, logsOpen } = model;
  const { state, pid, startedAt, exitedAt, exitCode, signal, health, lastHealthAt, lastHealthError, recentLogs } = status;
  const stateColor = stateColour(state);

  // Per-button posts carry the selected id so menu and panel actions agree. The id
  // is a single-quoted JS string literal (the onclick attribute is double-quoted),
  // then HTML-escaped — embedding it via JSON.stringify produced a double quote that
  // closed the attribute and silently broke every button.
  const sel = jsStringLiteralAttr(selectedId);
  const btn = (label: string, type: string) =>
    `<button onclick="webviewApi.postMessage({type:'${type}',id:${sel}})" style="margin:2px 4px 2px 0;padding:4px 10px;cursor:pointer">${label}</button>`;

  const selector = sidecars.length === 0
    ? `<div style="color:#f44336;font-size:12px;margin-bottom:8px">No sidecars configured. Use <strong>Edit sidecars</strong> below.</div>`
    : sidecars.length === 1
      ? `<div style="color:#777;font-size:12px;margin-bottom:8px">Sidecar: <strong style="color:inherit">${escHtml(sidecars[0].name)}</strong></div>`
      : `<div style="margin-bottom:8px">
           <label style="color:#777;font-size:12px;margin-right:6px">Sidecar</label>
           <select onchange="webviewApi.postMessage({type:'selectSidecar',id:this.value})" style="padding:3px 6px;max-width:100%">
             ${sidecars.map(s => `<option value="${escHtml(s.id)}"${s.id === selectedId ? ' selected' : ''}>${escHtml(s.name)}</option>`).join('')}
           </select>
         </div>`;

  const crashHint = state === 'crashed'
    ? `<div style="background:#3a1f1f;border:1px solid #f44336;border-radius:3px;padding:8px;margin-bottom:8px;font-size:12px">
         Sidecar crashed. Run <strong>Preflight</strong> below — the most common cause is the
         <strong>Command</strong> not being an absolute path (Joplin doesn't inherit your shell PATH).
       </div>`
    : '';

  const resultLine = result
    ? `<div style="margin:6px 0;padding:5px 8px;border-radius:3px;font-size:12px;background:#1c1c1c;border-left:3px solid ${resultColour(result.level)}">${escHtml(result.message)}</div>`
    : '';

  // Open logs grow to fill the remaining panel height; closed logs collapse away.
  const detailsStyle = logsOpen
    ? 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column'
    : 'flex:0 0 auto';
  const logBoxStyle = logsOpen
    ? 'flex:1 1 auto;min-height:80px;overflow-y:auto;background:#111;border-radius:3px;padding:6px;margin-top:4px'
    : 'max-height:160px;overflow-y:auto;background:#111;border-radius:3px;padding:6px;margin-top:4px';

  return `
<div style="height:100vh;box-sizing:border-box;padding:12px;font-family:sans-serif;font-size:13px;line-height:1.5;display:flex;flex-direction:column">
  <h3 style="margin:0 0 8px;font-size:15px;flex:0 0 auto">Sidecar Launcher</h3>

  <div style="flex:0 0 auto">
    ${selector}
    ${crashHint}

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

    <div>
      ${btn('Start', 'start')}
      ${btn('Stop', 'stop')}
      ${btn('Restart', 'restart')}
      ${btn('Open dashboard', 'openDashboard')}
      ${btn('Preflight', 'preflight')}
      ${btn('Authorise Joplin', 'authoriseJoplin')}
      ${btn('Edit sidecars', 'editConfigs')}
      ${btn('Copy diag', 'copyDiagnostics')}
    </div>

    ${resultLine}
  </div>

  <details ${logsOpen ? 'open' : ''} ontoggle="webviewApi.postMessage({type:'__toggleLogs',open:this.open})"
           style="border-top:1px solid #333;padding-top:8px;margin-top:8px;${detailsStyle}">
    <summary style="cursor:pointer;color:#777;font-size:11px;outline:none">Recent output (${recentLogs.length} lines)</summary>
    <div style="${logBoxStyle}">
      ${renderLogs(recentLogs)}
    </div>
  </details>
</div>`;
}
