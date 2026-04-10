import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApproveInput {
  source: "slack" | "dashboard" | "cli";
  taskSlug: string;
  feedback?: string;
}

// ─── findHeldTask ────────────────────────────────────────────────────────────

/**
 * Checks whether {holdDir}/{slug} exists as a directory.
 * Returns the full path if found, null otherwise.
 * Pass config.paths.terminals.hold as holdDir.
 */
export function findHeldTask(holdDir: string, slug: string): string | null {
  const taskPath = join(holdDir, slug);
  try {
    if (existsSync(taskPath) && statSync(taskPath).isDirectory()) {
      return taskPath;
    }
  } catch {
    // Directory may have been removed between existsSync and statSync
  }
  return null;
}

// ─── listHeldTasks ───────────────────────────────────────────────────────────

/**
 * Lists directory names (task slugs) in holdDir (12-hold/).
 * Returns an empty array if the directory doesn't exist or is empty.
 * Files are ignored — only directories are returned.
 * Pass config.paths.terminals.hold as holdDir.
 */
export function listHeldTasks(holdDir: string): string[] {
  if (!existsSync(holdDir)) {
    return [];
  }

  return readdirSync(holdDir).filter((entry) => {
    const entryPath = join(holdDir, entry);
    try {
      return statSync(entryPath).isDirectory();
    } catch {
      // Entry may have been deleted between readdirSync and statSync
      return false;
    }
  });
}

// ─── approveTask ─────────────────────────────────────────────────────────────

/**
 * Approves a held task and resumes the pipeline.
 * Throws if the task is not found in 12-hold.
 */
export async function approveTask(
  input: ApproveInput,
  holdDir: string,
  pipeline: Pipeline,
  logger: TaskLogger,
): Promise<void> {
  const { taskSlug, feedback } = input;

  const taskPath = findHeldTask(holdDir, taskSlug);
  if (taskPath === null) {
    throw new Error(`Task "${taskSlug}" not found in hold`);
  }

  logger.info(`Approving task "${taskSlug}" (source: ${input.source})`);

  await pipeline.approveAndResume(taskSlug, feedback);
}
