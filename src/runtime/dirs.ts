import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "../config/paths.js";

/**
 * Collects all directories that should exist under the runtime root.
 * Derives paths from the RuntimePaths object — no hardcoded directory names.
 */
function getAllDirPaths(paths: RuntimePaths): string[] {
  const dirs: string[] = [];

  // Stage directories with pending/done subdirs
  for (const stageDir of Object.values(paths.stages)) {
    dirs.push(stageDir);
    dirs.push(join(stageDir, "pending"));
    dirs.push(join(stageDir, "done"));
  }

  // Terminal directories (no pending/done)
  for (const termDir of Object.values(paths.terminals)) {
    dirs.push(termDir);
  }

  // Non-stage directories
  dirs.push(paths.logsDir);
  dirs.push(paths.historyDir);
  dirs.push(paths.dailyLogDir);
  dirs.push(paths.monthlyReportsDir);
  dirs.push(paths.interactionsDir);
  dirs.push(paths.diagnosticsDir);
  dirs.push(paths.astraResponsesDir);
  dirs.push(paths.worktreesDir);

  return dirs;
}

export function createRuntimeDirs(paths: RuntimePaths): void {
  for (const dir of getAllDirPaths(paths)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function verifyRuntimeDirs(paths: RuntimePaths): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const dir of getAllDirPaths(paths)) {
    if (!existsSync(dir)) {
      missing.push(dir);
    }
  }
  return { valid: missing.length === 0, missing };
}
