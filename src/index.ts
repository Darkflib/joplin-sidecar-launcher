import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { registerSettings, loadConfig } from './settings';
import { ProcessManager } from './processManager';
import { createPanel, updatePanel, togglePanel } from './panel';
import { copyDiagnostics } from './diagnostics';
import { SidecarStatus } from './types';

const PLUGIN_VERSION = '0.1.0';

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

    // Register commands
    await joplin.commands.register({
      name: 'sidecarLauncher.start',
      label: 'Start Sidecar',
      execute: async () => {
        const config = await getValidConfig();
        if (!config) return;
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

    // Register menus
    await joplin.views.menus.create('sidecarLauncherMenu', 'Sidecar Launcher', [
      { commandName: 'sidecarLauncher.start' },
      { commandName: 'sidecarLauncher.stop' },
      { commandName: 'sidecarLauncher.restart' },
      { commandName: 'sidecarLauncher.togglePanel' },
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
      await manager.start(initialConfig);
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
