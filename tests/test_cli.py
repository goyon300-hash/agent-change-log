"""Offline regression tests. Every CLI subprocess uses a disposable log directory."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "agent-change-log"
loader = importlib.machinery.SourceFileLoader("logger_under_test", str(CLI))
spec = importlib.util.spec_from_loader(loader.name, loader)
logger = importlib.util.module_from_spec(spec)
loader.exec_module(logger)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="change-log-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / "logs"
        self.env = {"PATH": os.defpath, "HOME": str(self.root),
                    "AGENT_CHANGE_LOG_DIR": str(self.log), "AGENT_CHANGE_LOG_ACTOR": "test"}

    def cli(self, *args, input=None, ok=True):
        result = subprocess.run([str(CLI), *map(str, args)], input=input, text=True,
                                capture_output=True, env=self.env, cwd=self.root, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Traceback", result.stderr)
        return result

    def events(self):
        return [json.loads(line) for line in (self.log / "events.jsonl").read_text().splitlines()]

    def record(self, **extra):
        return self.cli("record-json", input=json.dumps({
            "category": "system", "action": "test", "resource": "test:fixture",
            "description": "Synthetic event", **extra}))

    def test_create_modify_move_delete_report_and_permissions(self):
        a, b = self.root / "a.txt", self.root / "nested" / "b.txt"
        # These commands record metadata; they do not mutate the named target files.
        for action in ("create", "modify"):
            self.cli("file", action, a, "--description", "Synthetic file change")
        self.cli("move", a, b, "--description", "Synthetic rename")
        self.cli("file", "delete", b, "--description", "Synthetic removal")
        events = self.events()
        self.assertEqual([e["action"] for e in events], ["create", "modify", "move", "delete"])
        self.assertEqual(events[2]["paths"], [str(a), str(b)])
        self.assertFalse(a.exists())
        self.assertEqual(stat.S_IMODE(self.log.stat().st_mode), 0o700)
        for name in ("events.jsonl", "events.jsonl.lock", "CHANGELOG.md"):
            self.assertEqual(stat.S_IMODE((self.log / name).stat().st_mode), 0o600)
        first = (self.log / "CHANGELOG.md").read_bytes()
        self.cli("report")
        self.assertEqual(first, (self.log / "CHANGELOG.md").read_bytes())
        self.assertIn("Filesystem: 4", first.decode())
        self.cli("validate")
        self.assertEqual(len(self.cli("recent", "-n", "2", "--json").stdout.splitlines()), 2)
        self.assertEqual(len(self.cli("recent", "-n", "0", "--json").stdout.splitlines()), 4)
        self.cli("recent", "-n", "-1", ok=False)

    def test_keyed_values_redacted_for_strings_numbers_and_containers(self):
        self.record(meta={"apiKey": "fixture-api-value", "token": 123456789,
                          "password": "fixture password with spaces", "safe": "kept"})
        event = self.events()[0]
        self.assertTrue(event["redacted"])
        self.assertEqual(event["meta"], {"apiKey": "<redacted>", "token": "<redacted>",
                                         "password": "<redacted>", "safe": "kept"})
        for key in ("API_KEY", "api-key", "accessToken", "refresh_token", "credentials"):
            value, changed = logger.redact({"nested": [{key: {"data": "fixture-value"}}]})
            self.assertTrue(changed)
            self.assertEqual(value["nested"][0][key], "<redacted>")
        self.record(meta={"apiKey": {"nested": "fixture-nested-secret"}})
        self.assertNotIn("fixture-nested-secret", (self.log / "events.jsonl").read_text())

    def test_redaction_of_quoted_text_urls_and_long_pem_before_truncation(self):
        pem = "-----BEGIN PRIVATE KEY-----\n" + "x" * 5000 + "\n-----END PRIVATE KEY-----"
        description = 'apiKey="fixture secret with spaces"; {"password": "fixture spaced password"} '
        description += "--token 'fixture cli spaced value'; "
        description += "https://fixture-user:fixture-pass@example.invalid/ " + pem
        self.cli("system", "--resource", "test:secrets", "--description", description)
        text = (self.log / "events.jsonl").read_text()
        for value in ("fixture secret", "fixture spaced", "fixture cli", "spaced value", "fixture-user", "fixture-pass", "xxxxx"):
            self.assertNotIn(value, text)
        self.assertTrue(self.events()[0]["redacted"])
        event = logger.finalize_event(self.events()[0])
        self.assertTrue(event["redacted"], "re-finalizing must preserve the redaction marker")

    def test_global_options_before_subcommand_are_not_lost(self):
        result = self.cli("--actor", "global-actor", "--no-report", "--quiet", "system",
                          "--resource", "test:global", "--description", "Global options")
        self.assertEqual(result.stdout, "")
        self.assertEqual(self.events()[0]["actor"], "global-actor")
        self.assertFalse((self.log / "CHANGELOG.md").exists())
        other = self.root / "other-logs"
        self.cli("--log-dir", other, "report", "--quiet")
        self.assertTrue((other / "CHANGELOG.md").exists())

    def test_concurrent_appenders_do_not_lose_events(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda i: self.record(description=f"Synthetic event {i}"), range(12)))
        self.assertEqual(len(self.events()), 12)
        self.assertEqual(len({e["id"] for e in self.events()}), 12)
        self.assertIn("Events: 12.", (self.log / "CHANGELOG.md").read_text())
        self.cli("validate")

    def test_duplicate_ids_and_truncated_or_invalid_logs_fail_without_append(self):
        self.record(id="fixture-id")
        original = (self.log / "events.jsonl").read_bytes()
        result = self.cli("record-json", input=json.dumps(self.events()[0]), ok=False)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(original, (self.log / "events.jsonl").read_bytes())
        for broken in (original.rstrip(b"\n"), b"{broken json}\n", b"\n", b"\xff\n"):
            (self.log / "events.jsonl").write_bytes(broken)
            self.cli("system", "--resource", "test:broken", "--description", "Do not append", ok=False)
            self.assertEqual(broken, (self.log / "events.jsonl").read_bytes())

    def test_invalid_record_json_is_a_user_error(self):
        for data in ("[]", "null", "{", '{}', '{"meta": []}'):
            self.cli("record-json", input=data, ok=False)
        self.assertFalse((self.log / "events.jsonl").exists())

    def test_malformed_history_types_fail_cleanly_and_nonfinite_meta_is_rejected(self):
        self.record()
        original = self.events()[0]
        path = self.log / "events.jsonl"
        for field, bad in (("resource", 42), ("paths", ""), ("origin", None)):
            malformed = {**original, field: bad}
            path.write_text(json.dumps(malformed) + "\n")
            self.cli("validate", ok=False)
            self.cli("report", ok=False)
        path.write_text(json.dumps(original) + "\n")
        self.cli("record-json", input=json.dumps({
            "category": "system", "action": "test", "resource": "test:invalid",
            "description": "Synthetic invalid metadata", "meta": {"value": float("nan")},
        }), ok=False)
        self.assertEqual(len(self.events()), 1)

    def test_symlink_and_hardlink_events_or_lock_never_touch_victim(self):
        self.log.mkdir()
        victim = self.root / "victim"
        victim.write_text("fixture untouched\n")
        victim.chmod(0o640)
        for name in ("events.jsonl", "events.jsonl.lock"):
            target = self.log / name
            target.unlink(missing_ok=True)  # A prior report may have created its lock.
            for hardlink in (False, True):
                if hardlink:
                    os.link(victim, target)
                else:
                    target.symlink_to(victim)
                self.cli("report", ok=False)
                self.assertEqual(victim.read_text(), "fixture untouched\n")
                self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o640)
                target.unlink()

    def test_symlinked_log_directory_and_ancestor_are_rejected(self):
        victim = self.root / "victim-dir"
        victim.mkdir(mode=0o750)
        self.log.symlink_to(victim, target_is_directory=True)
        self.cli("report", ok=False)
        self.assertEqual(list(victim.iterdir()), [])
        self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o750)
        self.log.unlink()
        ancestor = self.root / "alias"
        ancestor.symlink_to(victim, target_is_directory=True)
        self.cli("report", "--log-dir", ancestor / "nested", ok=False)
        self.assertEqual(list(victim.iterdir()), [])

    def test_report_replaces_symlink_not_its_target(self):
        self.log.mkdir()
        victim = self.root / "victim"
        victim.write_text("fixture untouched")
        victim.chmod(0o640)
        (self.log / "CHANGELOG.md").symlink_to(victim)
        self.record()
        self.assertFalse((self.log / "CHANGELOG.md").is_symlink())
        self.assertEqual(victim.read_text(), "fixture untouched")
        self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o640)
        self.assertEqual(list(self.log.glob(".CHANGELOG.*.tmp")), [])

    def test_atomic_report_failure_keeps_previous_report_and_canonical_event(self):
        event = logger.make_event(category="system", action="test", resource="test:atomic",
                                  description="Synthetic atomic fixture")
        logger.append_event(self.log, event)
        before = (self.log / "CHANGELOG.md").read_bytes()
        next_event = logger.make_event(category="system", action="test", resource="test:atomic",
                                       description="Second synthetic atomic fixture")
        with patch.object(logger.os, "replace", side_effect=OSError("synthetic replace failure")):
            with self.assertRaises(logger.ChangeLogError):
                logger.append_event(self.log, next_event)
        self.assertEqual(len(self.events()), 2)
        self.assertEqual(before, (self.log / "CHANGELOG.md").read_bytes())
        self.assertEqual(list(self.log.glob(".CHANGELOG.*.tmp")), [])
        self.cli("report")
        self.assertIn("Events: 2.", (self.log / "CHANGELOG.md").read_text())

    def test_pinned_directory_survives_path_swapped_to_symlink(self):
        self.log.mkdir()
        moved = self.root / "pinned-log"
        victim = self.root / "victim-dir"
        victim.mkdir(mode=0o750)
        load = logger.load_events

        def swap_path(*args, **kwargs):
            self.log.rename(moved)
            self.log.symlink_to(victim, target_is_directory=True)
            return load(*args, **kwargs)

        event = logger.make_event(category="system", action="test", resource="test:pinned",
                                  description="Synthetic directory-swap fixture")
        with patch.object(logger, "load_events", side_effect=swap_path):
            logger.append_event(self.log, event)
        self.assertTrue((moved / "events.jsonl").exists())
        self.assertTrue((moved / "CHANGELOG.md").exists())
        self.assertEqual(list(victim.iterdir()), [])
        self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o750)

    def test_fifo_lock_is_rejected_without_hanging(self):
        self.log.mkdir()
        os.mkfifo(self.log / "events.jsonl.lock")
        self.cli("validate", ok=False)


if __name__ == "__main__":
    unittest.main()
