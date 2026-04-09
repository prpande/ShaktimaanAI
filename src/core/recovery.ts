import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
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

// ─── Startup Scan Types ─────────────────────────────────────────────────────

export interface UnanalyzedFailure {
  slug: string;
  dir: string;
  stage: string;
  error: string;
}

export interface HeldTaskWithIssue {
  slug: string;
  dir: string;
  issueNumber: number;
  issueUrl: string;
  reEntryStage: string;
}

// ─── scanUnanalyzedFailures ─────────────────────────────────────────────────

/**
 * Scans 11-failed/ for tasks where run-state.json has no terminalFailure,
 * no recoveryIssueUrl, and no recoveryDiagnosis — i.e., the recovery agent
 * hasn't analyzed them yet.
 */
export function scanUnanalyzedFailures(runtimeDir: string): UnanalyzedFailure[] {
  const failedDir = join(runtimeDir, "11-failed");
  const results: UnanalyzedFailure[] = [];

  for (const slug of listDirectories(failedDir)) {
    const stateFile = join(failedDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;

    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.terminalFailure) continue;
      if (state.recoveryIssueUrl) continue;
      if (state.recoveryDiagnosis) continue;

      results.push({
        slug,
        dir: join(failedDir, slug),
        stage: state.currentStage ?? "unknown",
        error: state.error ?? "Unknown error",
      });
    } catch {
      // Corrupted state file — skip
    }
  }

  return results;
}

// ─── scanHeldTasksWithIssues ────────────────────────────────────────────────

/**
 * Scans 12-hold/ for tasks where holdReason === "awaiting_fix" and
 * recoveryIssueNumber exists — these are tasks waiting for a fix to be merged.
 */
export function scanHeldTasksWithIssues(runtimeDir: string): HeldTaskWithIssue[] {
  const holdDir = join(runtimeDir, "12-hold");
  const results: HeldTaskWithIssue[] = [];

  for (const slug of listDirectories(holdDir)) {
    const stateFile = join(holdDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;

    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.holdReason !== "awaiting_fix") continue;
      if (!state.recoveryIssueNumber) continue;

      results.push({
        slug,
        dir: join(holdDir, slug),
        issueNumber: state.recoveryIssueNumber,
        issueUrl: state.recoveryIssueUrl ?? "",
        reEntryStage: state.recoveryReEntryStage ?? state.currentStage ?? "unknown",
      });
    } catch {
      // Corrupted state file — skip
    }
  }

  return results;
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

  // Recovery timeout must be long enough for the agent to complete the current
  // stage. Each stage has its own timeout (default 30-90 min in config), so
  // recovery timeout should exceed the longest stage timeout. Using 2 hours.
  const RECOVERY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours per task

  // Separate hold items (synchronous, no async work) from recoverable items
  const recoverableItems: RecoveryItem[] = [];
  for (const item of items) {
    if (item.location === "hold") {
      logger.info(`Found held task "${item.slug}" in 12-hold — awaiting approval`);
      result.skipped.push(item.slug);
    } else {
      recoverableItems.push(item);
    }
  }

  // Fan out recovery concurrently with proper timeout cleanup
  const promises = recoverableItems.map((item) => {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Recovery timed out after ${RECOVERY_TIMEOUT_MS / 1000}s`)),
        RECOVERY_TIMEOUT_MS,
      );
    });

    let pipelinePromise: Promise<void>;

    switch (item.location) {
      case "pending": {
        const stageSubdir = join(STAGE_DIR_MAP[item.stage], "pending");
        logger.info(`Recovering task "${item.slug}" from stage "${item.stage}" (pending)`);
        pipelinePromise = pipeline.resumeRun(item.slug, stageSubdir);
        break;
      }
      case "done": {
        const stageSubdir = join(STAGE_DIR_MAP[item.stage], "done");
        logger.info(`Recovering task "${item.slug}" from stage "${item.stage}" (done — needs advance)`);
        pipelinePromise = pipeline.resumeRun(item.slug, stageSubdir);
        break;
      }
      case "inbox": {
        logger.info(`Recovering unprocessed inbox task "${item.slug}"`);
        pipelinePromise = pipeline.startRun(item.dir);
        break;
      }
      default:
        // Should never happen — hold items are filtered above
        return Promise.resolve({ slug: item.slug, ok: true as const });
    }

    return Promise.race([pipelinePromise, timeoutPromise])
      .then(() => ({ slug: item.slug, ok: true as const }))
      .catch((err) => ({ slug: item.slug, ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => clearTimeout(timeoutHandle!));
  });

  const outcomes = await Promise.allSettled(promises);

  for (const outcome of outcomes) {
    // Promise.allSettled with our .then/.catch wrapper should always be "fulfilled"
    if (outcome.status === "fulfilled") {
      const { slug, ok } = outcome.value;
      if (ok) {
        result.resumed.push(slug);
      } else {
        const errorMsg = (outcome.value as { slug: string; ok: false; error: string }).error;
        logger.error(`Failed to recover task "${slug}": ${errorMsg}`);
        result.errors.push({ slug, error: errorMsg });
      }
    }
  }

  return result;
}
