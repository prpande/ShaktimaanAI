import { existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { PIPELINE_STAGES } from "./stage-map.js";
import { STAGE_DIR_MAP } from "./stage-map.js";
import { readRunState, writeRunState, moveTaskDir } from "./pipeline.js";
import { TERMINAL_DIR_MAP } from "../config/paths.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReentryResult {
  success: boolean;
  reEntryStage?: string;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the list of stages at or after the given stage (inclusive).
 * Used to determine which artifacts are "downstream" and should be archived.
 */
function getDownstreamStages(reEntryStage: string): string[] {
  const idx = PIPELINE_STAGES.indexOf(reEntryStage as any);
  if (idx === -1) return [];
  return PIPELINE_STAGES.slice(idx) as unknown as string[];
}

/**
 * Archives downstream artifact files to artifacts/pre-recovery/.
 * Keeps upstream artifacts in place.
 */
function archiveDownstreamArtifacts(taskDir: string, reEntryStage: string): void {
  const artifactsDir = join(taskDir, "artifacts");
  if (!existsSync(artifactsDir)) return;

  const downstreamStages = new Set(getDownstreamStages(reEntryStage));
  if (downstreamStages.size === 0) return;

  let files: string[];
  try {
    files = readdirSync(artifactsDir);
  } catch {
    return;
  }

  const archiveDir = join(artifactsDir, "pre-recovery");

  for (const file of files) {
    // Skip directories (like pre-recovery itself)
    if (file === "pre-recovery") continue;

    // Check if the artifact belongs to a downstream stage (including retry-feedback files)
    const isDownstream = Array.from(downstreamStages).some(
      (stage) => file.startsWith(stage) || file.startsWith(`retry-feedback-${stage}-`),
    );
    if (!isDownstream) continue;

    // Move to archive
    mkdirSync(archiveDir, { recursive: true });
    try {
      renameSync(join(artifactsDir, file), join(archiveDir, file));
    } catch {
      // Non-fatal — file may already be moved or locked
    }
  }
}

// ─── reenterTask ────────────────────────────────────────────────────────────

/**
 * Moves a task from 12-hold/ back into the pipeline at the correct re-entry stage.
 *
 * 1. Reads run-state from 12-hold/{slug}/
 * 2. Validates holdReason === "awaiting_fix"
 * 3. Archives downstream artifacts to artifacts/pre-recovery/
 * 4. Resets run-state (clears error, sets status to "running", sets currentStage,
 *    clears retry counts for re-entry stage and downstream, clears recovery fields)
 * 5. Moves task from 12-hold/ to {stage}/pending/
 */
export function reenterTask(
  runtimeDir: string,
  slug: string,
): ReentryResult {
  const holdDir = join(runtimeDir, TERMINAL_DIR_MAP.hold, slug);

  // 1. Verify task exists in 12-hold
  if (!existsSync(holdDir)) {
    return { success: false, error: `Task "${slug}" not found in 12-hold` };
  }

  // 2. Read and validate run-state
  let state;
  try {
    state = readRunState(holdDir);
  } catch (err) {
    return { success: false, error: `Failed to read run-state: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (state.holdReason !== "awaiting_fix") {
    return { success: false, error: `Task "${slug}" holdReason is "${state.holdReason}", expected "awaiting_fix"` };
  }

  // Determine re-entry stage
  const reEntryStage = state.recoveryReEntryStage ?? state.currentStage;
  if (!reEntryStage || !STAGE_DIR_MAP[reEntryStage]) {
    return { success: false, error: `Invalid re-entry stage "${reEntryStage}"` };
  }

  // 3. Archive downstream artifacts
  archiveDownstreamArtifacts(holdDir, reEntryStage);

  // 4. Reset run-state
  state.status = "running";
  state.currentStage = reEntryStage;
  state.error = undefined;
  delete state.holdReason;
  delete state.holdDetail;
  delete state.pausedAtStage;

  // Defensively default maps/arrays that may be missing in old state files
  state.retryAttempts ??= {};
  state.reviewIssues ??= [];
  state.stageHints ??= {};

  // Clear retry counts for re-entry stage and downstream
  const downstreamStages = getDownstreamStages(reEntryStage);
  for (const stage of downstreamStages) {
    delete state.retryAttempts[stage];
  }
  // Reset validate/review counters if re-entering at or before those stages
  if (downstreamStages.includes("validate")) {
    state.validateFailCount = 0;
    state.validateRetryCount = 0;
  }
  if (downstreamStages.includes("review")) {
    state.reviewRetryCount = 0;
    state.reviewIssues = [];
    state.suggestionRetryUsed = false;
  }

  // Clear recovery fields
  state.terminalFailure = undefined;
  state.recoveryDiagnosis = undefined;
  state.recoveryReEntryStage = undefined;
  state.recoveryIssueUrl = undefined;
  state.recoveryIssueNumber = undefined;

  writeRunState(holdDir, state);

  // 5. Move from 12-hold to {stage}/pending
  const targetSubdir = join(STAGE_DIR_MAP[reEntryStage], "pending");
  try {
    moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, targetSubdir);
  } catch (err) {
    return { success: false, error: `Failed to move task: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { success: true, reEntryStage };
}
