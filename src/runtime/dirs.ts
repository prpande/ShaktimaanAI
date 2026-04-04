import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const STAGE_DIRS = [
  "00-inbox",
  "01-questions",
  "02-research",
  "03-design",
  "04-structure",
  "05-plan",
  "06-impl",
  "07-validate",
  "08-review",
  "09-pr",
  "10-complete",
  "11-failed",
  "12-hold",
] as const;

const STAGES_WITH_PENDING_DONE = [
  "01-questions", "02-research", "03-design", "04-structure",
  "05-plan", "06-impl", "07-validate", "08-review", "09-pr",
] as const;

function getAllDirPaths(runtimeDir: string): string[] {
  const dirs: string[] = [];

  for (const stage of STAGE_DIRS) {
    dirs.push(join(runtimeDir, stage));

    if ((STAGES_WITH_PENDING_DONE as readonly string[]).includes(stage)) {
      dirs.push(join(runtimeDir, stage, "pending"));
      dirs.push(join(runtimeDir, stage, "done"));
    }

    if (stage === "06-impl") {
      dirs.push(join(runtimeDir, stage, "active"));
    }
  }

  dirs.push(join(runtimeDir, "logs"));
  dirs.push(join(runtimeDir, "history"));
  dirs.push(join(runtimeDir, "history", "daily-log"));
  dirs.push(join(runtimeDir, "history", "monthly-reports"));

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
