import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ALL_STAGE_DIRS, STAGES_WITH_PENDING_DONE } from "../core/stage-map.js";

function getAllDirPaths(runtimeDir: string): string[] {
  const dirs: string[] = [];

  for (const stage of ALL_STAGE_DIRS) {
    dirs.push(join(runtimeDir, stage));

    if (STAGES_WITH_PENDING_DONE.includes(stage)) {
      dirs.push(join(runtimeDir, stage, "pending"));
      dirs.push(join(runtimeDir, stage, "done"));
    }
  }

  dirs.push(join(runtimeDir, "logs"));
  dirs.push(join(runtimeDir, "history"));
  dirs.push(join(runtimeDir, "history", "daily-log"));
  dirs.push(join(runtimeDir, "history", "monthly-reports"));
  dirs.push(join(runtimeDir, "interactions"));
  dirs.push(join(runtimeDir, "diagnostics"));

  return dirs;
}

export function createRuntimeDirs(runtimeDir: string): void {
  for (const dir of getAllDirPaths(runtimeDir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function verifyRuntimeDirs(runtimeDir: string): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const dir of getAllDirPaths(runtimeDir)) {
    if (!existsSync(dir)) {
      missing.push(dir);
    }
  }
  return { valid: missing.length === 0, missing };
}
