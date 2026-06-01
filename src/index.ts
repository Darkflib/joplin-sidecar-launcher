import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { registerSettings, loadConfigs } from './settings';
import { ManagerPool, openDashboard, emptyStatus } from './processManager';
import { createPanel, updatePanel, togglePanel, PanelMessage } from './panel';
import { copyDiagnostics } from './diagnostics';
import { runPreflight, hasErrors, formatPreflight } from './preflight';
import { authoriseJoplinToken } from './joplinAuth';
import { SidecarEntry, SidecarStatus, EntryError, ResultLine } from './types';

const PLUGIN_VERSION = '0.2.0';

function asId(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function escHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function editDialogHtml(current: string): string {
  return `<form name="main">
    <h3 style="margin-top:0">Edit sidecars (JSON array)</h3>
    <p style="color:#777;font-size:12px;max-width:560px">
      Each object: <code>name</code>, <code>command</code> (absolute path), <code>args</code> (array),
      and optional <code>cwd</code>, <code>healthUrl</code>, <code>dashboardUrl</code>,
      <code>autostart</code>, <code>stopOnUnload</code>, <code>healthIntervalSeconds</code>,
      <code>maxLogLines</code>. The Joplin API token is configured separately and shared across all sidecars.
    </p>
    <textarea name="configs" rows="22" style="width:560px;font-family:monospace;font-size:12px">${escHtmlAttr(current)}</textarea>
  </form>`;
}

joplin.plugins.register({
  onStart: async function () {
    await registerSettings();

    // Latest status per sidecar id, plus which one the panel is showing.
    const statuses = new Map<string, SidecarStatus>();
    let selectedId = '';
    let lastResult: ResultLine | null = null;
    let logsOpen = false;
    let knownConfigs: SidecarEntry[] = [];

    const editDialog = await joplin.views.dialogs.create('sidecarEditConfigsDialog');

    const pool = new ManagerPool((status) => {
      statuses.set(status.id, status);
      if (status.id === selectedId) void updatePanel(buildPanelModel());
    });

    // Build the model the panel renders: the configured sidecars (name + id),
    // the selected id, the live status, the last inline result, and log state.
    function buildPanelModel() {
      const status = statuses.get(selectedId) ?? emptyStatus(selectedId);
      return {
        sidecars: knownConfigs.map((c) => ({ id: c.id, name: c.name })),
        selectedId,
        status,
        result: lastResult,
        logsOpen,
      };
    }

    await createPanel(
      // onMessage: route panel clicks to commands; the returned ResultLine is
      // stored and rendered inline beneath the buttons (no error popups).
      async (msg: PanelMessage): Promise<ResultLine | null> => {
        if (msg.type === '__toggleLogs') {
          logsOpen = !!msg.open;
          return null; // next render already reflects the user's toggle
        }
        if (msg.type === 'selectSidecar' && msg.id) {
          lastResult = null;
          await selectSidecar(msg.id);
          return null;
        }
        const result = (await joplin.commands.execute(`sidecarLauncher.${msg.type}`, msg.id)) as
          | ResultLine
          | null
          | undefined;
        lastResult = result ?? null;
        await updatePanel(buildPanelModel());
        return lastResult;
      },
    );

    // Resolve which sidecar an action targets: an explicit id, else the panel
    // selection, else the first configured sidecar.
    async function resolve(preferId?: string): Promise<{
      configs: SidecarEntry[];
      errors: EntryError[];
      entry: SidecarEntry | null;
    }> {
      const { configs, errors } = await loadConfigs();
      knownConfigs = configs;
      let id = preferId && configs.some((c) => c.id === preferId) ? preferId : '';
      if (!id) id = ((await joplin.settings.value('sidecar.selectedId')) as string) || '';
      let entry = configs.find((c) => c.id === id) ?? null;
      if (!entry && configs.length) entry = configs[0];
      // Keep the panel selection valid.
      if (entry && entry.id !== selectedId) {
        selectedId = entry.id;
      } else if (!entry) {
        selectedId = '';
      }
      return { configs, errors, entry };
    }

    async function selectSidecar(id: string): Promise<void> {
      selectedId = id;
      await joplin.settings.setValue('sidecar.selectedId', id);
      await updatePanel(buildPanelModel());
    }

    // Combined blocking problems for an entry: config-level (bad JSON) + preflight.
    // These warrant a dialog because the guidance is multi-line and the action is blocked.
    function blockingProblems(entry: SidecarEntry, errors: EntryError[]): string | null {
      const cfgErrors = errors.filter((e) => e.id === entry.id).map((e) => e.message);
      const pf = runPreflight(entry);
      const parts: string[] = [];
      if (cfgErrors.length) parts.push(cfgErrors.join('\n'));
      if (hasErrors(pf)) parts.push(formatPreflight(pf));
      return parts.length ? parts.join('\n\n') : null;
    }

    // --- Commands. Each returns a ResultLine the panel shows inline (or null). ---

    await joplin.commands.register({
      name: 'sidecarLauncher.start',
      label: 'Start Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine> => {
        const { errors, entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const blocked = blockingProblems(entry, errors);
        if (blocked) {
          await joplin.views.dialogs.showMessageBox(
            `Cannot start "${entry.name}" — checks failed:\n\n${blocked}`,
          );
          return { level: 'error', message: `Cannot start "${entry.name}" — see dialog.` };
        }
        const result = await pool.start(entry.id, entry);
        return { level: result.ok ? 'info' : 'error', message: result.message };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.stop',
      label: 'Stop Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const result = await pool.stop(entry.id);
        // Already-stopped is a benign no-op, not an error worth a popup.
        return { level: result.ok ? 'info' : 'warn', message: result.message };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.restart',
      label: 'Restart Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine> => {
        const { errors, entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const blocked = blockingProblems(entry, errors);
        if (blocked) {
          await joplin.views.dialogs.showMessageBox(
            `Cannot restart "${entry.name}" — checks failed:\n\n${blocked}`,
          );
          return { level: 'error', message: `Cannot restart "${entry.name}" — see dialog.` };
        }
        const result = await pool.restart(entry.id, entry);
        return { level: result.ok ? 'info' : 'error', message: result.message };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.togglePanel',
      label: 'Show/Hide Status Panel',
      execute: async (): Promise<null> => {
        await togglePanel();
        return null;
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.copyDiagnostics',
      label: 'Copy Diagnostics',
      execute: async (idArg?: unknown): Promise<ResultLine> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const status = statuses.get(entry.id) ?? pool.getStatus(entry.id);
        const config = pool.getConfig(entry.id) ?? entry;
        const result = await copyDiagnostics(config, status, PLUGIN_VERSION);
        return { level: 'info', message: result.message };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.openDashboard',
      label: 'Open Dashboard',
      execute: async (idArg?: unknown): Promise<ResultLine> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const result = await openDashboard(entry);
        return { level: result.ok ? 'info' : 'warn', message: result.message };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.editConfigs',
      label: 'Edit Sidecars (JSON)',
      execute: async (): Promise<ResultLine | null> => {
        const current = ((await joplin.settings.value('sidecar.configs')) as string) || '[]';
        await joplin.views.dialogs.setHtml(editDialog, editDialogHtml(current));
        await joplin.views.dialogs.setButtons(editDialog, [
          { id: 'cancel', title: 'Cancel' },
          { id: 'save', title: 'Save' },
        ]);
        const res = (await joplin.views.dialogs.open(editDialog)) as {
          id: string;
          formData?: { main?: { configs?: string } };
        };
        if (res.id !== 'save') return null;
        const raw = res.formData?.main?.configs ?? '';
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            await joplin.views.dialogs.showMessageBox('Not saved: the Sidecars config must be a JSON array.');
            return { level: 'error', message: 'Sidecars must be a JSON array — not saved.' };
          }
          await joplin.settings.setValue('sidecar.configs', JSON.stringify(parsed, null, 2));
        } catch (e) {
          await joplin.views.dialogs.showMessageBox(`Not saved: JSON parse error.\n\n${(e as Error).message}`);
          return { level: 'error', message: 'Invalid JSON — not saved.' };
        }
        await resolve();
        await updatePanel(buildPanelModel());
        return { level: 'info', message: 'Sidecars saved.' };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.preflight',
      label: 'Run Preflight Checks',
      execute: async (idArg?: unknown): Promise<null> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) {
          await joplin.views.dialogs.showMessageBox('No sidecar configured.');
          return null;
        }
        await joplin.views.dialogs.showMessageBox(
          `Preflight checks for "${entry.name}":\n\n${formatPreflight(runPreflight(entry))}`,
        );
        return null;
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.authoriseJoplin',
      label: 'Authorise Joplin API Token',
      execute: async (): Promise<null> => {
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
            'Joplin API token saved to the keychain. Restart your sidecars to apply it.',
          );
        } else {
          await joplin.views.dialogs.showMessageBox(`Authorisation failed: ${result.message}`);
        }
        return null;
      },
    });

    // Register menus
    await joplin.views.menus.create('sidecarLauncherMenu', 'Sidecar Launcher', [
      { commandName: 'sidecarLauncher.start' },
      { commandName: 'sidecarLauncher.stop' },
      { commandName: 'sidecarLauncher.restart' },
      { commandName: 'sidecarLauncher.togglePanel' },
      { commandName: 'sidecarLauncher.openDashboard' },
      { commandName: 'sidecarLauncher.editConfigs' },
      { commandName: 'sidecarLauncher.preflight' },
      { commandName: 'sidecarLauncher.authoriseJoplin' },
      { commandName: 'sidecarLauncher.copyDiagnostics' },
    ], MenuItemLocation.Tools);

    // Initial load + panel render.
    await resolve();
    await updatePanel(buildPanelModel());

    // Settings change listener — reload configs and refresh the panel. Does NOT
    // auto-restart a running sidecar whose config changed.
    await joplin.settings.onChange(async () => {
      await resolve();
      await updatePanel(buildPanelModel());
    });

    // Autostart every sidecar flagged autostart with no blocking problems.
    const { configs: initialConfigs, errors: initialErrors } = await loadConfigs();
    knownConfigs = initialConfigs;
    for (const entry of initialConfigs) {
      if (!entry.autostart || !entry.command) continue;
      const blocked = blockingProblems(entry, initialErrors);
      if (blocked) {
        await joplin.views.dialogs.showMessageBox(
          `Autostart skipped for "${entry.name}" — checks failed:\n\n${blocked}`,
        );
        continue;
      }
      await pool.start(entry.id, entry);
    }

    // Stop on unload: stop every sidecar whose config opts in (default), plus any
    // orphans the pool still holds. Leave sidecars with stopOnUnload:false running.
    joplin.plugins.onUnload(async () => {
      const { configs } = await loadConfigs();
      const keepRunning = new Set(configs.filter((c) => !c.stopOnUnload).map((c) => c.id));
      const shouldStop = (id: string) => !keepRunning.has(id);
      if (pool.anyRunning()) {
        // SIGTERM the process groups (delivered synchronously, so it lands even if
        // Joplin doesn't await us), give them a moment, then SIGKILL any survivors.
        await pool.stopAll(shouldStop);
        await new Promise((r) => setTimeout(r, 800));
        pool.forceKillAll(shouldStop);
      }
    });
  },
});
