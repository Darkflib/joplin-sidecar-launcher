import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { registerSettings, loadConfigs, newId } from './settings';
import { sidecarFormHtml, parseSidecarForm, secretsDialogHtml } from './sidecarForm';
import {
  loadSecretMap,
  setSecret,
  clearSecret,
  deleteSidecarSecrets,
  pruneSecrets,
  generateSecretValue,
} from './secrets';
import { ManagerPool, openDashboard, emptyStatus } from './processManager';
import { createPanel, updatePanel, togglePanel, PanelMessage } from './panel';
import { copyDiagnostics } from './diagnostics';
import { runPreflight, hasErrors, formatPreflight } from './preflight';
import { authoriseJoplinToken } from './joplinAuth';
import { sidecarPort, isPortInUse, findListenerPids, killPids } from './portCheck';
import { SidecarEntry, SidecarStatus, EntryError, ResultLine } from './types';

const PLUGIN_VERSION = '0.4.0';

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
      <code>maxLogLines</code>, <code>env</code> (object of string values, plaintext), and
      <code>secretEnv</code> (array of variable names — set their values with the panel's
      <strong>Secrets</strong> button; never put secret values in this JSON). The Joplin API token is
      configured separately and shared across all sidecars.
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
    const formDialog = await joplin.views.dialogs.create('sidecarFormDialog');
    const secretsDialog = await joplin.views.dialogs.create('sidecarSecretsDialog');

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

    // Detect a stale process holding the sidecar's port (e.g. an orphan from a
    // hard-killed Joplin) and offer to reclaim it. Returns a ResultLine if the
    // start should be aborted, or null when it's clear to proceed.
    async function ensurePortFree(entry: SidecarEntry): Promise<ResultLine | null> {
      // If our own pool already runs this sidecar, let start() reject it — don't
      // probe the port (we'd be looking at our own process).
      if (pool.isRunning(entry.id)) return null;
      const port = sidecarPort(entry);
      if (port == null) return null;
      if (!(await isPortInUse(port))) return null;

      const pids = findListenerPids(port);
      const who = pids.length ? ` by PID ${pids.join(', ')}` : '';
      const answer = await joplin.views.dialogs.showMessageBox(
        `Port ${port} is already in use${who}.\n\n` +
          `This is usually a leftover "${entry.name}" sidecar from a previous session. ` +
          `Click OK to stop it and continue, or Cancel to abort.`,
      );
      if (answer !== 0) {
        return { level: 'warn', message: `Start aborted — port ${port} is in use.` };
      }
      if (!pids.length) {
        return {
          level: 'error',
          message: `Couldn't identify the process on port ${port}. Free it manually, then retry.`,
        };
      }
      killPids(pids);
      await new Promise((r) => setTimeout(r, 600));
      if (await isPortInUse(port)) {
        return {
          level: 'error',
          message: `Port ${port} is still in use after trying to free it. Free it manually, then retry.`,
        };
      }
      return null; // port freed — proceed; the start's own result line follows
    }

    // Read the raw user-authored sidecar objects (ids included). Returns null if
    // the JSON is malformed, so mutations refuse to clobber a broken config.
    async function readRawConfigs(): Promise<Record<string, unknown>[] | null> {
      const raw = ((await joplin.settings.value('sidecar.configs')) as string).trim() || '[]';
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
      } catch {
        return null;
      }
    }

    async function writeRawConfigs(arr: Record<string, unknown>[]): Promise<void> {
      await joplin.settings.setValue('sidecar.configs', JSON.stringify(arr, null, 2));
    }

    // Open the friendly per-sidecar form, prefilled from `existing` (null = new).
    // Returns the raw config object on save, or null on cancel / invalid input.
    async function openSidecarForm(
      existing: Record<string, unknown> | null,
      setSecretNames: string[] = [],
    ): Promise<Record<string, unknown> | null> {
      await joplin.views.dialogs.setHtml(formDialog, sidecarFormHtml(existing, setSecretNames));
      await joplin.views.dialogs.setButtons(formDialog, [
        { id: 'cancel', title: 'Cancel' },
        { id: 'save', title: 'Save' },
      ]);
      const res = (await joplin.views.dialogs.open(formDialog)) as {
        id: string;
        formData?: { main?: Record<string, string> };
      };
      if (res.id !== 'save') return null;
      const parsed = parseSidecarForm(res.formData?.main);
      if (!parsed.ok) {
        await joplin.views.dialogs.showMessageBox(`Not saved: ${parsed.message}`);
        return null;
      }
      return parsed.value;
    }

    // Names of a saved raw entry's declared secrets that have no stored value.
    async function unsetSecretNames(id: string, value: Record<string, unknown>): Promise<string[]> {
      const names = Array.isArray(value.secretEnv) ? (value.secretEnv as string[]) : [];
      const stored = (await loadSecretMap())[id] ?? {};
      return names.filter((n) => !stored[n]);
    }

    function unsetHint(unset: string[]): string {
      return unset.length ? ` Secret${unset.length === 1 ? '' : 's'} unset: ${unset.join(', ')} — use Secrets.` : '';
    }

    // Write a secret to the clipboard. On failure fall back to showing it once in
    // a message box — the user explicitly asked for it, and it is never logged.
    async function revealSecret(name: string, value: string, what: string): Promise<string> {
      try {
        await joplin.clipboard.writeText(value);
        return `${what} ${name} copied to the clipboard.`;
      } catch {
        await joplin.views.dialogs.showMessageBox(`Clipboard unavailable. ${what} ${name}:\n\n${value}`);
        return `${what} ${name} shown in a dialog (clipboard unavailable).`;
      }
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
        const portIssue = await ensurePortFree(entry);
        if (portIssue) return portIssue;
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
        const portIssue = await ensurePortFree(entry);
        if (portIssue) return portIssue;
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
      name: 'sidecarLauncher.addSidecar',
      label: 'Add Sidecar',
      execute: async (): Promise<ResultLine | null> => {
        const arr = await readRawConfigs();
        if (!arr) {
          return { level: 'error', message: 'Sidecars JSON is invalid — fix it via Edit as JSON first.' };
        }
        const value = await openSidecarForm(null);
        if (!value) return null;
        value.id = newId();
        arr.push(value);
        await writeRawConfigs(arr);
        await resolve();
        await selectSidecar(value.id as string);
        const unset = await unsetSecretNames(value.id as string, value);
        return { level: unset.length ? 'warn' : 'info', message: `Added "${value.name as string}".${unsetHint(unset)}` };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.editSidecar',
      label: 'Edit Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine | null> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const arr = await readRawConfigs();
        if (!arr) {
          return { level: 'error', message: 'Sidecars JSON is invalid — fix it via Edit as JSON first.' };
        }
        const idx = arr.findIndex((o) => o && o['id'] === entry.id);
        const value = await openSidecarForm(idx >= 0 ? arr[idx] : null, Object.keys(entry.secretValues));
        if (!value) return null;
        value.id = entry.id;
        if (idx >= 0) arr[idx] = value;
        else arr.push(value);
        await writeRawConfigs(arr);
        // A name removed from the form's secret list is an explicit edit: drop its
        // stored value too rather than leave it orphaned in the keychain.
        await pruneSecrets(entry.id, Array.isArray(value.secretEnv) ? (value.secretEnv as string[]) : []);
        await resolve();
        await updatePanel(buildPanelModel());
        const running = pool.isRunning(entry.id);
        const unset = await unsetSecretNames(entry.id, value);
        return {
          level: unset.length ? 'warn' : 'info',
          message: `Saved "${value.name as string}".${running ? ' Restart to apply.' : ''}${unsetHint(unset)}`,
        };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.duplicateSidecar',
      label: 'Duplicate Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine | null> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const arr = await readRawConfigs();
        if (!arr) {
          return { level: 'error', message: 'Sidecars JSON is invalid — fix it via Edit as JSON first.' };
        }
        const src = arr.find((o) => o && o['id'] === entry.id);
        if (!src) return { level: 'error', message: 'Could not find the selected sidecar to duplicate.' };
        // Secret values are keyed by id, so the copy declares the same names but
        // starts with all of them unset — secrets are never copied.
        const copy: Record<string, unknown> = { ...src, id: newId(), name: `${entry.name} copy` };
        arr.push(copy);
        await writeRawConfigs(arr);
        await resolve();
        await selectSidecar(copy.id as string);
        const unset = await unsetSecretNames(copy.id as string, copy);
        return {
          level: unset.length ? 'warn' : 'info',
          message: `Duplicated as "${copy.name as string}".${unsetHint(unset)}`,
        };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.removeSidecar',
      label: 'Remove Sidecar',
      execute: async (idArg?: unknown): Promise<ResultLine | null> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        const running = pool.isRunning(entry.id);
        const answer = await joplin.views.dialogs.showMessageBox(
          `Remove sidecar "${entry.name}"?` +
            (running ? '\n\nIt is running and will be stopped first.' : ''),
        );
        if (answer !== 0) return { level: 'warn', message: 'Removal cancelled.' };
        if (running) await pool.stop(entry.id);
        const arr = await readRawConfigs();
        if (!arr) {
          return { level: 'error', message: 'Sidecars JSON is invalid — fix it via Edit as JSON first.' };
        }
        await writeRawConfigs(arr.filter((o) => !(o && o['id'] === entry.id)));
        await deleteSidecarSecrets(entry.id);
        await resolve();
        await updatePanel(buildPanelModel());
        return { level: 'info', message: `Removed "${entry.name}".` };
      },
    });

    await joplin.commands.register({
      name: 'sidecarLauncher.manageSecrets',
      label: 'Manage Sidecar Secrets',
      execute: async (idArg?: unknown): Promise<ResultLine | null> => {
        const { entry } = await resolve(asId(idArg));
        if (!entry) return { level: 'error', message: 'No sidecar configured.' };
        if (!entry.secretEnv.length) {
          return {
            level: 'warn',
            message: `"${entry.name}" declares no secret env vars — add names under Secret environment variables in Edit.`,
          };
        }
        const setNames = Object.keys(entry.secretValues);
        await joplin.views.dialogs.setHtml(secretsDialog, secretsDialogHtml(entry.name, entry.secretEnv, setNames));
        await joplin.views.dialogs.setButtons(secretsDialog, [
          { id: 'cancel', title: 'Cancel' },
          { id: 'clear', title: 'Clear' },
          { id: 'copy', title: 'Copy' },
          { id: 'generate', title: 'Generate' },
          { id: 'set', title: 'Set' },
        ]);
        const res = (await joplin.views.dialogs.open(secretsDialog)) as {
          id: string;
          formData?: { main?: { name?: string; value?: string } };
        };
        if (res.id === 'cancel') return null;
        const name = res.formData?.main?.name ?? '';
        // Only act on a name the entry declares — the select is the only source,
        // but don't trust the webview's form data blindly.
        if (!entry.secretEnv.includes(name)) {
          return { level: 'error', message: 'Unknown secret variable — nothing changed.' };
        }
        const isSet = setNames.includes(name);
        const restart = pool.isRunning(entry.id) ? ' Restart to apply.' : '';
        let message: string;
        switch (res.id) {
          case 'set': {
            // Trimmed: a stray newline from a paste is far likelier than a key
            // that genuinely ends in whitespace.
            const value = (res.formData?.main?.value ?? '').trim();
            if (!value) return { level: 'warn', message: `No value entered — ${name} unchanged.` };
            await setSecret(entry.id, name, value);
            message = `${name} set.${restart}`;
            break;
          }
          case 'generate': {
            if (isSet) {
              const answer = await joplin.views.dialogs.showMessageBox(
                `${name} already has a value. Replace it with a newly generated one?\n\n` +
                  'Anything using the old value (e.g. an MCP client config) will need the new one.',
              );
              if (answer !== 0) return { level: 'warn', message: `${name} unchanged.` };
            }
            const value = generateSecretValue();
            await setSecret(entry.id, name, value);
            message = `${await revealSecret(name, value, 'Generated')}${restart}`;
            break;
          }
          case 'copy': {
            const value = entry.secretValues[name];
            if (!value) return { level: 'warn', message: `${name} is unset — nothing to copy.` };
            return { level: 'info', message: await revealSecret(name, value, 'Value of') };
          }
          case 'clear':
            if (!isSet) return { level: 'warn', message: `${name} was already unset.` };
            await clearSecret(entry.id, name);
            message = `${name} cleared.${restart}`;
            break;
          default:
            return null; // dialog dismissed
        }
        await resolve();
        await updatePanel(buildPanelModel());
        return { level: 'info', message };
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
      { commandName: 'sidecarLauncher.openDashboard' },
      { commandName: 'sidecarLauncher.togglePanel' },
      { commandName: 'sidecarLauncher.addSidecar' },
      { commandName: 'sidecarLauncher.editSidecar' },
      { commandName: 'sidecarLauncher.duplicateSidecar' },
      { commandName: 'sidecarLauncher.removeSidecar' },
      { commandName: 'sidecarLauncher.manageSecrets' },
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
      const portIssue = await ensurePortFree(entry);
      if (portIssue) {
        lastResult = portIssue;
        continue; // port busy and not reclaimed — skip this autostart
      }
      await pool.start(entry.id, entry);
    }
    await updatePanel(buildPanelModel());

    // Stop on unload: stop every sidecar whose config opts in (default), plus any
    // orphans the pool still holds. Leave sidecars with stopOnUnload:false running.
    joplin.plugins.onUnload(async () => {
      const { configs } = await loadConfigs();
      const keepRunning = new Set(configs.filter((c) => !c.stopOnUnload).map((c) => c.id));
      const shouldStop = (id: string) => !keepRunning.has(id);
      if (pool.anyAlive()) {
        // SIGTERM the process groups (delivered synchronously, so it lands even if
        // Joplin doesn't await us), give them a moment, then SIGKILL any survivors
        // (including ones stuck in 'stopping' that ignored SIGTERM).
        await pool.stopAll(shouldStop);
        await new Promise((r) => setTimeout(r, 800));
        pool.forceKillAll(shouldStop);
      }
    });
  },
});
