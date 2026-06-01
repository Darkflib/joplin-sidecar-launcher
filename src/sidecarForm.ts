/**
 * Pure helpers for the friendly per-sidecar form dialog: build its HTML from an
 * existing raw config object (or null for a new sidecar), and parse the submitted
 * form data back into a raw config object. No Joplin API usage here so it stays
 * unit-testable; the dialog lifecycle lives in index.ts.
 *
 * The objects produced are the user-authored shape stored in `sidecar.configs`
 * (name, command, args, …) — never the resolved SidecarEntry, so the shared
 * Joplin token is never written into the JSON.
 */

type Raw = Record<string, unknown>;

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function text(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function str(o: Raw | null, key: string): string {
  return o && typeof o[key] === 'string' ? (o[key] as string) : '';
}

function num(o: Raw | null, key: string, fallback: number): number {
  const v = o ? o[key] : undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function boolSelect(name: string, current: boolean): string {
  return `<select name="${name}" style="padding:5px 7px;font-size:14px">
      <option value="true"${current ? ' selected' : ''}>Yes</option>
      <option value="false"${!current ? ' selected' : ''}>No</option>
    </select>`;
}

const FIELD = 'display:block;margin:10px 0 16px;font-size:14px';
const INPUT = 'width:100%;box-sizing:border-box;padding:6px 9px;font-size:14px;margin-top:4px';
const HINT = 'color:#888;font-size:12px';

export function sidecarFormHtml(existing: Raw | null): string {
  const argsText = Array.isArray(existing?.args)
    ? (existing!.args as unknown[]).filter((a): a is string => typeof a === 'string').join('\n')
    : '';
  const autostart = existing?.autostart === true;
  const stopOnUnload = existing ? existing.stopOnUnload !== false : true;
  const interval = num(existing, 'healthIntervalSeconds', 5);
  const maxLog = num(existing, 'maxLogLines', 100);
  const title = existing ? 'Edit sidecar' : 'Add sidecar';

  return `<form name="main" style="width:640px;max-width:100%;font-size:14px;line-height:1.4">
    <h3 style="margin:0 0 14px;font-size:17px">${title}</h3>

    <label style="${FIELD}">Name
      <input name="name" value="${attr(str(existing, 'name'))}" placeholder="My sidecar" style="${INPUT}">
    </label>

    <label style="${FIELD}">Command <span style="${HINT}">— absolute path (e.g. /opt/homebrew/bin/uv)</span>
      <input name="command" value="${attr(str(existing, 'command'))}" placeholder="/usr/bin/python3" style="${INPUT}">
    </label>

    <label style="${FIELD}">Arguments <span style="${HINT}">— one per line</span>
      <textarea name="args" rows="6" placeholder="-m&#10;http.server&#10;8765" style="${INPUT};font-family:monospace">${text(argsText)}</textarea>
    </label>

    <label style="${FIELD}">Working directory <span style="${HINT}">— optional, defaults to home</span>
      <input name="cwd" value="${attr(str(existing, 'cwd'))}" style="${INPUT}">
    </label>

    <label style="${FIELD}">Health check URL <span style="${HINT}">— optional, localhost http only</span>
      <input name="healthUrl" value="${attr(str(existing, 'healthUrl'))}" placeholder="http://127.0.0.1:8765/health" style="${INPUT}">
    </label>

    <label style="${FIELD}">Dashboard URL <span style="${HINT}">— optional, opened by "Open dashboard"</span>
      <input name="dashboardUrl" value="${attr(str(existing, 'dashboardUrl'))}" placeholder="http://127.0.0.1:8765/" style="${INPUT}">
    </label>

    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin:10px 0 14px;font-size:14px">
      <label>Autostart ${boolSelect('autostart', autostart)}</label>
      <label>Stop on unload ${boolSelect('stopOnUnload', stopOnUnload)}</label>
    </div>

    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;font-size:14px">
      <label>Health interval (s)
        <input type="number" name="healthIntervalSeconds" min="1" max="300" value="${interval}" style="width:80px;padding:5px 7px;font-size:14px">
      </label>
      <label>Max log lines
        <input type="number" name="maxLogLines" min="10" max="1000" value="${maxLog}" style="width:90px;padding:5px 7px;font-size:14px">
      </label>
    </div>
  </form>`;
}

/**
 * Convert submitted form fields into a raw config object. Validates that a
 * command is present. Empty optional fields are omitted to keep the JSON clean.
 */
export function parseSidecarForm(
  fd: Record<string, string> | undefined,
): { ok: true; value: Raw } | { ok: false; message: string } {
  const f = fd ?? {};
  const get = (k: string) => (typeof f[k] === 'string' ? f[k].trim() : '');

  const command = get('command');
  if (!command) {
    return { ok: false, message: 'Command is required (use an absolute path).' };
  }

  const name = get('name') || 'Sidecar';
  const args = get('args')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const value: Raw = { name, command, args };

  const cwd = get('cwd');
  if (cwd) value.cwd = cwd;
  const healthUrl = get('healthUrl');
  if (healthUrl) value.healthUrl = healthUrl;
  const dashboardUrl = get('dashboardUrl');
  if (dashboardUrl) value.dashboardUrl = dashboardUrl;

  value.autostart = get('autostart') === 'true';
  value.stopOnUnload = get('stopOnUnload') !== 'false';
  value.healthIntervalSeconds = clampInt(f.healthIntervalSeconds, 5, 1, 300);
  value.maxLogLines = clampInt(f.maxLogLines, 100, 10, 1000);

  return { ok: true, value };
}
