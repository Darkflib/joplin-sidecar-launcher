#!/usr/bin/env node
// Smoke test for the built plugin bundle (publish/index.js).
//
// Loads the bundle with a stub `joplin` global and drives its lifecycle:
//   1. the bundle registers a plugin and onStart() resolves;
//   2. settings, dialogs, panel, and commands are registered;
//   3. an autostart sidecar (a sleeping node process) is actually spawned;
//   4. the child sees its `env` and keychain-backed `secretEnv` values, plus the
//      launcher-owned vars, and not the blocklisted Python vars;
//   5. an autostart entry that tries to override JOPLIN_TOKEN is refused;
//   6. Copy diagnostics shows env values, redacts secrets to ***set***/***unset***,
//      and the secret echoed by the child is masked in the captured log;
//   7. the onUnload handler stops it.
// It catches broken bundles (bad loader/transpiler output, missing modules,
// interop mistakes) — not UI behaviour, which still needs a real Joplin.
//
// Usage: node scripts/smoke-test.js [path/to/index.js]
'use strict';

const fs = require('fs');
const os = require('os');
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
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* not created yet */ }
  process.exit(1);
}

const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
process.on('unhandledRejection', (err) => fail(`unhandled rejection: ${err && err.stack || err}`));

// Must never reach the child (PYTHON_ENV_BLOCKLIST).
process.env.PYTHONPATH = '/smoke/should-be-stripped';

const SECRET_VALUE = 'smoke-secret-value-0123456789';
const TOKEN_VALUE = 'smoke-joplin-token-abcdef';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-smoke-'));
const envOut = path.join(tmpDir, 'env.json');

// The child records the vars we care about, echoes the secret to stdout (so we
// can check the log redaction), then sleeps until stopped.
const childScript = `/* ${MARKER}-ok */
const keys = ['SMOKE_ENV', 'SMOKE_SECRET', 'SMOKE_UNSET', 'JOPLIN_TOKEN', 'JOPLIN_BASE_URL',
  'JOPLIN_SIDECAR_LAUNCHED_BY', 'PYTHONPATH'];
const out = {};
for (const k of keys) out[k] = process.env[k] === undefined ? null : process.env[k];
require('fs').writeFileSync(process.argv[1], JSON.stringify(out));
console.log('secret is ' + process.env.SMOKE_SECRET);
setTimeout(() => {}, 60000);`;

// Settings store: populated from the plugin's own registerSettings() defaults,
// then the sidecar config, secret map and token are overridden.
const settings = new Map();
const sidecarConfig = [
  {
    id: 'smoke',
    name: 'Smoke',
    command: process.execPath,
    args: ['-e', childScript, envOut],
    env: { SMOKE_ENV: 'plain-value' },
    secretEnv: ['SMOKE_SECRET', 'SMOKE_UNSET'],
    autostart: true,
    stopOnUnload: true,
  },
  {
    // Reserved-key override: validation must block this autostart.
    id: 'smoke-reserved',
    name: 'Smoke reserved',
    command: process.execPath,
    args: ['-e', `/* ${MARKER}-reserved */ setTimeout(() => {}, 60000)`],
    env: { JOPLIN_TOKEN: 'hijack' },
    autostart: true,
    stopOnUnload: true,
  },
];

const calls = [];
const messageBoxes = [];
const commands = new Map();
let clipboardText = null;
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
    if (!settings.has('sidecar.secretEnv')) fail('sidecar.secretEnv setting was not registered');
    if (defs['sidecar.secretEnv'].secure !== true) fail('sidecar.secretEnv must be a secure setting');
    settings.set('sidecar.secretEnv', JSON.stringify({ smoke: { SMOKE_SECRET: SECRET_VALUE } }));
    settings.set('sidecar.joplinToken', TOKEN_VALUE);
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
    get: (_u, method) => async (...args) => {
      calls.push(`views.${String(area)}.${String(method)}`);
      if (method === 'showMessageBox') messageBoxes.push(String(args[0]));
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
    if (k === 'clipboard') {
      return {
        writeText: async (t) => { clipboardText = t; },
        readText: async () => clipboardText ?? '',
      };
    }
    if (k === 'versionInfo') return async () => ({ version: 'smoke', platform: process.platform });
    if (k === 'commands') {
      return {
        register: async (cmd) => {
          calls.push(`commands.register:${cmd.name}`);
          commands.set(cmd.name, cmd);
        },
        execute: async () => undefined,
      };
    }
    return anything(`joplin.${String(k)}`);
  },
});

function childAlive(marker = `${MARKER}-ok`) {
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' });
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

  await waitFor(() => childAlive(), 5000, 'autostart sidecar to spawn');
  console.log(`onStart OK: ${commandCount} commands registered; autostart sidecar running`);

  // --- Env injection ---
  await waitFor(() => fs.existsSync(envOut) && fs.statSync(envOut).size > 0, 5000, 'child to report its env');
  const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
  const expectEnv = {
    SMOKE_ENV: 'plain-value',
    SMOKE_SECRET: SECRET_VALUE,
    SMOKE_UNSET: null,
    JOPLIN_TOKEN: TOKEN_VALUE,
    JOPLIN_SIDECAR_LAUNCHED_BY: 'joplin-sidecar-launcher',
    PYTHONPATH: null,
  };
  for (const [k, v] of Object.entries(expectEnv)) {
    if (seen[k] !== v) fail(`child env ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(seen[k])}`);
  }
  console.log('Env OK: env + secretEnv injected, launcher vars intact, blocklist stripped');

  // --- Reserved-key rejection ---
  if (childAlive(`${MARKER}-reserved`)) fail('sidecar overriding JOPLIN_TOKEN was started');
  const refusal = messageBoxes.find((m) => m.includes('Smoke reserved') && m.includes('JOPLIN_TOKEN'));
  if (!refusal) fail(`expected an autostart refusal naming JOPLIN_TOKEN; got: ${JSON.stringify(messageBoxes)}`);
  if (refusal.includes('hijack')) fail('refusal message leaked the env value');
  console.log('Reserved key OK: JOPLIN_TOKEN override refused');

  // --- Diagnostics redaction ---
  const diagCmd = commands.get('sidecarLauncher.copyDiagnostics');
  if (!diagCmd) fail('copyDiagnostics command not registered');
  // Give the child's stdout line time to be captured before taking the report.
  await new Promise((r) => setTimeout(r, 300));
  await diagCmd.execute('smoke');
  if (typeof clipboardText !== 'string') fail('diagnostics were not copied to the clipboard');
  for (const needle of ['SMOKE_ENV=plain-value', 'SMOKE_SECRET=***set***', 'SMOKE_UNSET=***unset***', 'secret is ***']) {
    if (!clipboardText.includes(needle)) fail(`diagnostics missing "${needle}":\n${clipboardText}`);
  }
  for (const leaked of [SECRET_VALUE, TOKEN_VALUE]) {
    if (clipboardText.includes(leaked)) fail('diagnostics leaked a secret value');
  }
  console.log('Diagnostics OK: env shown, secrets redacted, echoed secret masked in log');

  await unloadHandler();
  await waitFor(() => !childAlive(), 5000, 'sidecar to stop on unload');
  console.log('onUnload OK: sidecar stopped');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearTimeout(timer);
  process.exit(0);
})().catch((err) => fail(err.stack || err));
