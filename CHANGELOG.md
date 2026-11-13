# Changelog

## [0.1.0]

### Packaged

- Standalone Python CLI under `bin/` and optional Pi extension under `extensions/`.
- Explicit Pi manifest and host peer dependency; no install hooks or bundled SDK.
- Safe examples, generic policy, documentation, offline CLI and SDK regression tests.

### Fixed

- Dictionary values under secret-bearing keys are removed regardless of value type.
- Quoted secret assignments and URL credentials are redacted.
- Redaction precedes description truncation; repeated normalization retains its marker.
- Shell observation never persists command text; logger-containing compound commands
  no longer bypass observation solely because they mention the logger.
- Logger failures do not echo potentially sensitive subprocess diagnostics.
- Directory traversal and event/lock access use no-follow pinned descriptors;
  unsafe file types, hard links, and ownership are rejected before chmod or writes.
- Report replacement never chmods a pathname after rename or follows target symlinks.
- Global CLI options before subcommands are preserved; negative recent counts and
  malformed historical resource/path types fail cleanly; non-finite metadata is rejected.
- Blocked/aborted write-call tracking is cleared at tool finalization.
- Executable selection preserves loose extension installations: explicit environment
  override, executable packaged sibling, then the home-local CLI fallback.
- Pi path normalization handles leading `@`, home expansion and Unicode spaces.
