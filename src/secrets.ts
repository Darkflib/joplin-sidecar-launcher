import joplin from 'api';

/**
 * Per-sidecar secret environment variables.
 *
 * Values live in ONE `secure: true` setting (OS keychain) holding a JSON map
 * `{ [sidecarId]: { [VAR_NAME]: value } }`. A single key is used rather than one
 * dynamically-registered secure setting per (sidecar, var): Joplin can't
 * unregister settings, so per-key registration would leave keychain entries
 * behind on every remove/rename, and every key would have to be registered
 * before it could be read on startup.
 *
 * The sidecar JSON only ever lists the variable *names* (`secretEnv`). Nothing
 * in this module logs, and callers must never put a value in a ResultLine,
 * dialog HTML, diagnostics, or the process log.
 */

export const SECRET_SETTING_KEY = 'sidecar.secretEnv';

export type SecretMap = Record<string, Record<string, string>>;

/** Read the whole map. A corrupt or empty value reads as `{}` (never throws). */
export async function loadSecretMap(): Promise<SecretMap> {
  let raw: unknown;
  try {
    raw = await joplin.settings.value(SECRET_SETTING_KEY);
  } catch {
    return {};
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SecretMap = {};
    for (const [id, vars] of Object.entries(parsed as Record<string, unknown>)) {
      if (!vars || typeof vars !== 'object' || Array.isArray(vars)) continue;
      const clean: Record<string, string> = {};
      for (const [name, v] of Object.entries(vars as Record<string, unknown>)) {
        if (typeof v === 'string') clean[name] = v;
      }
      out[id] = clean;
    }
    return out;
  } catch {
    // Don't surface the parse error: its message can quote part of the value.
    return {};
  }
}

async function saveSecretMap(map: SecretMap): Promise<void> {
  // Drop empty per-sidecar objects so removed sidecars leave no trace.
  const compact: SecretMap = {};
  for (const [id, vars] of Object.entries(map)) {
    if (Object.keys(vars).length) compact[id] = vars;
  }
  await joplin.settings.setValue(SECRET_SETTING_KEY, JSON.stringify(compact));
}

/** Values for the declared names of one sidecar; undeclared stored names are ignored. */
export function secretsFor(map: SecretMap, id: string, names: string[]): Record<string, string> {
  const stored = map[id] ?? {};
  const out: Record<string, string> = {};
  for (const n of names) {
    if (typeof stored[n] === 'string' && stored[n] !== '') out[n] = stored[n];
  }
  return out;
}

export async function setSecret(id: string, name: string, value: string): Promise<void> {
  const map = await loadSecretMap();
  map[id] = { ...(map[id] ?? {}), [name]: value };
  await saveSecretMap(map);
}

export async function clearSecret(id: string, name: string): Promise<void> {
  const map = await loadSecretMap();
  if (!map[id] || !(name in map[id])) return;
  delete map[id][name];
  await saveSecretMap(map);
}

/** Delete every secret of a sidecar (on Remove). */
export async function deleteSidecarSecrets(id: string): Promise<void> {
  const map = await loadSecretMap();
  if (!map[id]) return;
  delete map[id];
  await saveSecretMap(map);
}

/** Drop stored values whose names are no longer declared for the sidecar (on form Save). */
export async function pruneSecrets(id: string, keepNames: string[]): Promise<void> {
  const map = await loadSecretMap();
  const vars = map[id];
  if (!vars) return;
  let changed = false;
  for (const name of Object.keys(vars)) {
    if (!keepNames.includes(name)) {
      delete vars[name];
      changed = true;
    }
  }
  if (changed) await saveSecretMap(map);
}

/** 32 random bytes, base64url — suitable for an API key. */
export function generateSecretValue(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.randomBytes(32).toString('base64url');
}
