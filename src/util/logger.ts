import * as vscode from "vscode";

/**
 * Tiny wrapper around a single VS Code OutputChannel named "Sweet Shelf".
 *
 * The channel is created in `extension.activate` and shared across the
 * codebase via this module so callers don't have to thread it through
 * every constructor. Calling any logging function before `initLogger`
 * silently no-ops, which keeps tests happy and avoids crashes if a
 * background promise fires after deactivate.
 */

let channel: vscode.OutputChannel | undefined;

/** Wire the module to the OutputChannel created in `activate`. Idempotent. */
export function initLogger(c: vscode.OutputChannel): void {
  channel = c;
}

/** Append an info-level line, timestamped. */
export function log(message: string): void {
  channel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Append a warning-level line. Prefixed for grep-ability; we don't have
 * separate channels for severity in VS Code's API.
 */
export function logWarn(message: string): void {
  channel?.appendLine(`[${new Date().toISOString()}] WARN  ${message}`);
}

/**
 * Append an error with stack trace. Accepts unknown so callers can pass
 * caught values straight through without narrowing.
 */
export function logError(prefix: string, err: unknown): void {
  const detail =
    err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : String(err);
  channel?.appendLine(
    `[${new Date().toISOString()}] ERROR ${prefix}: ${detail}`,
  );
}
