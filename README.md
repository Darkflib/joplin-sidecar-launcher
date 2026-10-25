# joplin-sidecar-launcher

A Joplin desktop plugin that launches, monitors, and stops local sidecar processes from within Joplin. The primary use case is keeping a Python-based PKM sidecar service alive alongside Joplin — think a FastAPI embedding server, a local RAG pipeline, a note-sync daemon, or any other `localhost`-bound helper process.

---

## ⚠️ Security Warning

**This plugin executes arbitrary shell commands as the user running Joplin.** The command, arguments, and working directory are taken directly from Joplin's settings. Anyone with write access to your Joplin settings profile can modify these values.

- **Never** set the command to a network-writable path.
- **Never** install this plugin on a shared Joplin instance.
- The health check URL is restricted to `localhost` (`127.0.0.1`, `::1`, `localhost`) and HTTP only. Remote URLs will be rejected.
- The plugin strips a short list of Python environment variables (`PYTHONHOME`, `PYTHONPATH`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, `CONDA_PREFIX`) to prevent the host Python environment from leaking into child interpreters. This is a best-effort measure, not a sandbox.
- Values in a sidecar's `env` object are stored **in plaintext** in the Sidecars JSON. Put credentials in `secretEnv` instead — those values are stored encrypted, with the key held in the OS keychain (see [Environment variables](#environment-variables)).

---

## What it does

- **Manage multiple sidecars.** Add, edit, duplicate, and remove sidecars from the panel via a simple form — each with its own command, health check, dashboard URL, and lifecycle. The status panel has a dropdown to switch between them. (A raw-JSON editor remains available for power users.)
- **Launch** a configurable command with arguments and working directory when you click *Start* (or automatically on plugin load, per sidecar).
- **Monitor** each process: tracks state (`stopped`, `starting`, `running`, `healthy`, `unhealthy`, `stopping`, `crashed`), PID, start/exit times, and exit code.
- **Health polling**: optionally hits a localhost HTTP endpoint on a configurable interval and reflects the result in the panel.
- **Open dashboard**: opens the selected sidecar's configured `dashboardUrl` in your default browser via the OS handler. For Joplin-sidecar-style CLIs that expose an `open` subcommand, opt the entry into `useSidecarOpener` and the launcher will instead run `<command> … open --port <port>` so the sidecar can hand the token off via the URL fragment.
- **Log capture**: captures stdout/stderr into a rolling in-memory buffer (configurable size). The log area is collapsed by default and grows to fill the panel when expanded.
- **Stop/Restart**: sends SIGTERM to the whole process group gracefully; restart waits up to 3 s then SIGKILL if the process hasn't exited.
- **Stale-port reclaim**: before starting, checks whether the sidecar's port (from its `healthUrl`/`dashboardUrl`) is already bound. If a leftover process from a previous session holds it, you're offered a one-click *stop it and continue* — no more manual `lsof … kill`.
- **Inline results, not alert spam**: button actions report their outcome on a line beneath the buttons. Benign no-ops (e.g. *Stop* when already stopped) just show a message — no popup. Popups remain only where the action is blocked and needs guidance (failed preflight before *Start*) or is an explicit flow (preflight report, Joplin auth, the JSON editor).
- **Environment injection**: per-sidecar `env` vars, plus `secretEnv` vars whose values are stored encrypted (key in the OS keychain) and set via a *Secrets* dialog (with a *Generate* button for API keys).
- **Diagnostics**: one-click clipboard dump of the selected sidecar's config, status, and recent log lines — useful for bug reports. Secret values are redacted.
- **Status panel**: a side panel showing live state, PID, health, timestamps, and log output with Start/Stop/Restart/Open-dashboard/Edit/Copy-diag buttons.
- **Tools menu integration**: all commands also available under *Tools → Sidecar Launcher* (they act on the sidecar currently selected in the panel).

---

## Installation

No marketplace listing yet. Install manually:

