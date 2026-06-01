import joplin from 'api';
import { SettingItemType } from 'api/types';
import { SidecarEntry, EntryError } from './types';

export const SECTION_NAME = 'sidecarLauncher';

const CONFIGS_EXAMPLE = JSON.stringify(
  [
    {
      name: 'PKM sidecar',
      command: '/opt/homebrew/bin/uv',
      args: ['run', 'python', '-m', 'pkm_sidecar.main', 'serve'],
      cwd: '/Users/you/pkm-sidecar',
      healthUrl: 'http://127.0.0.1:8765/health',
      dashboardUrl: 'http://127.0.0.1:8765/',
      useSidecarOpener: true,
      autostart: true,
      stopOnUnload: true,
      healthIntervalSeconds: 5,
      maxLogLines: 100,
    },
  ],
  null,
  2,
);

export async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SECTION_NAME, {
    label: 'Sidecar Launcher',
    iconName: 'fas fa-terminal',
    description: 'Launch and monitor local sidecar processes from Joplin.',
  });

  await joplin.settings.registerSettings({
    // --- New multi-sidecar config (v0.2+) ---
    'sidecar.configs': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Sidecars (JSON array)',
      description:
        'A JSON array of sidecar definitions. Each object: { name, command (absolute path), ' +
        'args (array), cwd?, healthUrl?, dashboardUrl?, useSidecarOpener?, autostart?, ' +
        'stopOnUnload?, healthIntervalSeconds?, maxLogLines? }. Prefer the "Edit Sidecars (JSON)" command ' +
        `for a larger editor. Example: ${CONFIGS_EXAMPLE}`,
      public: true,
    },
    // Internal: remembers which sidecar the panel is showing. Not shown in the UI.
    'sidecar.selectedId': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Selected sidecar (internal)',
      public: false,
    },

    // --- Shared Joplin API connection (applies to every sidecar) ---
    'sidecar.joplinBaseUrl': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: 'http://127.0.0.1:41184',
      label: 'Joplin API base URL',
      description:
        'Joplin Web Clipper service URL (enable it in Tools > Options > Web Clipper). ' +
        'Injected into every sidecar as JOPLIN_BASE_URL.',
      public: true,
    },
    'sidecar.joplinToken': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Joplin API token',
      description:
        'Token every sidecar uses to read Joplin (injected as JOPLIN_TOKEN). Obtain it ' +
        'automatically via Tools > Sidecar Launcher > Authorise Joplin API token. Stored in ' +
        'the OS keychain — kept out of the Sidecars JSON so it is never written in plaintext.',
      secure: true,
      public: true,
    },

    // --- Legacy single-sidecar fields ---
    // Hidden from the UI (public: false) but still registered so migrateLegacy()
    // can read them once. Joplin can't unregister settings, so this is how we
    // retire them without cluttering the options page.
    'sidecar.command': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Command (legacy)',
      public: false,
    },
    'sidecar.argsJson': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '[]',
      label: 'Arguments (legacy)',
      public: false,
    },
    'sidecar.cwd': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Working directory (legacy)',
      public: false,
    },
    'sidecar.healthUrl': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Health check URL (legacy)',
      public: false,
    },
    'sidecar.autostart': {
      section: SECTION_NAME,
      type: SettingItemType.Bool,
      value: false,
      label: 'Autostart (legacy)',
      public: false,
    },
    'sidecar.stopOnUnload': {
      section: SECTION_NAME,
      type: SettingItemType.Bool,
      value: true,
      label: 'Stop on unload (legacy)',
      public: false,
    },
    'sidecar.healthIntervalSeconds': {
      section: SECTION_NAME,
      type: SettingItemType.Int,
      value: 5,
      minimum: 1,
      maximum: 300,
      label: 'Health check interval (legacy)',
      public: false,
    },
    'sidecar.maxLogLines': {
      section: SECTION_NAME,
      type: SettingItemType.Int,
      value: 100,
      minimum: 10,
      maximum: 1000,
      label: 'Max log lines (legacy)',
      public: false,
    },
  });
}

/**
 * Load and validate the configured sidecars. Reads the `sidecar.configs` JSON
 * array, applies the shared Joplin base URL + token (from the keychain setting)
 * to every entry, and returns per-entry validation errors. On first run with an
 * empty `sidecar.configs` but a populated legacy command, the legacy flat fields
 * are migrated into a one-element array and persisted.
 */
