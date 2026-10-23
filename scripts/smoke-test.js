#!/usr/bin/env node
// Smoke test for the built plugin bundle (publish/index.js).
//
// Loads the bundle with a stub `joplin` global and drives its lifecycle:
//   1. the bundle registers a plugin and onStart() resolves;
//   2. settings, dialogs, panel, and commands are registered;
//   3. an autostart sidecar (a sleeping node process) is actually spawned;
//   4. the onUnload handler stops it.
// It catches broken bundles (bad loader/transpiler output, missing modules,
// interop mistakes) — not UI behaviour, which still needs a real Joplin.
//
// Usage: node scripts/smoke-test.js [path/to/index.js]
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const bundle = path.resolve(process.argv[2] || path.join(__dirname, '..', 'publish', 'index.js'));
const TIMEOUT_MS = 20000;
// Unique marker so we can find exactly our child process with pgrep.
const MARKER = `sidecar-smoke-${process.pid}-${Date.now()}`;

function fail(msg) {
  console.error(`::error::Smoke test failed: ${msg}`);
  // Don't leave our child behind if we failed before (or during) unload.
  try { execFileSync('pkill', ['-f', MARKER], { stdio: 'ignore' }); } catch { /* none left */ }
  process.exit(1);
}

const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
process.on('unhandledRejection', (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

// Settings store: populated from the plugin's own registerSettings() defaults,
// then the sidecar config is overridden with one autostart entry.
const settings = new Map();
const sidecarConfig = [{
  name: 'Smoke',
  command: process.execPath,
  args: ['-e', `/* ${MARKER} */ setTimeout(() => {}, 60000)`],
  autostart: true,
  stopOnUnload: true,
}];

const calls = [];
let plugin = null;
let unloadHandler = null;

// Catch-all for API surfaces the test doesn't model: any property chain is
// callable and resolves to undefined.
const anything = (name) => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : anything(`${name}.${String(k)}`)),
  apply: () => { calls.push(name); return Promise.resolve(undefined); },
});

const settingsApi = {
  registerSection: async () => { calls.push('settings.registerSection'); },
  registerSettings: async (defs) => {
    calls.push('settings.registerSettings');
    for (const [key, def] of Object.entries(defs)) {
      if (!settings.has(key)) settings.set(key, def.value);
    }
    settings.set('sidecar.configs', JSON.stringify(sidecarConfig));
  },
  value: async (key) => {
    if (!settings.has(key)) fail(`read of unregistered setting "${key}"`);
    return settings.get(key);
  },
  setValue: async (key, v) => { settings.set(key, v); },
  onChange: async () => {},
};

let handleSeq = 0;
const viewsApi = new Proxy({}, {
  get: (_t, area) => new Proxy({}, {
    get: (_u, method) => async () => {
      calls.push(`views.${String(area)}.${String(method)}`);
      // create() must return a handle; everything else resolves to undefined.
      return method === 'create' ? `handle-${++handleSeq}` : undefined;
    },
  }),
});

globalThis.joplin = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'plugins') {
      return {
        register: (p) => { plugin = p; },
        onUnload: (fn) => { unloadHandler = fn; },
      };
    }
    if (k === 'settings') return settingsApi;
    if (k === 'views') return viewsApi;
    if (k === 'commands') {
      return {
        register: async (cmd) => { calls.push(`commands.register:${cmd.name}`); },
        execute: async () => undefined,
      };
    }
    return anything(`joplin.${String(k)}`);
  },
});

function childAlive() {
  try {
    execFileSync('pgrep', ['-f', MARKER], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`timed out waiting for ${what}`);
}

(async () => {
  try {
    require(bundle);
  } catch (err) {
    // Not err.stack: for a SyntaxError it embeds the whole minified line.
    fail(`bundle threw on load: ${err && err.name}: ${err && err.message}`);
  }
  if (!plugin || typeof plugin.onStart !== 'function') fail('plugin was not registered');

  try {
    await plugin.onStart();
  } catch (err) {
    fail(`onStart threw: ${err.stack || err}`);
  }

  const has = (prefix) => calls.some((c) => c.startsWith(prefix));
  for (const expected of ['settings.registerSettings', 'views.dialogs.create', 'views.panels.create', 'commands.register:']) {
    if (!has(expected)) fail(`expected a ${expected} call during onStart`);
  }
  const commandCount = calls.filter((c) => c.startsWith('commands.register:')).length;
  if (typeof unloadHandler !== 'function') fail('onUnload handler was not registered');

  await waitFor(childAlive, 5000, 'autostart sidecar to spawn');
  console.log(`onStart OK: ${commandCount} commands registered; autostart sidecar running`);

  await unloadHandler();
  await waitFor(() => !childAlive(), 5000, 'sidecar to stop on unload');
  console.log('onUnload OK: sidecar stopped');

  clearTimeout(timer);
  process.exit(0);
})().catch((err) => fail(err.stack || err));
