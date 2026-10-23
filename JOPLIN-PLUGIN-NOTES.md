# Joplin Plugin Development — Hard-Won Notes

Lessons learned building this plugin that aren't in the official documentation.
Kept here so future work on this repo (or any other Joplin plugin) doesn't
repeat the same debugging sessions.

---

## 1. `.jpl` is a TAR archive, not a zip

Joplin's installer feeds the `.jpl` file to a TAR parser. If you create it with
`zip`, the installer silently does nothing — no error in the UI, and the only
evidence is `TAR_ENTRY_INVALID: checksum failure` in the renderer console.

**Correct:**
```bash
cd publish
tar -cf ../my-plugin.jpl index.js manifest.json
```

The `npm run package` script in this repo does this correctly.

---

## 2. `api` is not a Node module — do not use `externals`

Every approach involving webpack `externals` for the `api` module fails:

```js
// All of these break at runtime:
externals: { 'api': 'commonjs api' }   // require('api') → "Cannot find module"
externals: { 'api': 'var joplin' }     // module.exports = joplin → plugin loads
                                        // but onStart is never called
```

**Why:** Joplin runs plugins in a Node.js `vm` sandbox. The `joplin` API object
is injected as a **context variable** — it lives in the sandbox's global scope,
not on the Node module resolution path. There is nothing for `require('api')` to
find.

**The correct pattern** (used by `generator-joplin`) is to bundle a local `api/`
shim directory:

```
api/
  index.ts      — declare const joplin: Joplin; export default joplin;
  types.ts      — all the enums and interfaces
  *.d.ts        — per-class type declarations
```

`api/index.ts` uses a TypeScript **ambient declaration** (`declare const`), which
generates no JavaScript. The `export default joplin` compiles to:

```js
exports.default = joplin;  // direct reference to the sandbox context variable
```

No `require()` anywhere. webpack resolves the alias at bundle time; the runtime
value comes from the sandbox.

**webpack config:**
```js
resolve: {
  alias: {
    'api':        path.resolve(__dirname, 'api'),
    'api/types':  path.resolve(__dirname, 'api', 'types.ts'),
  },
}
```

Copy the `api/` directory from a fresh `generator-joplin` scaffold. Do not
hand-roll the ambient declarations — the generator's versions are authoritative
and kept in sync with Joplin releases.

---

## 3. Plugin failure state persists in the database

Plugin run state (including failure records) is stored in Joplin's SQLite
database (`~/.config/joplin-desktop/database.sqlite`). It survives:

- Clearing the plugin cache (`~/.config/joplin-desktop/cache/<plugin-id>/`)
- Uninstalling and reinstalling the same version

If a plugin previously failed to start (e.g. due to the `require('api')` error),
Joplin may silently skip starting it on subsequent launches even after the code
is fixed. Symptoms: `PluginService: Loading plugin from X` appears in the log
but `joplin.plugins: Starting plugin: X` never does, with no error logged.

**Fix:** bump the version number in `src/manifest.json` and `package.json`. This
produces a different `_package_hash` and creates a new state record, breaking
the association with the old failure.

You can also inspect or clear stale state directly:
```bash
sqlite3 ~/.config/joplin-desktop/database.sqlite \
  "SELECT key, value FROM settings WHERE key LIKE '%<plugin-id>%';"
```

---

## 4. Reading the log: Loading vs Starting

Two distinct log lines; only one means the plugin actually ran:

| Log line | What it means |
|---|---|
| `PluginService: Loading plugin from X` | Manifest parsed, Plugin object created |
| `joplin.plugins: Starting plugin: X` | Runner invoked, `onStart` will be called |

If you see "Loading" but not "Starting" with no error, it is a database state
problem (see note 3), not a code problem. Check enabled state and version.

---

## 5. `onUnload` is a quit-time hook, not a disable hook

`joplin.plugins.onUnload(callback)` fires when Joplin itself quits. It does
**not** fire when the user toggles a plugin off in the preferences panel. That
toggle sets a "disabled on next restart" flag; the plugin continues running for
the rest of the current session.

Practical consequence: if a user disables this plugin mid-session while a sidecar
is running, the sidecar keeps running until Joplin exits (at which point
`onUnload` fires and stops it, assuming a clean quit). The Stop button is the
reliable way to stop the sidecar immediately.

---

## 6. tsconfig: no `rootDir`, and no `baseUrl` on TypeScript 7

The generator template does not set `rootDir`. If you set `rootDir: "src"`,
TypeScript will reject any files outside `src/` — including the `api/` directory
at the project root. Add `api/**/*` to `include` instead.

The template's `baseUrl: "."` and `moduleResolution: "node"` are **removed** in
TypeScript 7 (errors TS5102 / TS5108). Use `bundler` resolution and make the
`paths` entries relative:

```json
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "paths": {
      "api": ["./api/index.ts"],
      "api/types": ["./api/types.ts"]
    }
  },
  "include": ["src/**/*", "api/**/*"]
}
```

TypeScript 7 is the native compiler and has no JS API, so `ts-loader` can't use
it. Webpack transpiles with `esbuild-loader` (types stripped, not checked);
`npm run typecheck` is the only type-checking pass, and CI runs it.
