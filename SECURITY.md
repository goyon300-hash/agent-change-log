# Security and confidentiality

Use a dedicated local directory, not a shared project or a broad existing folder.
The selected directory's mode is enforced as 0700; event/lock/report files are 0600.
These are local POSIX permissions, not encryption. Do not put state on an
untrusted/network filesystem: locking and durability depend on filesystem support.

Directory components are walked using `O_DIRECTORY | O_NOFOLLOW`. Symlinked
ancestors or log directories are rejected (choose their real path).
Event and lock files must be regular, current-user-owned, and single-link;
descriptors are checked before permission changes. Reads, appends, locks, and
report replacement use a pinned directory descriptor. Report symlinks/hardlinks
are replaced rather than opened or chmodded. Intermediate existing directories
are not chmodded. File permissions are enforced even on inspection commands.

Protection is against accidental disclosure and unsafe link traversal, not an
attacker with the same UID, root, an untrusted extension, or a compromised process.
Concurrent cooperating writers are serialized. Arbitrary disk errors can leave a
partial append, which later validation rejects. The canonical log is not
cryptographically signed or immutable. There is no automatic rotation/retention;
validation and report generation read the entire log.

Redaction is defense in depth. Recognized secret dictionary keys are matched
case-insensitively after removing separators; their complete values are replaced,
including nested objects and numbers. Other strings use known token, private key,
assignment, CLI-flag, and URL-userinfo patterns. It cannot recognize every secret,
encoding, token format, arbitrary prose, environment expansion or binary payload.
Never provide secrets in descriptions, paths, actors, metadata keys, resources or
identifiers. Re-finalization does not sanitize historical events already on disk:
the normal CLI validates history rather than rewriting it.

The Pi observer logs no file contents/diffs or shell command text/output/hash.
It does retain local absolute paths, cwd, host, actor, timestamps and session/tool
IDs: these can be identifying. The extension passes its minimized event JSON to
the CLI as argv, so local process inspection can see that metadata. Shell matching
is heuristic and can miss commands or classify read-only commands as mutating.
A tool error is not proof that no change occurred; manually record partial effects.

Only load trusted extensions and set `AGENT_CHANGE_LOG_BIN` to a trusted executable.
The extension does not parse project policy files or inject instructions. Suggested
agent policy is documentation only. Inspect canonical events before retrying a
failed operation to avoid duplicate records. Never publish `events.jsonl`, the
runtime `CHANGELOG.md`, credentials, or session state. The repository's
`CHANGELOG.md` is a release history, not a runtime report.