export async function loadConfigs(): Promise<{ configs: SidecarEntry[]; errors: EntryError[] }> {
  const errors: EntryError[] = [];

  let raw = (await joplin.settings.value('sidecar.configs') as string).trim();

  // One-time migration from the legacy single-sidecar fields.
  if (!raw || raw === '[]') {
    const migrated = await migrateLegacy();
    if (migrated) {
      raw = JSON.stringify([migrated], null, 2);
      await joplin.settings.setValue('sidecar.configs', raw);
    }
  }

  // Shared Joplin connection, injected into every entry.
  const joplinBaseUrl = (await joplin.settings.value('sidecar.joplinBaseUrl') as string).trim() || undefined;
  const joplinToken = (await joplin.settings.value('sidecar.joplinToken') as string).trim() || undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch (e) {
    errors.push({ id: '', name: '(Sidecars JSON)', message: `Parse error: ${(e as Error).message}` });
    return { configs: [], errors };
  }
  if (!Array.isArray(parsed)) {
    errors.push({ id: '', name: '(Sidecars JSON)', message: 'The Sidecars setting must be a JSON array.' });
    return { configs: [], errors };
  }

  const configs: SidecarEntry[] = [];
  const seenIds = new Set<string>();
  let idsAssigned = false;
  parsed.forEach((item, index) => {
    const { entry, entryErrors, generatedId } = normaliseEntry(item, index, seenIds, joplinBaseUrl, joplinToken);
    seenIds.add(entry.id);
    configs.push(entry);
    errors.push(...entryErrors);
    // Inject the assigned id into the user's original object (only the id — never
    // the global token) so it can be written back and stay stable across reloads.
    if (generatedId && item && typeof item === 'object') {
      (item as Record<string, unknown>).id = entry.id;
      idsAssigned = true;
    }
  });

  // Persist newly-assigned ids once. Subsequent loads see ids present and skip
  // this, so it doesn't loop through the settings onChange handler.
  if (idsAssigned) {
    await joplin.settings.setValue('sidecar.configs', JSON.stringify(parsed, null, 2));
  }

  return { configs, errors };
}

function normaliseEntry(
  item: unknown,
  index: number,
  seenIds: Set<string>,
  joplinBaseUrl: string | undefined,
  joplinToken: string | undefined,
): { entry: SidecarEntry; entryErrors: EntryError[]; generatedId: boolean } {
  const errs: EntryError[] = [];
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};

  let id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : '';
  // Mint a stable id when missing or colliding; the caller persists it so the id
  // (and thus the process-manager key, selection, and status) survives reloads.
  let generatedId = false;
  if (!id || seenIds.has(id)) {
    id = newId();
    generatedId = true;
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `Sidecar ${index + 1}`;
  const push = (message: string) => errs.push({ id, name, message });

  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) push('Command is empty.');

  let args: string[] = [];
  if (obj.args === undefined) {
    args = [];
  } else if (!Array.isArray(obj.args)) {
    push('args must be a JSON array of strings.');
  } else if (!obj.args.every((a): a is string => typeof a === 'string')) {
    push('All args must be strings.');
  } else {
    args = obj.args;
  }

  const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined;
  if (cwd && !directoryExists(cwd)) push(`Working directory does not exist: ${cwd}`);

  const healthUrl = typeof obj.healthUrl === 'string' && obj.healthUrl.trim() ? obj.healthUrl.trim() : undefined;
  if (healthUrl && !isLocalhostUrl(healthUrl)) {
    push(`Health URL must be a localhost http URL (http://127.0.0.1, http://localhost). Got: ${healthUrl}`);
  }

  const dashboardUrl = typeof obj.dashboardUrl === 'string' && obj.dashboardUrl.trim() ? obj.dashboardUrl.trim() : undefined;
  if (dashboardUrl && !isHttpUrl(dashboardUrl)) {
    push(`Dashboard URL must be an http(s) URL. Got: ${dashboardUrl}`);
  }

  const useSidecarOpener = obj.useSidecarOpener === true;

  const autostart = obj.autostart === true;
  const stopOnUnload = obj.stopOnUnload !== false; // default true
  const healthIntervalSeconds = clampInt(obj.healthIntervalSeconds, 5, 1, 300);
  const maxLogLines = clampInt(obj.maxLogLines, 100, 10, 1000);

  return {
    entry: {
      id,
      name,
      command,
      args,
      cwd,
      healthUrl,
      dashboardUrl,
      useSidecarOpener,
      autostart,
      stopOnUnload,
      healthIntervalSeconds,
      maxLogLines,
      joplinBaseUrl,
      joplinToken,
    },
    entryErrors: errs,
    generatedId,
  };
}

async function migrateLegacy(): Promise<Record<string, unknown> | null> {
  const command = (await joplin.settings.value('sidecar.command') as string).trim();
  if (!command) return null;

  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse((await joplin.settings.value('sidecar.argsJson') as string) || '[]');
    if (Array.isArray(parsed) && parsed.every((a): a is string => typeof a === 'string')) {
      args = parsed;
    }
  } catch {
    /* leave args empty; the user can fix it in the JSON */
  }

  const cwd = (await joplin.settings.value('sidecar.cwd') as string).trim();
  const healthUrl = (await joplin.settings.value('sidecar.healthUrl') as string).trim();

  const entry: Record<string, unknown> = {
    id: 'migrated',
    name: 'Sidecar',
    command,
    args,
    // The legacy single-sidecar config only ever pointed at the Joplin sidecar
    // CLI, which exposes `open`; preserve its token handoff across the upgrade.
    useSidecarOpener: true,
    autostart: (await joplin.settings.value('sidecar.autostart')) as boolean,
    stopOnUnload: (await joplin.settings.value('sidecar.stopOnUnload')) as boolean,
    healthIntervalSeconds: (await joplin.settings.value('sidecar.healthIntervalSeconds')) as number,
    maxLogLines: (await joplin.settings.value('sidecar.maxLogLines')) as number,
  };
  if (cwd) entry.cwd = cwd;
  if (healthUrl) entry.healthUrl = healthUrl;
  return entry;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
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

let idCounter = 0;
export function newId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto');
    if (typeof crypto.randomUUID === 'function') return `sc-${crypto.randomUUID()}`;
  } catch {
    /* fall through */
  }
  idCounter += 1;
  return `sc-${idCounter}-${process.pid}`;
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
