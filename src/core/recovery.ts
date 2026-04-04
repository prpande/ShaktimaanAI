import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import { STAGE_DIR_MAP } from "./stage-map.js";
import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecoveryItem {
  slug: string;
  stage: string;
  dir: string;
}

export interface RecoveryResult {
  resumed: string[];
  skipped: string[];
  errors: Array<{ slug: string; error: string }>;
}

// ─── scanForRecovery ─────────────────────────────────────────────────────────

/**
 * Scans each stage's pending/ directory and returns a list of task directories
 * found there. Only counts directories (not files).
 */
export function scanForRecovery(runtimeDir: string): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const [stage, stageDir] of Object.entries(STAGE_DIR_MAP)) {
    const pendingDir = join(runtimeDir, stageDir, "pending");

    if (!existsSync(pendingDir)) {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(pendingDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(pendingDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        items.push({
          slug: entry,
          stage,
          dir: fullPath,
        });
      }
    }
  }

  return items;
}

// ─── runRecovery ─────────────────────────────────────────────────────────────

/**
 * Scans for pending tasks and resumes each one via the pipeline.
 * Catches errors per item and adds them to result.errors.
 */
export async function runRecovery(
  runtimeDir: string,
  pipeline: Pipeline,
  logger: TaskLogger,
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    resumed: [],
    skipped: [],
    errors: [],
  };

  const items = scanForRecovery(runtimeDir);

  const RECOVERY_TIMEOUT_MS = 30_000; // 30 seconds per task

  for (const item of items) {
    const stageSubdir = join(STAGE_DIR_MAP[item.stage], "pending");
    try {
      logger.info(`Recovering task "${item.slug}" from stage "${item.stage}"`);
      await Promise.race([
        pipeline.resumeRun(item.slug, stageSubdir),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)), RECOVERY_TIMEOUT_MS),
        ),
      ]);
      result.resumed.push(item.slug);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover task "${item.slug}": ${errorMsg}`);
      result.errors.push({ slug: item.slug, error: errorMsg });
    }
  }

  return result;
}
