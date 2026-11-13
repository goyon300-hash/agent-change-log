# Example agent logging policy

Adapt this policy deliberately; it is not automatically loaded or injected.

- Record verified persistent changes with absolute paths and brief English
  descriptions. Include partial effects of failed operations.
- For local Pi write/edit tools, rely on the installed observer. If logging fails,
  inspect canonical events before adding a manual entry.
- A shell invocation event is not an effects record. Separately record the verified
  filesystem/system effects of shell commands, scripts, remote tools and MCP tools.
- Skip read-only operations, no-ops, disposable scratch files and logger-owned files.
- Never log credentials, tokens, secrets, raw commands, file contents, or output.
- Use the target host's logger for remote changes, if explicitly authorized.
- Use `agent-change-log report` to rebuild the derived report. Do not hand-edit it.
- If recovery is unresolved, report what changed and what logging remains missing.

Examples (metadata only; these commands do not perform the described changes):

```sh
agent-change-log file modify /absolute/project/config.example.json \
  --description "Updated documented example defaults"
agent-change-log move /absolute/project/old-name.txt /absolute/project/new-name.txt \
  --description "Renamed example document"
agent-change-log system --action config --resource example:application \
  --path /absolute/project/config.example.json \
  --description "Updated example application configuration"
```
