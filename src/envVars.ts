/**
 * Pure helpers for per-sidecar environment variables: key validation, the
 * reserved/blocked key lists, and parsing of the `env` / `secretEnv` fields of a
 * sidecar entry. No Joplin API usage here so it stays unit-testable.
 *
 * Secret *values* never pass through this module — only secret *names*.
 */

/** POSIX-portable environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Python env vars known to poison child interpreters; stripped from the inherited env. */
export const PYTHON_ENV_BLOCKLIST = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX'];

/** Variables the launcher sets itself; a sidecar entry may not override them. */
export const LAUNCHER_ENV_KEYS = ['JOPLIN_SIDECAR_LAUNCHED_BY', 'JOPLIN_BASE_URL', 'JOPLIN_TOKEN'];

// Upper-cased so the check also holds on Windows, where env names are
// case-insensitive (`joplin_token` would otherwise clobber `JOPLIN_TOKEN`).
const FORBIDDEN = new Set([...LAUNCHER_ENV_KEYS, ...PYTHON_ENV_BLOCKLIST].map((k) => k.toUpperCase()));

// Names that usually hold credentials — used only to nudge the user towards
// `secretEnv` when such a key turns up in the plaintext `env` object.
const SECRETISH_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Why `key` can't be used as an injected variable name, or null if it's fine. */
export function envKeyProblem(key: string): string | null {
  if (!ENV_KEY_RE.test(key)) {
    return `"${key}" is not a valid environment variable name (letters, digits, underscore; not starting with a digit).`;
  }
  const upper = key.toUpperCase();
  if (LAUNCHER_ENV_KEYS.includes(upper)) {
    return `${key} is set by the launcher and cannot be overridden.`;
  }
  if (FORBIDDEN.has(upper)) {
    return `${key} is on the Python environment blocklist and cannot be injected.`;
  }
  return null;
}

export function looksSecret(key: string): boolean {
  return SECRETISH_RE.test(key);
}

/**
 * Validate the `env` field of a raw entry. Returns the valid subset plus one
 * message per problem; invalid pairs are dropped (and the errors block start).
 */
export function parseEnv(value: unknown): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  if (value === undefined || value === null) return { env, errors };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { env, errors: ['env must be a JSON object of string values, e.g. { "MCP_PORT": "5005" }.'] };
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const problem = envKeyProblem(k);
    if (problem) {
      errors.push(`env: ${problem}`);
      continue;
    }
    if (typeof v !== 'string') {
      errors.push(`env: value of ${k} must be a string (wrap numbers in quotes, e.g. "5005").`);
      continue;
    }
    env[k] = v;
  }
  return { env, errors };
}

/**
 * Validate the `secretEnv` field (an array of variable names whose values live
 * in the keychain). Duplicates are collapsed; a name also present in `env` is
 * rejected so it's never ambiguous which value the child receives.
 */
export function parseSecretNames(
  value: unknown,
  env: Record<string, string>,
): { names: string[]; errors: string[] } {
  const names: string[] = [];
  const errors: string[] = [];
  if (value === undefined || value === null) return { names, errors };
  if (!Array.isArray(value)) {
    return { names, errors: ['secretEnv must be a JSON array of variable names, e.g. ["MCP_API_KEY"].'] };
  }
  for (const n of value) {
    if (typeof n !== 'string') {
      errors.push('secretEnv: every entry must be a string variable name.');
      continue;
    }
    const problem = envKeyProblem(n);
    if (problem) {
      errors.push(`secretEnv: ${problem}`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(env, n)) {
      errors.push(`secretEnv: ${n} is also set in env — declare it in one place only.`);
      continue;
    }
    if (!names.includes(n)) names.push(n);
  }
  return { names, errors };
}

/**
 * True when a raw `env` value survives a round trip through the form's
 * `KEY=value` textarea unchanged. Anything else (values with newlines or
 * leading/trailing whitespace, non-string values, invalid keys, a non-object)
 * must be left to the JSON editor, or saving an unrelated field would rewrite it.
 */
export function envFormRepresentable(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([k, v]) => ENV_KEY_RE.test(k) && typeof v === 'string' && !/[\r\n]/.test(v) && v === v.trim(),
  );
}

/**
 * Set `key` in an env object being built for spawn. On Windows env names are
 * case-insensitive and Node keeps only the first of several case variants, so
 * drop any existing variant first — otherwise an inherited `PATH` would beat a
 * configured `Path` and the documented precedence would not hold.
 */
export function setEnvVar(env: Record<string, string>, key: string, value: string, platform = process.platform): void {
  if (platform === 'win32') {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toUpperCase() === upper) delete env[existing];
    }
  }
  env[key] = value;
}

/** Render an env object as `KEY=value` lines (for the form's textarea). */
export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Parse `KEY=value` lines from the form. Blank lines and `#` comments are
 * skipped; the value is everything after the first `=`, trimmed (so it may
 * contain `=` or inner spaces). Values with leading/trailing whitespace or
 * newlines need the JSON editor. Validation of the keys happens in parseEnv().
 */
export function envFromText(textValue: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  textValue.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`Environment line ${i + 1}: expected KEY=value.`);
      return;
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
  return { env, errors };
}
