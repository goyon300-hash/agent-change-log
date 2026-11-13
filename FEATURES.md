# Feature list

## CLI

- Schema `agent-change-log/1`, generated IDs and timezone-aware timestamps.
- File create, modify, delete; move source/destination with both paths indexed.
- Generic system actions/resources, optional associated file paths.
- Strict event fields, bounded descriptions, scalar metadata, normalized paths.
- JSON ingestion through stdin, file, or argument; recent events as text/JSON.
- Duplicate-ID and malformed-log rejection, trailing-newline append guard.
- Cooperative POSIX file locks; fsync of appends and report replacements.
- User-owned, single-link regular event/lock files; no symlink traversal.
- State directory 0700; log, lock, and report files 0600.
- Atomic report replacement using private temporary files and pinned directory I/O.
- Directory-grouped Markdown, system resource grouping, stable ordering.

## Pi extension

- Built-in write/edit result observation, nested correlation and create/overwrite labels.
- Generic mutating-shell invocation events without storing shell text or output.
- Internal log path exclusions and environment-controlled disable/executable/state.
- Content-free failure reporting; no background resources or prompt injection.

## Deliberate limits

This is a local change journal, not a tamper-proof audit service, backup, filesystem
watcher, effect verifier, exhaustive shell analyzer, or guaranteed secret scanner.
Events include local host/path/session metadata. Never publish real runtime logs.
