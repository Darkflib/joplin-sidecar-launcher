import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { registerSettings, loadConfig } from './settings';
import { ProcessManager, openDashboard } from './processManager';
import { createPanel, updatePanel, togglePanel } from './panel';
import { copyDiagnostics } from './diagnostics';
import { runPreflight, hasErrors, formatPreflight } from './preflight';
import { authoriseJoplinToken } from './joplinAuth';
import { SidecarConfig, SidecarStatus } from './types';

const PLUGIN_VERSION = '0.1.3';

joplin.plugins.register({
  onStart: async function () {
    await registerSettings();
    await createPanel();

    let currentStatus: SidecarStatus | null = null;

    const manager = new ProcessManager(async (status) => {
      currentStatus = status;
      await updatePanel(status);
    });

    // Helper: load config, show errors, return null on failure
    async function getValidConfig() {
      const { config, errors } = await loadConfig();
      if (errors.length > 0) {
        await joplin.views.dialogs.showMessageBox(
          `Sidecar configuration error:\n\n${errors.join('\n')}`,
        );
        return null;
      }
      return config;
    }

    // Run preflight; on hard errors show guidance and return true (blocked).
    async function blockedByPreflight(config: SidecarConfig): Promise<boolean> {
      const results = runPreflight(config);
      if (hasErrors(results)) {
        await joplin.views.dialogs.showMessageBox(
          `Cannot start the sidecar — preflight checks failed:\n\n${formatPreflight(results)}`,
        );
        return true;
      }
      return false;
    }

    // Register commands
    await joplin.commands.register({
      name: 'sidecarLauncher.start',
      label: 'Start Sidecar',
      execute: async () => {
        const config = await getValidConfig();
        if (!config) return;
        if (await blockedByPreflight(config)) return;
        const result = await manager.start(config);
        if (!result.ok) {
          await joplin.views.dialogs.showMessageBox(result.message);
        }
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.stop',
      label: 'Stop Sidecar',
      execute: async () => {
        const result = await manager.stop();
        if (!result.ok) {
          await joplin.views.dialogs.showMessageBox(result.message);
        }
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.restart',
      label: 'Restart Sidecar',
      execute: async () => {
        const config = await getValidConfig();
        if (!config) return;
        if (await blockedByPreflight(config)) return;
        const result = await manager.restart(config);
        if (!result.ok) {
          await joplin.views.dialogs.showMessageBox(result.message);
        }
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.togglePanel',
      label: 'Show/Hide Status Panel',
      execute: async () => {
        await togglePanel();
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.copyDiagnostics',
      label: 'Copy Diagnostics',
      execute: async () => {
        const status = currentStatus ?? manager.getStatus();
        await copyDiagnostics(manager.getConfig(), status, PLUGIN_VERSION);
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.openDashboard',
      label: 'Open Dashboard',
      execute: async () => {
        const config = await getValidConfig();
        if (!config) return;
        const result = await openDashboard(config);
        if (!result.ok) {
          await joplin.views.dialogs.showMessageBox(result.message);
        }
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.preflight',
      label: 'Run Preflight Checks',
      execute: async () => {
        const { config } = await loadConfig();
        await joplin.views.dialogs.showMessageBox(
          `Sidecar preflight checks:\n\n${formatPreflight(runPreflight(config))}`,
        );
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.authoriseJoplin',
      label: 'Authorise Joplin API Token',
      execute: async () => {
        const baseUrl =
          ((await joplin.settings.value('sidecar.joplinBaseUrl')) as string) ||
          'http://127.0.0.1:41184';
        await joplin.views.dialogs.showMessageBox(
          'Requesting access to Joplin. Click OK, then approve the prompt that appears in Joplin.',
        );
        const result = await authoriseJoplinToken(baseUrl);
        if (result.ok && result.token) {
          await joplin.settings.setValue('sidecar.joplinToken', result.token);
          await joplin.views.dialogs.showMessageBox(
            'Joplin API token saved to the keychain. Restart the sidecar to apply it.',
          );
        } else {
          await joplin.views.dialogs.showMessageBox(`Authorisation failed: ${result.message}`);
        }
      },
    });

    // Register menus
    await joplin.views.menus.create('sidecarLauncherMenu', 'Sidecar Launcher', [
      { commandName: 'sidecarLauncher.start' },
      { commandName: 'sidecarLauncher.stop' },
      { commandName: 'sidecarLauncher.restart' },
      { commandName: 'sidecarLauncher.togglePanel' },
      { commandName: 'sidecarLauncher.openDashboard' },
      { commandName: 'sidecarLauncher.preflight' },
      { commandName: 'sidecarLauncher.authoriseJoplin' },
      { commandName: 'sidecarLauncher.copyDiagnostics' },
    ], MenuItemLocation.Tools);

    // Initial panel update
    await updatePanel(manager.getStatus());

    // Settings change listener — update displayed status; do NOT auto-restart running sidecar
    await joplin.settings.onChange(async () => {
      await updatePanel(manager.getStatus());
    });

    // Autostart
    const { config: initialConfig, errors: initialErrors } = await loadConfig();
    if (initialErrors.length === 0 && initialConfig.autostart && initialConfig.command) {
      const pf = runPreflight(initialConfig);
      if (hasErrors(pf)) {
        // Surface the misconfiguration instead of failing silently with no PID.
        await joplin.views.dialogs.showMessageBox(
          `Sidecar autostart skipped — preflight checks failed:\n\n${formatPreflight(pf)}`,
        );
      } else {
        await manager.start(initialConfig);
      }
    }

    // Stop on unload
    joplin.plugins.onUnload(async () => {
      const { config } = await loadConfig();
      if (config.stopOnUnload && manager.isRunning()) {
        await manager.stop();
        // Brief wait to allow graceful exit
        await new Promise(r => setTimeout(r, 500));
      }
    });
  },
});
