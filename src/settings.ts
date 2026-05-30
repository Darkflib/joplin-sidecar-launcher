import joplin from 'api';
import { SettingItemType } from 'api/types';
import { SidecarConfig } from './types';

export const SECTION_NAME = 'sidecarLauncher';

export async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SECTION_NAME, {
    label: 'Sidecar Launcher',
    iconName: 'fas fa-terminal',
    description: 'Launch and monitor local sidecar processes from Joplin.',
  });

  await joplin.settings.registerSettings({
    'sidecar.command': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Command',
      description: 'Executable to run, e.g. python3, uv, or an absolute path.',
      public: true,
    },
    'sidecar.argsJson': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '[]',
      label: 'Arguments (JSON array)',
      description: 'Arguments as a JSON array, e.g. ["-m", "http.server", "8765", "--bind", "127.0.0.1"]',
      public: true,
    },
    'sidecar.cwd': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Working directory',
      description: 'Optional. Absolute path. Defaults to home directory if empty.',
      public: true,
    },
    'sidecar.healthUrl': {
      section: SECTION_NAME,
      type: SettingItemType.String,
      value: '',
      label: 'Health check URL',
      description: 'Optional. Must be a localhost URL, e.g. http://127.0.0.1:8765/health',
      public: true,
    },
    'sidecar.autostart': {
      section: SECTION_NAME,
      type: SettingItemType.Bool,
      value: false,
      label: 'Autostart on plugin load',
      public: true,
    },
    'sidecar.stopOnUnload': {
      section: SECTION_NAME,
      type: SettingItemType.Bool,
      value: true,
      label: 'Stop sidecar when plugin unloads',
      public: true,
    },
    'sidecar.healthIntervalSeconds': {
      section: SECTION_NAME,
      type: SettingItemType.Int,
      value: 5,
      minimum: 1,
      maximum: 300,
      label: 'Health check interval (seconds)',
      public: true,
    },
    'sidecar.maxLogLines': {
      section: SECTION_NAME,
      type: SettingItemType.Int,
      value: 100,
      minimum: 10,
      maximum: 1000,
      label: 'Max log lines retained',
      public: true,
    },
  });
}

export async function loadConfig(): Promise<{ config: SidecarConfig; errors: string[] }> {
  const errors: string[] = [];

  const command = (await joplin.settings.value('sidecar.command') as string).trim();
  const argsJson = (await joplin.settings.value('sidecar.argsJson') as string).trim();
  const cwd = (await joplin.settings.value('sidecar.cwd') as string).trim() || undefined;
  const healthUrl = (await joplin.settings.value('sidecar.healthUrl') as string).trim() || undefined;
  const autostart = await joplin.settings.value('sidecar.autostart') as boolean;
  const stopOnUnload = await joplin.settings.value('sidecar.stopOnUnload') as boolean;
  const healthIntervalSeconds = await joplin.settings.value('sidecar.healthIntervalSeconds') as number;
  const maxLogLines = await joplin.settings.value('sidecar.maxLogLines') as number;

  // Validate command
  if (!command) {
    errors.push('Command is empty. Configure it in Joplin Settings > Sidecar Launcher.');
  }

  // Parse and validate args
  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!Array.isArray(parsed)) {
      errors.push('Arguments must be a JSON array, e.g. ["-m", "http.server", "8765"]');
    } else if (!parsed.every((a): a is string => typeof a === 'string')) {
      errors.push('All arguments must be strings.');
    } else {
      args = parsed;
    }
  } catch (e) {
    errors.push(`Arguments JSON parse error: ${(e as Error).message}`);
  }

  // Validate health URL if set
  if (healthUrl) {
    if (!isLocalhostUrl(healthUrl)) {
      errors.push(`Health URL must be a localhost URL (http://127.0.0.1, http://localhost, or http://[::1]). Got: ${healthUrl}`);
    }
  }

  // Validate cwd if set
  if (cwd) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) {
        errors.push(`Working directory is not a directory: ${cwd}`);
      }
    } catch {
      errors.push(`Working directory does not exist: ${cwd}`);
    }
  }

  return {
    config: { command, args, cwd, healthUrl, autostart, stopOnUnload, healthIntervalSeconds, maxLogLines },
    errors,
  };
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
