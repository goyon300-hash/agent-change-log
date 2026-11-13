// Load the real TypeScript extension through the installed Pi SDK, without a
// session/provider/model runtime. Dispatch synthetic tool events, never shells.
import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = await mkdtemp(join(tmpdir(), "change-log-sdk-test-"));
// Keep loader caches, state and discovery out of the live installation.
process.env.HOME = sandbox;
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.JITI_FS_CACHE = "false";
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
delete process.env.PI_SESSION_ID;
delete process.env.AGENT_CHANGE_LOG_ACTOR;
delete process.env.AGENT_CHANGE_LOG_BIN;
delete process.env.AGENT_CHANGE_LOG_DISABLE;
globalThis.fetch = () => { throw new Error("Network is forbidden in these tests"); };
const sdkUrl = process.env.PI_SDK_ENTRY
    ? pathToFileURL(resolve(process.env.PI_SDK_ENTRY)).href
    : "@earendil-works/pi-coding-agent";

try {
    const sdk = await import(sdkUrl);
    const fixture = async (name, { disabled = false, broken = false,
        extensionPath = join(root, "extensions", "agent-change-log.ts") } = {}) => {
        const cwd = join(sandbox, name);
        await mkdir(cwd, { recursive: true });
        const logDir = join(cwd, "logs");
        process.env.AGENT_CHANGE_LOG_DIR = logDir;
        process.env.AGENT_CHANGE_LOG_DISABLE = disabled ? "1" : "0";
        if (broken) {
            // A broken log symlink makes the actual CLI fail. Its path must not
            // be echoed by the extension into Pi diagnostic output.
            await mkdir(logDir);
            await symlink(join(cwd, "fixture-sensitive-diagnostic"), join(logDir, "events.jsonl.lock"));
        }
        const loaded = await sdk.discoverAndLoadExtensions(
            [extensionPath], cwd, join(cwd, "empty-agent"));
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, cwd,
            sdk.SessionManager.inMemory(cwd), {});
        const errors = [];
        runner.onError(error => errors.push(error));
        await runner.emit({ type: "session_start", reason: "startup" });
        let counter = 0;
        const call = (toolName, input, extra = {}) => ({
            type: "tool_call", toolName, input, toolCallId: `${name}-${++counter}`, ...extra,
        });
        const result = async (event, extra = {}) => {
            await runner.emitToolResult({ ...event, type: "tool_result", content: [], details: {},
                                          isError: false, ...extra });
            assert.deepEqual(errors, []);
        };
        const events = async () => (await readFile(join(logDir, "events.jsonl"), "utf8"))
            .trim().split("\n").map(line => JSON.parse(line));
        return { cwd, logDir, runner, call, result, events };
    };

    await test("SDK load: create, overwrite, edit and nested parent metadata; no file contents", async () => {
        const f = await fixture("files");
        const path = join(f.cwd, "fixture.txt");
        const first = f.call("write", { path: "@fixture.txt", content: "fixture-content-never-log" },
                             { parentToolCallId: "outer-call" });
        await f.runner.emitToolCall(first);
        await writeFile(path, "fixture-content-never-log");
        await f.result(first);
        const second = f.call("write", { path: "fixture.txt", content: "replacement-never-log" });
        await f.runner.emitToolCall(second);
        await writeFile(path, "replacement-never-log");
        await f.result(second);
        await f.result(f.call("edit", { path: "fixture.txt", edits: [
            { oldText: "replacement-never-log", newText: "changed-never-log" },
        ] }));
        const events = await f.events();
        assert.deepEqual(events.map(e => e.action), ["create", "modify", "modify"]);
        assert.equal(events[0].parent_tool_call_id, "outer-call");
        assert.equal(events[0].actor, "pi-agent/nested");
        assert.equal(events[0].paths[0], path);
        assert.equal(events[0].tool_call_id, first.toolCallId);
        assert.ok(events[0].session);
        assert.ok(!JSON.stringify(events).includes("never-log"));
    });

    await test("SDK load: shell confidentiality for quoted values, arbitrary data and logger compounds", async () => {
        const f = await fixture("shell");
        // These strings are NEVER executed. Only the packaged logger is invoked.
        const commands = [
            "touch file; echo 'fixture-private-opaque-value'",
            "mkdir directory; export PASSWORD='fixture quoted secret'",
            "cp input output; printf '%s' '{\"apiKey\":\"fixture-dictionary-secret\"}'",
            "agent-change-log report; rm fixture-victim",
        ];
        for (const command of commands) await f.result(f.call("bash", { command }));
        await f.result(f.call("powershell", { command: "mkdir fixture-private-directory" }));
        const events = await f.events();
        assert.equal(events.length, 5);
        for (const event of events) {
            assert.equal(event.action, "command");
            assert.equal(event.meta.effects_inferred, false);
            assert.ok(event.description.includes("command text omitted"));
        }
        const persisted = await readFile(join(f.logDir, "events.jsonl"), "utf8")
            + await readFile(join(f.logDir, "CHANGELOG.md"), "utf8");
        assert.ok(!persisted.includes("fixture-private"));
        assert.ok(!persisted.includes("fixture quoted"));
        assert.ok(!persisted.includes("fixture-dictionary"));
        assert.ok(!persisted.includes("fixture-victim"));
    });

    await test("SDK load: failed tools, reads, internal paths and read-only commands are ignored", async () => {
        const f = await fixture("ignored");
        const failed = f.call("write", { path: "failed.txt" });
        await f.runner.emitToolCall(failed);
        await f.result(failed, { isError: true });
        await f.result(f.call("read", { path: "file.txt" }));
        await f.result(f.call("bash", { command: "ls -la" }));
        const internal = f.call("write", { path: join(f.logDir, "CHANGELOG.md") });
        await f.runner.emitToolCall(internal);
        await f.result(internal);
        await f.result(f.call("edit", { path: join(f.logDir, "events.jsonl") }));
        await assert.rejects(readFile(join(f.logDir, "events.jsonl")), { code: "ENOENT" });
    });

    await test("SDK load: logging failures never echo CLI diagnostics or notify outside a UI", async () => {
        const f = await fixture("failure", { broken: true });
        const output = [];
        const previous = console.error;
        console.error = (...args) => output.push(args.join(" "));
        try {
            await f.result(f.call("edit", { path: "fixture.txt" }));
        } finally {
            console.error = previous;
        }
        assert.equal(output.length, 1);
        assert.ok(output[0].includes("check the canonical log before retrying"));
        assert.ok(!output[0].includes("fixture-sensitive-diagnostic"));
        assert.ok(!output[0].includes(f.cwd));
    });

    await test("SDK load: finalized blocked writes do not retain stale existence state", async () => {
        const f = await fixture("blocked");
        const event = f.call("write", { path: "fixture.txt" });
        await f.runner.emitToolCall(event);
        await f.runner.emit({ type: "tool_execution_end", toolName: "write",
            toolCallId: event.toolCallId, result: { content: [], details: {} }, isError: true });
        await writeFile(join(f.cwd, "fixture.txt"), "fixture");
        // Deliberately reuse the ID without preflight to exercise stale-state cleanup.
        await f.result(event);
        assert.equal((await f.events())[0].action, "modify");
    });

    await test("SDK loose copy: absent sibling CLI falls back to executable in disposable HOME", async () => {
        const extensionPath = join(sandbox, ".pi", "agent", "extensions", "agent-change-log.ts");
        const fallback = join(sandbox, ".local", "bin", "agent-change-log");
        await mkdir(dirname(extensionPath), { recursive: true });
        await mkdir(dirname(fallback), { recursive: true });
        await copyFile(join(root, "extensions", "agent-change-log.ts"), extensionPath);
        await copyFile(join(root, "bin", "agent-change-log"), fallback);
        await chmod(fallback, 0o755);
        const f = await fixture("loose", { extensionPath });
        await f.result(f.call("edit", { path: "fixture.txt" }));
        assert.equal((await f.events())[0].action, "modify");
        assert.equal((await f.events())[0].origin, "pi-extension");
    });

    await test("SDK loose copy: nonexecutable sibling also falls back; packaged sibling takes priority", async () => {
        const extensionPath = join(sandbox, ".pi", "agent", "extensions", "agent-change-log.ts");
        const sibling = join(sandbox, ".pi", "agent", "bin", "agent-change-log");
        const fallback = join(sandbox, ".local", "bin", "agent-change-log");
        await mkdir(dirname(sibling), { recursive: true });
        await writeFile(sibling, "Nonexecutable synthetic fixture", { mode: 0o600 });
        const loose = await fixture("loose-nonexecutable", { extensionPath });
        await loose.result(loose.call("edit", { path: "fixture.txt" }));
        assert.equal((await loose.events())[0].action, "modify");
        // Make the fallback unusable: a package load must still use its sibling CLI.
        await chmod(fallback, 0o600);
        const packaged = await fixture("packaged-precedence");
        await packaged.result(packaged.call("edit", { path: "fixture.txt" }));
        assert.equal((await packaged.events())[0].action, "modify");
    });

    await test("SDK executable override: explicit selection wins and failure never silently falls back", async () => {
        process.env.AGENT_CHANGE_LOG_BIN = join(sandbox, "explicitly-missing-logger");
        let f;
        try {
            f = await fixture("override-precedence");
        } finally {
            delete process.env.AGENT_CHANGE_LOG_BIN;
        }
        const output = [];
        const previous = console.error;
        console.error = (...args) => output.push(args.join(" "));
        try {
            await f.result(f.call("edit", { path: "fixture.txt" }));
        } finally {
            console.error = previous;
        }
        assert.equal(output.length, 1);
        await assert.rejects(readFile(join(f.logDir, "events.jsonl")), { code: "ENOENT" });
    });

    await test("SDK load: disable flag registers no handlers or side effects", async () => {
        const f = await fixture("disabled", { disabled: true });
        assert.equal(f.runner.hasHandlers("tool_result"), false);
        await f.result(f.call("edit", { path: "fixture.txt" }));
        await assert.rejects(readFile(join(f.logDir, "events.jsonl")), { code: "ENOENT" });
    });
} finally {
    await rm(sandbox, { recursive: true, force: true });
}
