/**
 * Persistent change logging for Pi.
 *
 * Reliably records successful write/edit tool operations (and nested calls made
 * through codemode) in the canonical agent-change-log. Successful shell commands
 * that look mutating are recorded as system "command" events with an explicit
 * note that their filesystem effects are not inferred. Agents must still record
 * file changes made by shell commands with `agent-change-log file|move`.
 *
 * Raw shell commands, tool contents, outputs and logger diagnostics are never
 * retained. The logger ignores its own log directory. pi.exec does not emit tool
 * events, so invoking the logger here cannot recursively log itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LOG_DIR = join(homedir(), ".local", "state", "agent-change-log");
const PACKAGED_BIN = fileURLToPath(new URL("../bin/agent-change-log", import.meta.url));

function defaultLogBin(): string {
    try {
        accessSync(PACKAGED_BIN, constants.X_OK);
        if (statSync(PACKAGED_BIN).isFile()) return PACKAGED_BIN;
    } catch {
        // A loose extension installation has no sibling package CLI.
    }
    return join(homedir(), ".local", "bin", "agent-change-log");
}

const MUTATING_COMMAND = new RegExp(
    [
        String.raw`(?:^|\s)(?:sudo\s+)?(?:rm|rmdir|mv|cp|install|touch|mkdir|truncate|dd|tee|chmod|chown|chgrp|ln|unlink|patch)(?:\s|$)`,
        String.raw`(?:^|\s)(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)`,
        String.raw`(?:^|\s)git\s+(?:add|am|apply|checkout|clean|commit|merge|mv|pull|rebase|reset|restore|rm|stash|switch)(?:\s|$)`,
        String.raw`(?:^|\s)(?:apt|apt-get|dpkg|snap|pip|pip3|uv|npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|upgrade|update|sync|run|exec|x)(?:\s|$)`,
        String.raw`(?:^|\s)(?:systemctl|service|useradd|usermod|groupadd|passwd|visudo|crontab|mount|umount|sysctl|modprobe|docker|podman|kubectl|terraform|ansible)(?:\s|$)`,
        String.raw`(?:^|\s)(?:curl|wget)\s+[^\n]*\s(?:-o|-O|--output)(?:\s|$)`,
        String.raw`(?:^|\s)(?:python[0-9.]*|bash|sh|zsh|node|ruby|perl)\s+\S+\.(?:py|sh|zsh|js|mjs|ts|rb|pl)(?:\s|$)`,
        String.raw`(?:^|\s)\d?>>?(?:\s|$)`,
    ].join("|"),
);

type JsonObject = Record<string, unknown>;

function stringField(input: JsonObject, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" ? value : undefined;
}

function absolutePath(cwd: string, rawPath: string): string {
    const path = rawPath.replace(/^@/, "").replace(/[\u00a0\u202f]/g, " ");
    return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function isInternalPath(cwd: string, rawPath: string, logDir: string): boolean {
    const absolute = absolutePath(cwd, rawPath);
    return absolute === logDir || absolute.startsWith(logDir + sep);
}

function actorFor(payload: JsonObject): string {
    if (process.env.AGENT_CHANGE_LOG_ACTOR) return process.env.AGENT_CHANGE_LOG_ACTOR;
    return payload.parent_tool_call_id || payload.parentToolCallId
        ? "pi-agent/nested"
        : "pi-agent";
}

async function record(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    payload: JsonObject,
    logBin: string,
): Promise<void> {
    const session = ctx.sessionManager.getSessionId();
    const event: JsonObject = {
        schema: "agent-change-log/1",
        actor: actorFor(payload),
        origin: "pi-extension",
        cwd: ctx.cwd,
        ...(session ? { session } : {}),
        ...payload,
    };

    const result = await pi.exec(
        logBin,
        ["record-json", "--json", JSON.stringify(event), "--quiet"],
        { cwd: ctx.cwd, timeout: 10_000 },
    );
    if (result.code !== 0) {
        // CLI output can include sensitive input; never echo it into Pi logs/UI.
        throw new Error("logger failed");
    }
}

export default function (pi: ExtensionAPI) {
    if (process.env.AGENT_CHANGE_LOG_DISABLE === "1") return;
    const logDir = absolutePath(process.cwd(), process.env.AGENT_CHANGE_LOG_DIR ?? DEFAULT_LOG_DIR);
    const logBin = process.env.AGENT_CHANGE_LOG_BIN ?? defaultLogBin();
    const recordEvent = (ctx: ExtensionContext, payload: JsonObject) => record(pi, ctx, payload, logBin);

    const writeExisted = new Map<string, boolean>();
    let failureNotified = false;

    const reportFailure = (ctx: ExtensionContext) => {
        const message = "Logger failed; check the canonical log before retrying, then run report if needed.";
        console.error(`[agent-change-log] ${message}`);
        if (!failureNotified && ctx.hasUI) {
            failureNotified = true;
            ctx.ui.notify(`Persistent change logging failed: ${message}`, "error");
        }
    };

    pi.on("session_start", () => {
        failureNotified = false;
        writeExisted.clear();
    });

    pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== "write") return;
        const path = stringField(event.input, "path");
        if (!path || isInternalPath(ctx.cwd, path, logDir)) return;
        writeExisted.set(event.toolCallId, existsSync(absolutePath(ctx.cwd, path)));
    });

    // Blocked/aborted calls can skip tool_result but always finalize here.
    pi.on("tool_execution_end", (event) => {
        writeExisted.delete(event.toolCallId);
    });

    pi.on("tool_result", async (event, ctx) => {
        if (event.isError) {
            writeExisted.delete(event.toolCallId);
            return;
        }

        try {
            if (event.toolName === "write") {
                const rawPath = stringField(event.input, "path");
                if (!rawPath) {
                    writeExisted.delete(event.toolCallId);
                    return;
                }
                if (isInternalPath(ctx.cwd, rawPath, logDir)) {
                    writeExisted.delete(event.toolCallId);
                    return;
                }
                const targetPath = absolutePath(ctx.cwd, rawPath);
                const existed = writeExisted.get(event.toolCallId) ?? existsSync(targetPath);
                writeExisted.delete(event.toolCallId);
                await recordEvent(ctx, {
                    category: "filesystem",
                    action: existed ? "modify" : "create",
                    description: existed
                        ? "Modified file with the write tool"
                        : "Created file with the write tool",
                    paths: [targetPath],
                    tool: "write",
                    tool_call_id: event.toolCallId,
                    ...(event.parentToolCallId
                        ? { parent_tool_call_id: event.parentToolCallId }
                        : {}),
                });
                return;
            }

            if (event.toolName === "edit") {
                const rawPath = stringField(event.input, "path");
                if (!rawPath) return;
                if (isInternalPath(ctx.cwd, rawPath, logDir)) return;
                const edits = event.input.edits;
                const count = Array.isArray(edits) ? edits.length : 0;
                await recordEvent(ctx, {
                    category: "filesystem",
                    action: "modify",
                    description:
                        count > 0
                            ? `Edited file with the edit tool (${count} replacement${count === 1 ? "" : "s"})`
                            : "Edited file with the edit tool",
                    paths: [absolutePath(ctx.cwd, rawPath)],
                    tool: "edit",
                    tool_call_id: event.toolCallId,
                    ...(event.parentToolCallId
                        ? { parent_tool_call_id: event.parentToolCallId }
                        : {}),
                });
                return;
            }

            if (event.toolName === "bash" || event.toolName === "powershell") {
                const command = stringField(event.input, "command");
                if (!command) return;
                if (!MUTATING_COMMAND.test(command)) return;
                await recordEvent(ctx, {
                    category: "system",
                    action: "command",
                    resource: `shell:${event.toolName}`,
                    description: "Shell command completed; command text omitted for confidentiality; filesystem effects not inferred",
                    tool: event.toolName,
                    tool_call_id: event.toolCallId,
                    ...(event.parentToolCallId
                        ? { parent_tool_call_id: event.parentToolCallId }
                        : {}),
                    meta: {
                        shell: event.toolName,
                        effects_inferred: false,
                    },
                });
            }
        } catch {
            reportFailure(ctx);
        }
    });
}
