/**
 * Pure helpers for the friendly per-sidecar form dialog: build its HTML from an
 * existing raw config object (or null for a new sidecar), and parse the submitted
 * form data back into a raw config object. No Joplin API usage here so it stays
 * unit-testable; the dialog lifecycle lives in index.ts.
 *
 * The objects produced are the user-authored shape stored in `sidecar.configs`
 * (name, command, args, …) — never the resolved SidecarEntry, so the shared
 * Joplin token is never written into the JSON. Secret env vars appear here by
 * name only; their values are set through the separate Secrets dialog and are
 * never rendered into any HTML.
 */

import { envToText, envFromText, envFormRepresentable, parseEnv, parseSecretNames } from './envVars';

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

/**
 * @param setSecretNames names of this sidecar's secrets that currently have a
 *   value — used only to show a set/unset marker next to each declared name.
 */
export function sidecarFormHtml(existing: Raw | null, setSecretNames: string[] = []): string {
  const argsText = Array.isArray(existing?.args)
    ? (existing!.args as unknown[]).filter((a): a is string => typeof a === 'string').join('\n')
    : '';
  const autostart = existing?.autostart === true;
  const stopOnUnload = existing ? existing.stopOnUnload !== false : true;
  const useSidecarOpener = existing?.useSidecarOpener === true;
  const interval = num(existing, 'healthIntervalSeconds', 5);
  const maxLog = num(existing, 'maxLogLines', 100);
  const title = existing ? 'Edit sidecar' : 'Add sidecar';
  // An env the textarea can't represent exactly is shown read-only and kept
  // verbatim on save (see parseSidecarForm), so editing another field never
  // rewrites it.
  const envLocked = !envFormRepresentable(existing?.env);
  const envText = envLocked
    ? `# Contains values this form can't edit safely (multi-line, padded with spaces,\n` +
      `# non-string, or an invalid key). Kept unchanged — edit via Edit JSON.\n` +
      (existing?.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
        ? Object.keys(existing.env as Raw).join('\n')
        : '')
    : envToText((existing?.env as Record<string, string> | undefined) ?? {});
  const secretNames = Array.isArray(existing?.secretEnv)
    ? (existing!.secretEnv as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const secretStatus = secretNames.length
    ? secretNames
        .map((n) => `<code>${text(n)}</code> ${setSecretNames.includes(n)
          ? '<span style="color:#4caf50">set</span>'
          : '<span style="color:#ff9800">unset</span>'}`)
        .join(' · ')
    : '';

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

    <div style="${FIELD}">
      <label>Use sidecar's <code>open</code> subcommand ${boolSelect('useSidecarOpener', useSidecarOpener)}</label>
      <div style="${HINT};margin-top:4px">Only for Joplin-sidecar-style CLIs that expose <code>open</code> (token handoff via URL fragment). Leave off for generic <code>serve</code> commands.</div>
    </div>

    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin:10px 0 14px;font-size:14px">
      <label>Autostart ${boolSelect('autostart', autostart)}</label>
      <label>Stop on unload ${boolSelect('stopOnUnload', stopOnUnload)}</label>
    </div>

    <label style="${FIELD}">Environment variables <span style="${HINT}">— optional, one <code>KEY=value</code> per line; stored in plaintext</span>
      <textarea name="env" rows="4"${envLocked ? ' readonly' : ''} placeholder="MCP_HOST=127.0.0.1&#10;MCP_PORT=5005" style="${INPUT};font-family:monospace">${text(envText)}</textarea>
    </label>

    <label style="${FIELD}">Secret environment variables <span style="${HINT}">— optional, one name per line; values go in the keychain</span>
      <textarea name="secretEnv" rows="2" placeholder="MCP_API_KEY" style="${INPUT};font-family:monospace">${text(secretNames.join('\n'))}</textarea>
    </label>
    <div style="${HINT};margin:-10px 0 16px">
      ${secretStatus ? `${secretStatus}<br>` : ''}Set, generate, or clear values with the panel's <strong>Secrets</strong> button after saving.
      JOPLIN_TOKEN, JOPLIN_BASE_URL, and JOPLIN_SIDECAR_LAUNCHED_BY are set by the launcher and can't be overridden.
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
  existing: Raw | null = null,
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

  value.useSidecarOpener = get('useSidecarOpener') === 'true';
  value.autostart = get('autostart') === 'true';
  value.stopOnUnload = get('stopOnUnload') !== 'false';
  value.healthIntervalSeconds = clampInt(f.healthIntervalSeconds, 5, 1, 300);
  value.maxLogLines = clampInt(f.maxLogLines, 100, 10, 1000);

  // Env: parse KEY=value lines, then apply the same validation loadConfigs() uses
  // so the form refuses what Start would refuse. Messages name keys, never values.
  // A locked env (decided from `existing`, not from the submitted form) is kept
  // verbatim; loadConfigs() reports any problems in it as usual.
  const envLocked = !envFormRepresentable(existing?.env);
  const { env: envRaw, errors: lineErrors } = envLocked
    ? { env: {}, errors: [] as string[] }
    : envFromText(typeof f.env === 'string' ? f.env : '');
  const { env, errors: envErrors } = envLocked ? parseEnv(existing?.env) : parseEnv(envRaw);
  const secretList = get('secretEnv')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const { names: secretEnv, errors: secretErrors } = parseSecretNames(secretList, env);
  // A locked env's own errors aren't the form's to refuse — the user can't fix
  // them here; Start reports them.
  const problems = [...lineErrors, ...(envLocked ? [] : envErrors), ...secretErrors];
  if (problems.length) {
    return { ok: false, message: problems.join('\n') };
  }
  if (envLocked) {
    if (existing?.env !== undefined) value.env = existing.env;
  } else if (Object.keys(env).length) {
    value.env = env;
  }
  if (secretEnv.length) value.secretEnv = secretEnv;

  return { ok: true, value };
}

/**
 * The Secrets dialog: pick one of the sidecar's declared secret names and set,
 * generate, copy, or clear its value. The value field always starts empty — an
 * existing value is never rendered into the HTML.
 */
export function secretsDialogHtml(sidecarName: string, names: string[], setNames: string[]): string {
  const options = names
    .map((n) => `<option value="${attr(n)}">${text(n)} — ${setNames.includes(n) ? 'set' : 'unset'}</option>`)
    .join('');
  return `<form name="main" style="width:520px;max-width:100%;font-size:14px;line-height:1.4">
    <h3 style="margin:0 0 14px;font-size:17px">Secrets — ${text(sidecarName)}</h3>

    <label style="${FIELD}">Variable
      <select name="name" style="${INPUT}">${options}</select>
    </label>

    <label style="${FIELD}">New value <span style="${HINT}">— only used by <strong>Set</strong></span>
      <input type="password" name="value" autocomplete="off" spellcheck="false" style="${INPUT};font-family:monospace">
    </label>

    <div style="${HINT}">
      Values are stored in the OS keychain, never in the Sidecars JSON.
      <strong>Generate</strong> stores 32 random bytes (base64url) and copies the value to the clipboard —
      handy for API keys such as <code>MCP_API_KEY</code>. Restart the sidecar to apply changes.
    </div>
  </form>`;
}
