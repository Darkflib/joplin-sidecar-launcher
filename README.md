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

- **Launch** a configurable command with arguments and working directory when you click *Start* (or automatically on plugin load).
- **Monitor** the process: tracks state (`stopped`, `starting`, `running`, `healthy`, `unhealthy`, `stopping`, `crashed`), PID, start/exit times, and exit code.
- **Health polling**: optionally hits a localhost HTTP endpoint on a configurable interval and reflects the result in the panel.
- **Log capture**: captures stdout/stderr into a rolling in-memory buffer (configurable size) and displays the last 30 lines in the panel.
- **Stop/Restart**: sends SIGTERM gracefully; restart waits up to 3 s then SIGKILL if the process hasn't exited.
- **Diagnostics**: one-click clipboard dump of config, status, and recent log lines — useful for bug reports.
- **Status panel**: a side panel showing live state, PID, health, timestamps, and log output with Start/Stop/Restart/Copy-diag buttons.
- **Tools menu integration**: all commands also available under *Tools → Sidecar Launcher*.

---

## Installation

No marketplace listing yet. Install manually:

1. Download the `.jpl` file from the [Releases](https://github.com/darkflib/joplin-sidecar-launcher/releases) page (or build it yourself — see below).
2. In Joplin: *Tools → Options → Plugins → Install from file* → select the `.jpl`.
3. Restart Joplin.

---

## Configuration

Open *Tools → Options → Sidecar Launcher* and set:

| Setting | Description |
|---|---|
| Command | Executable to run. Can be a bare name (`python3`, `uv`) or an absolute path. |
| Arguments (JSON array) | Arguments as a JSON array, e.g. `["-m", "myapp.server"]`. |
| Working directory | Optional absolute path. Defaults to `$HOME`. |
| Health check URL | Optional `http://127.0.0.1:PORT/path` endpoint polled for liveness. |
| Autostart on plugin load | If enabled, the sidecar starts automatically when Joplin loads the plugin. |
| Stop sidecar when plugin unloads | If enabled, SIGTERM is sent to the child when Joplin closes or the plugin is disabled. |
| Health check interval (seconds) | How often to poll the health URL. Range: 1–300. |
| Max log lines retained | Rolling buffer size. Range: 10–1000. |

### Example: Python stdlib HTTP server (smoke test)

```
Command:    python3
Arguments:  ["-m", "http.server", "8765", "--bind", "127.0.0.1"]
Health URL: http://127.0.0.1:8765/
```

Starts a static file server in `$HOME`. The health URL returns 200 (it's just an index listing), so state will flip to `healthy` after the first poll.

### Example: uv-managed FastAPI sidecar

```
Command:    uv
Arguments:  ["run", "--project", "/Users/you/pkm-sidecar", "python", "-m", "pkm_sidecar.main"]
CWD:        /Users/you/pkm-sidecar
Health URL: http://127.0.0.1:8766/health
```

`uv run` resolves the project's own virtual environment, so the VIRTUAL_ENV stripping is largely moot here — but it avoids Joplin's own environment leaking into the resolved interpreter.

### Example: Node.js sidecar

```
Command:    node
Arguments:  ["/Users/you/my-sidecar/dist/server.js", "--port", "9000"]
Health URL: http://127.0.0.1:9000/health
```

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

- **Single sidecar only.** One command per plugin instance. If you need multiple sidecars, you'll need multiple plugin instances (not currently possible) or a supervisor script.
- **No restart policy.** Crashed processes stay in `crashed` state until you manually click Restart or Start. Automatic retry with back-off is a planned extension.
- **No stdin.** The child's stdin is closed (`'ignore'`). Interactive processes won't work.
- **SIGTERM only.** The stop button sends SIGTERM. If your process ignores SIGTERM, you'll need to kill it manually. (SIGKILL is only sent during restart if SIGTERM hasn't worked within 3 s.)
- **HTTP health checks only.** HTTPS localhost endpoints are not supported (self-signed cert handling adds complexity for marginal benefit here).
- **Log buffer is in-memory only.** Logs are lost when Joplin restarts. Persistent log files are a planned extension.
- **No environment variable injection UI.** You can't set custom env vars from the settings panel. Work around with a wrapper script.
- **macOS/Linux only tested.** Should work on Windows but SIGTERM semantics differ; consider using a wrapper script that handles graceful shutdown.

---

## Manual test checklist

Work through this after each significant change:

1. **Happy path** — set command to `python3`, args to `["-m", "http.server", "8765", "--bind", "127.0.0.1"]`, health URL to `http://127.0.0.1:8765/`. Click Start. State goes `starting → running → healthy`. PID is populated. Log panel shows server startup lines.
2. **Stop** — click Stop. State goes `stopping → stopped`. PID clears. Exit code is 0 or -1 (killed).
3. **Restart** — start the server, then click Restart. Old PID disappears, new PID appears. Panel refreshes.
4. **Crash detection** — start `python3 -c "import time; time.sleep(2)"`. Wait 3 s. State should flip to `crashed`. Log shows unexpected exit message.
5. **Bad command** — set command to `/nonexistent/binary`. Click Start. State goes `crashed`. Error appears in log.
6. **Bad args JSON** — set args to `not-json`. Attempt Start. Settings validation error dialog appears, no process launched.
7. **Remote health URL rejected** — set health URL to `https://example.com`. Save. Attempt Start. Validation error shown.
8. **Autostart** — enable Autostart, reload the plugin (disable/enable). Sidecar starts without clicking Start.
9. **Stop on unload** — start the sidecar, disable the plugin from Plugin settings. Verify no zombie `python3` process remains (`pgrep -a python3`).
10. **Diagnostics** — click *Copy diag*. Paste into a text editor. Verify all fields are populated correctly.
11. **Panel toggle** — use *Tools → Sidecar Launcher → Show/Hide Status Panel* or the panel button. Panel hides and shows correctly.
12. **Max log lines** — set max log lines to 10. Generate >10 lines of output. Verify only 10 lines are retained (check via diagnostics).

---

## Extension points / roadmap

- **Multi-sidecar support** — array of sidecar configs, each with its own lifecycle.
- **Restart policy** — configurable auto-restart with exponential back-off and max-attempts.
- **Environment variable injection** — key/value pairs in settings, merged into the child environment.
- **Persistent log file** — optional path to append stdout/stderr to a file on disk.
- **Joplin data directory token injection** — auto-inject the Joplin profile path as an env var so sidecars can locate the database.
- **Plugin API** — expose `start`/`stop`/`status` as inter-plugin commands so other plugins can gate on sidecar health.
- **HTTPS localhost** — accept self-signed certs for `https://127.0.0.1` health checks.

---

## Licence

MIT