1. Download `joplin-sidecar-launcher.jpl` from the [latest release](https://github.com/darkflib/joplin-sidecar-launcher/releases/latest) (or build it yourself — see below). Each release also carries a `.sha256` file; check it with `sha256sum -c joplin-sidecar-launcher.jpl.sha256`.
2. In Joplin: *Tools → Options → Plugins → Install from file* → select the `.jpl`.
3. Restart Joplin.

---

## Configuration

The friendliest way to manage sidecars is the panel's **Manage** row:

- **Add** — opens a form (name, command, args one-per-line, working directory, health/dashboard URLs, autostart, etc.) and appends a new sidecar.
- **Edit** — the same form, prefilled for the selected sidecar.
- **Duplicate** — clones the selected sidecar (as *"… copy"*) so you can tweak one field. Secret values are **not** copied: the clone declares the same `secretEnv` names, all unset.
- **Remove** — deletes the selected sidecar (and stops it first if it's running), along with its stored secret values.
- **Secrets** — set, generate, copy, or clear the values of the selected sidecar's `secretEnv` vars.

Under the hood these edit a single **JSON array** setting. Power users can edit it
directly via the panel's *Edit JSON* button (or *Tools → Sidecar Launcher → Edit
Sidecars (JSON)*); the raw value also lives in *Tools → Options → Sidecar Launcher
→ Sidecars (JSON array)*.

Each object in the array:

| Field | Required | Description |
|---|---|---|
| `name` | recommended | Label shown in the panel selector. Defaults to `Sidecar N`. |
| `command` | yes | Executable to run. **Use an absolute path** (e.g. `/opt/homebrew/bin/uv`) — Joplin launched from the Dock/Finder does not inherit your shell PATH. |
| `args` | no | Arguments as a JSON array, e.g. `["-m", "http.server", "8765"]`. Defaults to `[]`. |
| `cwd` | no | Absolute path. Defaults to `$HOME`. |
| `healthUrl` | no | `http://127.0.0.1:PORT/path` endpoint polled for liveness. Localhost + HTTP only. |
| `dashboardUrl` | no | URL opened by the *Open dashboard* button via your OS handler. When `useSidecarOpener` is true the URL is not opened directly — instead its port is passed to the CLI's `open` subcommand. |
| `useSidecarOpener` | no | Opt-in for Joplin-sidecar-style CLIs that expose an `open` subcommand. When true, *Open dashboard* runs `<command> <prefix-before-serve> open --port <port>` so the sidecar can hand the token off via the URL fragment. Default `false` — leave off for generic `serve` commands (e.g. `npx serve public`, `python -m http.server`) that don't have a matching `open`. |
| `autostart` | no | Start this sidecar automatically on plugin load. Defaults to `false`. |
| `stopOnUnload` | no | SIGTERM this sidecar when Joplin quits. Defaults to `true`. |
| `healthIntervalSeconds` | no | Health poll interval, 1–300. Defaults to `5`. |
| `maxLogLines` | no | Rolling log buffer size, 10–1000. Defaults to `100`. |
| `env` | no | Object of extra **non-secret** environment variables, e.g. `{ "MCP_HOST": "127.0.0.1", "MCP_PORT": "5005" }`. Values must be strings. Stored in plaintext. |
| `secretEnv` | no | Array of **secret** variable *names*, e.g. `["MCP_API_KEY"]`. Values are set with the panel's *Secrets* button and stored encrypted by Joplin's secure-settings store — never in this JSON. |

The **Joplin API base URL and token are configured separately** (the table below
the JSON, and the *Authorise Joplin API token* command) and are shared across
**all** sidecars — injected into each as `JOPLIN_BASE_URL` / `JOPLIN_TOKEN`. The
token is kept out of the Sidecars JSON on purpose, so it is never written to disk
in plaintext (it lives in the OS keychain).

### Environment variables

The child environment is built in this order, later entries winning:

1. Joplin's own environment, minus the Python blocklist above.
2. The entry's `env`.
3. The entry's `secretEnv` values (from the keychain).
4. Launcher-owned variables: `JOPLIN_SIDECAR_LAUNCHED_BY`, `JOPLIN_BASE_URL`, `JOPLIN_TOKEN`.

Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. The launcher-owned names and the
Python-blocklisted names are **rejected** (case-insensitively, for Windows'
sake) in both `env` and `secretEnv`, as is a name that appears in both. A
rejected key is a configuration error, so *Start* is blocked with an
explanation rather than the variable being silently dropped.

**Secrets.** List the names in `secretEnv`, save, then click **Secrets** in the
panel. Pick a variable and either type a value and click **Set**, click
**Generate** to store 32 random bytes (base64url) and copy them to the
clipboard (ideal for `MCP_API_KEY`, which you then paste into your MCP client
config), **Copy** to put the current value on the clipboard, or **Clear**.
Restart the sidecar to apply. All secret values sit in a single `secure`
setting holding `{ sidecarId: { NAME: value } }` — the same mechanism as the
Joplin token.

**Where secure settings actually live.** Desktop Joplin does not create one
keychain item per secure setting. It uses Electron's `safeStorage`: the OS
keychain holds a single master key for the app (on macOS a Keychain Access item
named "Joplin Safe Storage"; libsecret/kwallet on Linux; DPAPI on Windows), and
each value is encrypted with it and stored in Joplin's own database
(`database.sqlite`, table `key_values`, key
`KeychainServiceDriver.secureStore.setting.plugin-io.github.darkflib.joplin-sidecar-launcher.sidecar.secretEnv`).
So you won't find your secrets in Keychain Access — only the master key — and a
copy of the database is useless without that keychain item.

If writing to the keychain fails (e.g. a locked macOS login keychain), Joplin
deliberately falls back to saving the value **in plaintext** in its `settings`
table so it isn't lost, and logs `Could not set setting on the keychain` in
`log.txt`. Surviving a restart doesn't tell the two apart; to check, quit Joplin
and run:

```bash
DB=~/.config/joplin-desktop/database.sqlite   # adjust for your profile
# Expect one row: the encrypted blob's length, never the value.
sqlite3 "$DB" "SELECT key, length(value) FROM key_values WHERE key LIKE 'KeychainServiceDriver.secureStore.%secretEnv';"
# Expect no rows. A row here means the plaintext fallback was used.
sqlite3 "$DB" "SELECT key FROM settings WHERE key LIKE '%sidecar.secretEnv%';"
```

Secret values never appear in the Sidecars JSON, the forms, the result line,
or diagnostics (which show `NAME=***set***` / `NAME=***unset***`; plaintext
`env` values with credential-looking names are hidden there too). If the
sidecar prints a secret (or the Joplin token) to stdout/stderr, it is masked
as `***` in the captured log. Values shorter than four characters are not
masked.

Preflight warns about declared-but-unset secrets, and about `env` keys that
look like credentials (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …).

Removing a `secretEnv` name in the *Edit* form deletes its stored value;
removing it via the raw JSON editor leaves the value stored but no longer
injected. Removing a sidecar deletes all of its values.

### Example: Joplin MCP server

```json
{
  "name": "Joplin MCP",
  "command": "/opt/homebrew/bin/uv",
  "args": ["run", "--project", "/Users/you/mcp-joplin", "mcp-joplin"],
  "cwd": "/Users/you/mcp-joplin",
  "healthUrl": "http://127.0.0.1:5005/health",
  "env": { "MCP_HOST": "127.0.0.1", "MCP_PORT": "5005" },
  "secretEnv": ["MCP_API_KEY"],
  "autostart": true
}
```

This needs [mcp-joplin](https://github.com/Darkflib/mcp-joplin) 0.2 or later. Older checkouts,
from when it was `mcp-joplin-streamable-sse`, use that name for both the path and the command.

Then *Secrets → MCP_API_KEY → Generate*, and paste the copied key into your
MCP client's `X-API-Key` header. `JOPLIN_BASE_URL` / `JOPLIN_TOKEN` come from
the shared settings as usual.

### Example: two sidecars

```json
[
  {
    "name": "Static smoke test",
    "command": "/usr/bin/python3",
    "args": ["-m", "http.server", "8765", "--bind", "127.0.0.1"],
    "healthUrl": "http://127.0.0.1:8765/",
    "dashboardUrl": "http://127.0.0.1:8765/",
    "autostart": false
  },
  {
    "name": "PKM sidecar",
    "command": "/opt/homebrew/bin/uv",
    "args": ["run", "--project", "/Users/you/pkm-sidecar", "python", "-m", "pkm_sidecar.main", "serve"],
    "cwd": "/Users/you/pkm-sidecar",
    "healthUrl": "http://127.0.0.1:8766/health",
    "dashboardUrl": "http://127.0.0.1:8766/",
    "useSidecarOpener": true,
    "autostart": true,
    "stopOnUnload": true
  }
]
```

The first is a static file server in `$HOME` (its health URL returns 200, so it
flips to `healthy` after the first poll). The second is a `uv`-managed FastAPI
sidecar; `uv run` resolves the project's own virtual environment.

### Migrating from 0.1.x

If you previously configured a single sidecar via the flat Command/Arguments/etc.
fields, those are **migrated automatically** into the Sidecars JSON the first time
0.2.0 loads — you'll see a one-element array named `Sidecar`. The old single-sidecar
fields are then hidden from the settings page (they're retained internally only so
the one-time migration can read them).

---

## Build from source

Prerequisites: Node.js ≥ 20.9 (webpack-cli 7 and copy-webpack-plugin 14 require it), npm ≥ 9.

```bash
git clone https://github.com/darkflib/joplin-sidecar-launcher.git
cd joplin-sidecar-launcher
npm install
npm run dist          # production webpack bundle → publish/
```

The `publish/` directory contains `index.js` and `manifest.json`. To package as a `.jpl`:

```bash
npm run package
```

Or manually (`.jpl` files are **TAR archives**, not zip — using `zip` will produce a file Joplin silently rejects):

```bash
cd publish
tar -cf ../joplin-sidecar-launcher.jpl index.js manifest.json
```

CI builds the `.jpl` on every push to `main` and every pull request, and attaches it to the run as an artifact.

After building, `npm run smoke` loads `publish/index.js` with a stub `joplin` API and checks that `onStart` registers settings, dialogs, the panel and commands; that an autostart sidecar really spawns; and that the unload handler stops it. CI and the release workflow both run it. It catches broken bundles, not UI regressions, so the manual checklist below still applies.

### Cutting a release

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed:

1. Bump `version` in **both** `package.json` and `src/manifest.json` (Joplin reads the manifest; `scripts/check-version.js` fails the build if they drift).
2. Merge to `main`.
3. Tag and push: `git tag v0.3.1 && git push origin v0.3.1`.

The workflow refuses a tag that doesn't match the versions, then typechecks, packages, and publishes a GitHub release with the `.jpl`, its SHA-256, and auto-generated notes. Tags with a hyphen (e.g. `v0.4.0-rc.1`) are marked as prereleases.

For development (source maps, watch mode):

```bash
npm run build         # development build, no minification
```

---

## Known limitations

- **No restart policy.** Crashed processes stay in `crashed` state until you manually click Restart or Start. Automatic retry with back-off is a planned extension.
- **Shared Joplin token.** All sidecars receive the same `JOPLIN_TOKEN` / `JOPLIN_BASE_URL`. Per-sidecar tokens are not currently supported.
- **No stdin.** The child's stdin is closed (`'ignore'`). Interactive processes won't work.
- **Graceful then forced.** Each sidecar is launched as its own process group, and signals go to the whole group — so wrapper-spawned children (e.g. `uv run … uvicorn`) are stopped too, not just the immediate child. The Stop button sends SIGTERM; restart and plugin-unload escalate to SIGKILL if SIGTERM hasn't worked (3 s for restart, ~0.8 s on unload).
- **HTTP health checks only.** HTTPS localhost endpoints are not supported (self-signed cert handling adds complexity for marginal benefit here).
- **Log buffer is in-memory only.** Logs are lost when Joplin restarts. Persistent log files are a planned extension.
- **Env values in the form are single-line and trimmed.** Values with leading/trailing whitespace or embedded newlines must be set via the raw JSON editor (secrets are trimmed on *Set*). If an entry's `env` holds such a value, the form shows it read-only and keeps it unchanged on save.
- **Secret values are per sidecar id.** Editing an entry's `id` in the raw JSON (or deleting it, so a new one is minted) orphans its secrets; set them again.
- **Children can still leak their own env.** Masking covers the launcher's captured log only — a sidecar that writes secrets to its own log files or exposes them over HTTP is outside the launcher's control.
- **macOS/Linux only tested.** Should work on Windows but SIGTERM semantics differ; consider using a wrapper script that handles graceful shutdown.
- **Stop on unload does not fire when disabling the plugin mid-session.** Joplin's "disable" toggle marks the plugin for removal on the next restart; it does not call `onUnload` immediately. Sidecars keep running until Joplin exits. `onUnload` is called when Joplin itself quits, at which point opted-in sidecars are stopped. If you need to stop a sidecar immediately, use the Stop button before disabling.
- **Removing a running sidecar from the JSON does not stop it mid-session.** It keeps running until Joplin quits (then it's cleaned up). Stop it first, then remove it.

---

## Manual test checklist

Work through this after each significant change. Use the *Edit sidecars* button
to set the JSON; absolute `command` paths (run `which python3`).

1. **Migration** — upgrading from 0.1.x with a single sidecar configured: on first load the Sidecars JSON contains a one-element array named `Sidecar` with your old command/args/health URL.
2. **Happy path** — one sidecar with command `python3`, args `["-m", "http.server", "8765", "--bind", "127.0.0.1"]`, health URL `http://127.0.0.1:8765/`. Click Start. State goes `starting → running → healthy`. PID populated. Logs show startup (expand the collapsed log section).
3. **Stop** — click Stop. State goes `stopping → stopped`. PID clears. Exit code 0 or -1 (killed).
4. **Stop when already stopped** — click Stop again. No popup; the result line beneath the buttons reads *Sidecar is not running.*
5. **Restart** — start the server, then click Restart. Old PID disappears, new PID appears.
6. **Multi-sidecar** — define two sidecars on different ports. Use the dropdown to switch. Start sidecar A, switch to B, start B. Both run independently; the panel reflects whichever is selected. PIDs differ.
7. **Per-sidecar dashboard** — set `dashboardUrl` to `http://127.0.0.1:8765/`. Click *Open dashboard*. The OS handler opens the URL as-is. Then flip `useSidecarOpener` to `true` on a Joplin-sidecar-style entry and click again: the launcher runs `<command> … open --port 8765` instead, and the browser receives the dashboard URL with the token in its fragment. With no `dashboardUrl` (and `useSidecarOpener` off or the entry missing a `serve` arg) the result line warns instead of opening.
8. **Crash detection** — a sidecar running `python3 -c "import time; time.sleep(2)"`. Wait 3 s. State flips to `crashed`; log shows unexpected exit.
9. **Bad command** — command `/nonexistent/binary`. Click Start. A dialog explains the blocking preflight failure; the result line points to it.
10. **Bad JSON** — make the Sidecars JSON invalid in the editor and Save. A parse-error dialog appears and nothing is saved.
11. **Remote health URL rejected** — set `healthUrl` to `https://example.com`. Start is blocked with a validation explanation.
12. **Autostart** — set `autostart: true` on one sidecar, reload the plugin. It starts without clicking Start; a sidecar with `autostart: false` does not.
13. **Stop on unload** — start a sidecar with `stopOnUnload: true`, quit Joplin. Verify no zombie process remains (`pgrep -a python3`). A sidecar with `stopOnUnload: false` survives. Use a wrapper (`uv run … uvicorn`) to confirm the *grandchild* dies too, not just the wrapper.
14. **Stale-port reclaim** — leave a process bound to the sidecar's port (e.g. `python3 -m http.server 8765 --bind 127.0.0.1` in a terminal), then click Start. A dialog reports the port is in use (with the PID). OK kills it and starts; Cancel aborts with an inline warning and no popup spam.
15. **Diagnostics** — select a sidecar, click *Copy diag*, paste. Verify the report is for the selected sidecar and all fields are populated.
16. **Collapsible logs** — the log section is collapsed on load. Expand it; it grows to fill the panel. It stays expanded across status updates.
17. **Panel toggle** — *Tools → Sidecar Launcher → Show/Hide Status Panel*. Panel hides and shows correctly.
18. **Max log lines** — set `maxLogLines: 10`, generate >10 lines. Only 10 are retained (check via diagnostics).
19. **Add (form)** — click *Add*, fill name + command + a couple of args (one per line), Save. The new sidecar appears in the dropdown and is selected. Saving with an empty command is refused with a message.
20. **Edit (form)** — select a sidecar, click *Edit*, change the name, Save. The dropdown updates. Editing a running sidecar appends "Restart to apply." to the result line.
21. **Duplicate** — click *Duplicate*. A *"… copy"* entry appears, selected, with the same fields.
22. **Remove** — click *Remove*, confirm. The entry disappears; if it was running it is stopped first. Cancel leaves it untouched (inline message, no error popup).
23. **Env injection** — *Edit* a sidecar running `/bin/sh` with args `-c` / `env; sleep 600`, add `SMOKE_ENV=hello` under *Environment variables*, Save, Start. The log shows `SMOKE_ENV=hello` and `JOPLIN_SIDECAR_LAUNCHED_BY=joplin-sidecar-launcher`.
24. **Secret injection** — on the same sidecar add `MY_SECRET` under *Secret environment variables*, Save; the result line warns it is unset and Preflight lists it. Click *Secrets*, pick `MY_SECRET`, type a value, *Set*. Restart: the log shows `MY_SECRET=***` (masked), and the Sidecars JSON (*Edit JSON*) contains only the name. Use *Generate* on it: the clipboard holds a 43-character base64url value; *Generate* again asks before replacing. Quit Joplin and run the two `sqlite3` checks under [Environment variables](#environment-variables): one encrypted row in `key_values`, none in `settings`. *Clear* makes it unset again.
25. **Diagnostics redaction** — with one secret set and one unset, *Copy diag*. The report shows `SMOKE_ENV=hello`, `MY_SECRET=***set***`, the other as `***unset***`, and neither the secret value nor the Joplin token appears anywhere (including the log lines).
26. **Reserved-key rejection** — in the form, add `JOPLIN_TOKEN=x` under *Environment variables*: Save is refused with a message naming the key. Put `"env": {"JOPLIN_BASE_URL": "x"}` or `"secretEnv": ["PYTHONPATH"]` in via *Edit JSON*: *Start* is blocked with a dialog naming the key. Also try `"env": {"MCP_PORT": 5005}` (number) and `"env": {"1BAD": "x"}` — both are rejected.
27. **Secrets lifecycle** — *Duplicate* a sidecar with a secret set: the copy's result line reports its secrets unset, and the original's is still set. *Remove* the copy, then the original: re-adding a sidecar with the same name does not resurrect old values (secrets are keyed by id and deleted on removal).

---

## Extension points / roadmap

- ~~**Multi-sidecar support**~~ — done in 0.2.0.
- **Restart policy** — configurable auto-restart with exponential back-off and max-attempts.
- **Per-sidecar Joplin token** — currently the token is shared across all sidecars.
- ~~**Environment variable injection**~~ — done in 0.4.0 (`env` + keychain-backed `secretEnv`).
- **Persistent log file** — optional path to append stdout/stderr to a file on disk.
- **Joplin data directory token injection** — auto-inject the Joplin profile path as an env var so sidecars can locate the database.
- **Plugin API** — expose `start`/`stop`/`status` as inter-plugin commands so other plugins can gate on sidecar health.
- **HTTPS localhost** — accept self-signed certs for `https://127.0.0.1` health checks.

---

## Licence

MIT
