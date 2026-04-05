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
  /** Where the item lives: "pending", "done", "inbox", or "hold" */
  location: "pending" | "done" | "inbox" | "hold";
}

export interface RecoveryResult {
  resumed: string[];
  skipped: string[];
  errors: Array<{ slug: string; error: string }>;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function listDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    try {
      return statSync(join(dir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listFiles(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    try {
      return entry.endsWith(extension) && statSync(join(dir, entry)).isFile();
    } catch {
      return false;
    }
  });
}

// ─── scanForRecovery ─────────────────────────────────────────────────────────

/**
 * Scans all pipeline directories for tasks that need recovery:
 * - pending/ dirs: tasks mid-execution at crash time
 * - done/ dirs: tasks that completed a stage but weren't moved to next stage
 * - 12-hold/: held tasks that need re-registration
 * - 00-inbox/: unprocessed .task files that arrived before/during crash
 */
export function scanForRecovery(runtimeDir: string): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  // 1. Scan each stage's pending/ and done/ directories
  for (const [stage, stageDir] of Object.entries(STAGE_DIR_MAP)) {
    const pendingDir = join(runtimeDir, stageDir, "pending");
    for (const slug of listDirectories(pendingDir)) {
      items.push({
        slug,
        stage,
        dir: join(pendingDir, slug),
        location: "pending",
      });
    }

    const doneDir = join(runtimeDir, stageDir, "done");
    for (const slug of listDirectories(doneDir)) {
      items.push({
        slug,
        stage,
        dir: join(doneDir, slug),
        location: "done",
      });
    }
  }

  // 2. Scan 12-hold/ for held tasks
  const holdDir = join(runtimeDir, "12-hold");
  for (const slug of listDirectories(holdDir)) {
    items.push({
      slug,
      stage: "hold",
      dir: join(holdDir, slug),
      location: "hold",
    });
  }

  // 3. Scan 00-inbox/ for unprocessed .task files
  const inboxDir = join(runtimeDir, "00-inbox");
  for (const file of listFiles(inboxDir, ".task")) {
    const slug = file.replace(/\.task$/, "");
    items.push({
      slug,
      stage: "inbox",
      dir: join(inboxDir, file),
      location: "inbox",
    });
  }

  return items;
}

// ─── runRecovery ─────────────────────────────────────────────────────────────

/**
 * Scans for tasks needing recovery and resumes each one via the pipeline.
 * Handles four recovery locations:
 * - pending/: resume the in-progress stage
 * - done/: resume from the next stage (stage completed but move interrupted)
 * - hold: re-register held tasks (no action needed, they wait for approval)
 * - inbox: start new pipeline runs for unprocessed .task files
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
    try {
      switch (item.location) {
        case "pending": {
          const stageSubdir = join(STAGE_DIR_MAP[item.stage], "pending");
          logger.info(`Recovering task "${item.slug}" from stage "${item.stage}" (pending)`);
          await Promise.race([
            pipeline.resumeRun(item.slug, stageSubdir),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)), RECOVERY_TIMEOUT_MS),
            ),
          ]);
          result.resumed.push(item.slug);
          break;
        }

        case "done": {
          // Task completed this stage but crashed before moving to the next.
          // Resume from the done/ directory — the pipeline will advance it.
          const stageSubdir = join(STAGE_DIR_MAP[item.stage], "done");
          logger.info(`Recovering task "${item.slug}" from stage "${item.stage}" (done — needs advance)`);
          await Promise.race([
            pipeline.resumeRun(item.slug, stageSubdir),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)), RECOVERY_TIMEOUT_MS),
            ),
          ]);
          result.resumed.push(item.slug);
          break;
        }

        case "hold": {
          // Held tasks just need to be logged — they wait for explicit approval.
          logger.info(`Found held task "${item.slug}" in 12-hold — awaiting approval`);
          result.skipped.push(item.slug);
          break;
        }

        case "inbox": {
          // Unprocessed .task files — start new pipeline runs
          logger.info(`Recovering unprocessed inbox task "${item.slug}"`);
          await Promise.race([
            pipeline.startRun(item.dir),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)), RECOVERY_TIMEOUT_MS),
            ),
          ]);
          result.resumed.push(item.slug);
          break;
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover task "${item.slug}": ${errorMsg}`);
      result.errors.push({ slug: item.slug, error: errorMsg });
    }
  }

  return result;
}
