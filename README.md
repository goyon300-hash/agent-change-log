# agent-change-log

A local Python CLI and optional Pi extension for recording persistent changes.
The canonical store is append-only `events.jsonl`; its Markdown report is derived,
not a second source of truth.

## Features

- File create/modify/delete, moves, and generic system events.
- Validated JSON input, correlation IDs, actor/session metadata.
- Locked appends, restrictive permissions, symlink-resistant I/O.
- Deterministic Markdown reports and recent-event inspection.
- Recursive secret-key redaction, including `apiKey`, `token`, and `password`.
- Pi write/edit observation, including nested calls; shell text is never logged.

See [FEATURES.md](FEATURES.md) and [SECURITY.md](SECURITY.md) for scope and limits.

## Requirements

Linux/POSIX with Python 3.10+ (`fcntl`, `O_NOFOLLOW`, descriptor-relative I/O).
The optional TypeScript extension requires Pi; tested with
`@earendil-works/pi-coding-agent` 1.5.2 and Node 22+.
No Python dependencies, build step, install hooks, or runtime npm dependencies.

## Try the CLI safely

From this source directory, run only against disposable state:

```sh
scratch="$(mktemp -d)"
export AGENT_CHANGE_LOG_DIR="$scratch/logs"
./bin/agent-change-log file create "$scratch/example.txt" \
  --description "Recorded a synthetic example; target file is not created"
./bin/agent-change-log system --action config --resource example:application \
  --description "Recorded a synthetic configuration change"
./bin/agent-change-log recent --json
./bin/agent-change-log validate
./bin/agent-change-log report
# After inspecting the disposable directory:
rm -r -- "$scratch"
unset AGENT_CHANGE_LOG_DIR
```

The CLI **records metadata only**. It does not perform the described changes or
verify that they happened. Record verified effects, not intentions.

For CLI-only installation, place `bin/agent-change-log` on your PATH with
executable permission. Keep a dedicated private state directory. No service is
required. Do not replace an existing installation without reviewing the changes.

## Pi integration

Review this package before loading it: extensions run with your user permissions.
For a single invocation, from the package directory:

```sh
AGENT_CHANGE_LOG_DIR=/absolute/private/change-log \
  pi -e ./extensions/agent-change-log.ts
```

For ongoing integration, Pi supports `pi install /absolute/path/to/this-package`.
That command changes Pi settings; it is an **operator choice**, not a required
test step. The `pi.extensions` manifest exposes only the packaged extension.
Do not load both a loose copy and this package, or duplicate events may result.

The extension selects its executable in this order:

1. Explicit `AGENT_CHANGE_LOG_BIN` override (highest priority).
2. The sibling `../bin/agent-change-log`, when it is an executable file.
3. `~/.local/bin/agent-change-log`, for an existing loose extension installation.

Only trusted executables belong at these locations. An explicit override that
fails is reported as a failure; the extension never silently retries another CLI.
Keep the package layout intact and its CLI executable for package deployment.
CLI-only deployment and Pi package deployment are independent; package installation
does not place the CLI on your shell PATH.

To preserve an existing loose installation, an operator may replace just the
reviewed extension at `~/.pi/agent/extensions/agent-change-log.ts` and separately
deploy the CLI at `~/.local/bin/agent-change-log`. With no executable packaged
sibling, the extension uses that home-bin fallback. No `settings.json` changes
or additional package registration are necessary; do not load a second copy.

Successful `write`/`edit` calls record absolute paths and generic descriptions,
not contents or diffs. Pre-call existence distinguishes creates from overwrites.
Nested calls retain parent IDs. A successful tool result is the observation:
custom tool overrides, parallel writes, and symlinks can make classification
imperfect. No-op edits are not detected.

Recognized mutating `bash`/`powershell` commands produce generic invocation
events, **without command text, arguments, output, or a command hash**.
Detection is heuristic, not a shell/PowerShell parser. Invocation events never
prove filesystem effects. Failed commands can still have persistent effects:
record those manually. User `!` commands, remote tools, MCP writes, and external
programs are not automatically audited.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_CHANGE_LOG_DIR` | Dedicated log directory; default `~/.local/state/agent-change-log` |
| `AGENT_CHANGE_LOG_ACTOR` | Actor label override |
| `AGENT_CHANGE_LOG_BIN` | Extension-only trusted logger executable override |
| `AGENT_CHANGE_LOG_DISABLE=1` | Disable this extension |
| `PI_SESSION_ID` | CLI session correlation, if set |

The CLI also accepts `--log-dir`, `--actor`, `--session`, `--cwd`, `--tool`,
`--tool-call-id`, `--parent-tool-call-id`, `--origin`, `--quiet`, and
`--no-report` before or after a subcommand. Run `--help` for all commands.
Use `record-json` with JSON on stdin instead of `--json` for potentially
sensitive manual inputs; command-line arguments can appear in process listings.
Do not send secrets through either interface.

## Failure recovery

An event append and report replacement are not one transaction. A nonzero exit
may mean the event was durably appended but the report failed. Inspect
`recent --json` and validate the canonical log before retrying; if the event
exists, run `report` only. Truncated/corrupt logs are not silently repaired.
The Pi extension reports a generic failure without reflecting CLI diagnostics;
it neither retries nor blocks an already-completed tool.

## Tests (offline, no inference)

```sh
npm run test:cli
npm run test:extension
# Or both:
npm test
```

The extension suite uses an installed Pi SDK. If it is not resolvable as a peer,
set `PI_SDK_ENTRY=/absolute/path/to/pi-coding-agent/dist/index.js`.
Tests do not install dependencies, call models/network endpoints, send
notifications, start services, or execute the synthetic shell commands.
Only the real packaged CLI is spawned, using disposable `AGENT_CHANGE_LOG_DIR`.
SDK discovery, HOME, state, and caches are isolated; no live config is read.

See [examples/logging-policy.md](examples/logging-policy.md) for an optional,
generic agent policy. No global prompts or real runtime history are included.

## Publication status

This is a source-only staging package (`private: true` prevents accidental npm
publication). No license has been selected or added; the publication owner must
resolve licensing and release metadata before distribution.
