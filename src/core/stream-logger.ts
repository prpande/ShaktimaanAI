import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── StreamLogger ────────────────────────────────────────────────────────────

export interface StreamLogger {
  log(message: Record<string, unknown>): void;
  close(): void;
}

/**
 * Creates a JSONL stream logger that appends one JSON line per message.
 * - Parent directory is created if missing (mkdirSync recursive).
 * - Each entry is stamped with a `ts` field (ISO timestamp).
 * - Uses appendFileSync so partial logs survive crashes.
 * - Write errors are swallowed silently — stream logging must never crash the pipeline.
 * - close() is a no-op (nothing to flush for append-mode writes).
 */
export function createStreamLogger(filePath: string): StreamLogger {
  // Ensure parent directory exists — swallow errors so construction never throws
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Ignore directory creation errors
  }

  return {
    log(message: Record<string, unknown>): void {
      try {
        const entry: Record<string, unknown> = {
          ...message,
          ts: new Date().toISOString(),
        };
        appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // Swallow write errors silently — must not interrupt the pipeline
      }
    },

    close(): void {
      // No-op: appendFileSync has no handle to flush or close
    },
  };
}
