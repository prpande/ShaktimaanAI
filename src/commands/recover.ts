import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";
import { reenterTask, type ReentryResult } from "../core/recovery-reentry.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HeldRecoveryTask {
  slug: string;
  diagnosis: string;
  reEntryStage: string;
  issueUrl?: string;
  issueNumber?: number;
}

// ─── Data Functions ────────────────────────────────────────────────────────

/**
 * Lists all tasks in 12-hold/ with holdReason "awaiting_fix".
 */
export function listHeldRecoveryTasks(runtimeDir: string): HeldRecoveryTask[] {
  const holdDir = join(runtimeDir, "12-hold");
  if (!existsSync(holdDir)) return [];

  const results: HeldRecoveryTask[] = [];
  let entries: string[];
  try {
    entries = readdirSync(holdDir);
  } catch {
    return [];
  }

  for (const slug of entries) {
    const stateFile = join(holdDir, slug, "run-state.json");
    if (!existsSync(stateFile)) continue;

    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (state.holdReason !== "awaiting_fix") continue;

      results.push({
        slug,
        diagnosis: state.recoveryDiagnosis ?? "No diagnosis available",
        reEntryStage: state.recoveryReEntryStage ?? state.currentStage ?? "unknown",
        issueUrl: state.recoveryIssueUrl ?? undefined,
        issueNumber: state.recoveryIssueNumber ?? undefined,
      });
    } catch {
      // Corrupted state — skip
    }
  }

  return results;
}

/**
 * Returns the full run-state JSON for a specific held task, or null if not found.
 */
export function getRecoveryTaskDetail(
  runtimeDir: string,
  slug: string,
): Record<string, unknown> | null {
  const stateFile = join(runtimeDir, "12-hold", slug, "run-state.json");
  if (!existsSync(stateFile)) return null;

  try {
    return JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── CLI Registration ──────────────────────────────────────────────────────

export function registerRecoverCommand(program: Command): void {
  const cmd = program
    .command("recover [slug]")
    .description("List held recovery tasks, view details, or re-enter a task")
    .option("--reenter", "Re-enter the specified task into the pipeline")
    .action((slug: string | undefined, options: { reenter?: boolean }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const runtimeDir = config.pipeline.runtimeDir;

      if (!slug) {
        // List all held recovery tasks
        const tasks = listHeldRecoveryTasks(runtimeDir);
        if (tasks.length === 0) {
          console.log("No held recovery tasks.");
          return;
        }

        console.log(`\nHeld recovery tasks (${tasks.length}):\n`);
        for (const task of tasks) {
          const issue = task.issueUrl ? ` | Issue: ${task.issueUrl}` : "";
          console.log(`  ${task.slug}`);
          console.log(`    Re-entry: ${task.reEntryStage} | Diagnosis: ${task.diagnosis}${issue}`);
          console.log();
        }
        return;
      }

      if (options.reenter) {
        // Re-enter the task
        const result: ReentryResult = reenterTask(runtimeDir, slug);
        if (result.success) {
          console.log(`Task "${slug}" re-entered pipeline at stage "${result.reEntryStage}".`);
        } else {
          console.error(`Failed to re-enter "${slug}": ${result.error}`);
          process.exit(1);
        }
        return;
      }

      // Show detail for specific task
      const detail = getRecoveryTaskDetail(runtimeDir, slug);
      if (!detail) {
        console.error(`Task "${slug}" not found in 12-hold.`);
        process.exit(1);
      }

      console.log(JSON.stringify(detail, null, 2));
    });
}
