# joplin-sidecar-launcher

A Joplin desktop plugin that launches, monitors, and stops local sidecar processes from within Joplin. The primary use case is keeping a Python-based PKM sidecar service alive alongside Joplin — think a FastAPI embedding server, a local RAG pipeline, a note-sync daemon, or any other `localhost`-bound helper process.

---

## ⚠️ Security Warning

**This plugin executes arbitrary shell commands as the user running Joplin.** The command, arguments, and working directory are taken directly from Joplin's settings. Anyone with write access to your Joplin settings profile can modify these values.

- **Never** set the command to a network-writable path.
- **Never** install this plugin on a shared Joplin instance.
- The health check URL is restricted to `localhost` (`127.0.0.1`, `::1`, `localhost`) and HTTP only. Remote URLs will be rejected.
- The plugin strips a short list of Python environment variables (`PYTHONHOME`, `PYTHONPATH`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, `CONDA_PREFIX`) to prevent the host Python environment from leaking into child interpreters. This is a best-effort measure, not a sandbox.

---

## What it does

- **Manage multiple sidecars.** Define any number of sidecars as a JSON array; each has its own command, health check, dashboard URL, and lifecycle. The status panel has a dropdown to switch between them.
- **Launch** a configurable command with arguments and working directory when you click *Start* (or automatically on plugin load, per sidecar).
- **Monitor** each process: tracks state (`stopped`, `starting`, `running`, `healthy`, `unhealthy`, `stopping`, `crashed`), PID, start/exit times, and exit code.
- **Health polling**: optionally hits a localhost HTTP endpoint on a configurable interval and reflects the result in the panel.
- **Open dashboard**: opens the selected sidecar's configured `dashboardUrl` in your default browser via the OS handler.
- **Log capture**: captures stdout/stderr into a rolling in-memory buffer (configurable size). The log area is collapsed by default and grows to fill the panel when expanded.
- **Stop/Restart**: sends SIGTERM to the whole process group gracefully; restart waits up to 3 s then SIGKILL if the process hasn't exited.
- **Stale-port reclaim**: before starting, checks whether the sidecar's port (from its `healthUrl`/`dashboardUrl`) is already bound. If a leftover process from a previous session holds it, you're offered a one-click *stop it and continue* — no more manual `lsof … kill`.
- **Inline results, not alert spam**: button actions report their outcome on a line beneath the buttons. Benign no-ops (e.g. *Stop* when already stopped) just show a message — no popup. Popups remain only where the action is blocked and needs guidance (failed preflight before *Start*) or is an explicit flow (preflight report, Joplin auth, the JSON editor).
- **Diagnostics**: one-click clipboard dump of the selected sidecar's config, status, and recent log lines — useful for bug reports.
- **Status panel**: a side panel showing live state, PID, health, timestamps, and log output with Start/Stop/Restart/Open-dashboard/Edit/Copy-diag buttons.
- **Tools menu integration**: all commands also available under *Tools → Sidecar Launcher* (they act on the sidecar currently selected in the panel).

---

## Installation

No marketplace listing yet. Install manually:

1. Download the `.jpl` file from the [Releases](https://github.com/darkflib/joplin-sidecar-launcher/releases) page (or build it yourself — see below).
2. In Joplin: *Tools → Options → Plugins → Install from file* → select the `.jpl`.
3. Restart Joplin.

---

## Configuration

Sidecars are defined as a **JSON array**. The easiest way to edit it is the panel
button *Edit sidecars* (or *Tools → Sidecar Launcher → Edit Sidecars (JSON)*),
which opens a multi-line editor. The raw value also lives in
*Tools → Options → Sidecar Launcher → Sidecars (JSON array)*.

Each object in the array:

| Field | Required | Description |
|---|---|---|
| `name` | recommended | Label shown in the panel selector. Defaults to `Sidecar N`. |
| `command` | yes | Executable to run. **Use an absolute path** (e.g. `/opt/homebrew/bin/uv`) — Joplin launched from the Dock/Finder does not inherit your shell PATH. |
| `args` | no | Arguments as a JSON array, e.g. `["-m", "http.server", "8765"]`. Defaults to `[]`. |
| `cwd` | no | Absolute path. Defaults to `$HOME`. |
| `healthUrl` | no | `http://127.0.0.1:PORT/path` endpoint polled for liveness. Localhost + HTTP only. |
| `dashboardUrl` | no | URL opened by the *Open dashboard* button via your OS handler. |
| `autostart` | no | Start this sidecar automatically on plugin load. Defaults to `false`. |
| `stopOnUnload` | no | SIGTERM this sidecar when Joplin quits. Defaults to `true`. |
| `healthIntervalSeconds` | no | Health poll interval, 1–300. Defaults to `5`. |
| `maxLogLines` | no | Rolling log buffer size, 10–1000. Defaults to `100`. |

The **Joplin API base URL and token are configured separately** (the table below
the JSON, and the *Authorise Joplin API token* command) and are shared across
**all** sidecars — injected into each as `JOPLIN_BASE_URL` / `JOPLIN_TOKEN`. The
token is kept out of the Sidecars JSON on purpose, so it is never written to disk
in plaintext (it lives in the OS keychain).

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
0.2.0 loads — you'll see a one-element array named `Sidecar`. The legacy fields
remain in the settings UI (relabelled *legacy*) but are no longer read; you can
ignore or clear them.

---

## Build from source

Prerequisites: Node.js ≥ 18, npm ≥ 9.

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
- **No environment variable injection UI.** You can't set custom env vars from the settings panel. Work around with a wrapper script.
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
7. **Per-sidecar dashboard** — set `dashboardUrl` to `http://127.0.0.1:8765/`. Click *Open dashboard*. Browser opens that URL. With no `dashboardUrl`, the result line warns instead of opening.
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

---

## Extension points / roadmap

- ~~**Multi-sidecar support**~~ — done in 0.2.0.
- **Restart policy** — configurable auto-restart with exponential back-off and max-attempts.
- **Per-sidecar Joplin token** — currently the token is shared across all sidecars.
- **Environment variable injection** — key/value pairs in settings, merged into the child environment.
- **Persistent log file** — optional path to append stdout/stderr to a file on disk.
- **Joplin data directory token injection** — auto-inject the Joplin profile path as an env var so sidecars can locate the database.
- **Plugin API** — expose `start`/`stop`/`status` as inter-plugin commands so other plugins can gate on sidecar health.
- **HTTPS localhost** — accept self-signed certs for `https://127.0.0.1` health checks.

---

## Licence

MIT
