import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type RunState } from "./types.js";
import { STAGE_ARTIFACT_RULES } from "../config/defaults.js";

// ─── Scoped Artifact Collection ────────────────────────────────────────────

/** Extract retry number from artifact filename. Base "foo-output.md" = 0, "foo-output-r2.md" = 2. */
function parseRetryNum(filename: string): number {
  const m = filename.match(/-r(\d+)\.md$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Collects artifact files for a stage based on STAGE_ARTIFACT_RULES.
 * Replaces the old blanket concatenation of all .md files.
 */
export function collectArtifacts(
  artifactsDir: string,
  stage: string,
  stages: string[],
): string {
  const rules = STAGE_ARTIFACT_RULES[stage] ?? { mode: 'all_prior' as const };

  if (rules.mode === 'none') return '';

  let files: string[];
  try {
    files = readdirSync(artifactsDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return '';
  }

  if (rules.mode === 'specific') {
    // For each prefix, pick only the latest file (highest retry number).
    // Base "impl-output.md" = retry 0, "impl-output-r2.md" = retry 2.
    const latestByPrefix = new Map<string, { file: string; retry: number }>();
    for (const f of files) {
      const matchedPrefix = rules.specificFiles!.find(prefix => f.startsWith(prefix));
      if (matchedPrefix) {
        const retryNum = parseRetryNum(f);
        const current = latestByPrefix.get(matchedPrefix);
        if (!current || retryNum > current.retry) {
          latestByPrefix.set(matchedPrefix, { file: f, retry: retryNum });
        }
      }
    }
    return Array.from(latestByPrefix.values())
      .map(({ file }) => readFileSync(join(artifactsDir, file), 'utf-8'))
      .join('\n');
  }

  // mode === 'all_prior': only include outputs from stages before current.
  // Dedup per prior stage — pick only the latest retry for each.
  const stageIdx = stages.indexOf(stage);
  if (stageIdx <= 0) return '';
  const priorStages = new Set(stages.slice(0, stageIdx));

  const latestPerStage = new Map<string, { file: string; retry: number }>();
  const retryFeedbackFiles: string[] = [];

  for (const f of files) {
    if (rules.includeRetryFeedback && f.startsWith('retry-feedback-')) {
      retryFeedbackFiles.push(f);
      continue;
    }
    const stageMatch = f.match(/^(.+)-output/);
    if (!stageMatch || !priorStages.has(stageMatch[1])) continue;
    const stageName = stageMatch[1];
    const retryNum = parseRetryNum(f);
    const current = latestPerStage.get(stageName);
    if (!current || retryNum > current.retry) {
      latestPerStage.set(stageName, { file: f, retry: retryNum });
    }
  }

  function parseTrailingNum(filename: string): number {
    const match = filename.match(/-(\d+)\.md$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  const outputFiles = [
    ...Array.from(latestPerStage.values()).map(({ file }) => file),
    ...retryFeedbackFiles,
  ].sort((a, b) => {
    const aIsRetry = a.startsWith("retry-feedback-");
    const bIsRetry = b.startsWith("retry-feedback-");
    if (aIsRetry && bIsRetry) return parseTrailingNum(a) - parseTrailingNum(b);
    if (aIsRetry) return 1;
    if (bIsRetry) return -1;
    return a.localeCompare(b);
  });

  return outputFiles
    .map(f => readFileSync(join(artifactsDir, f), 'utf-8'))
    .join('\n');
}

// ─── Pure Utilities ─────────────────────────────────────────────────────────

export function getNextStage(currentStage: string, stages: string[]): string | null {
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx === stages.length - 1) return null;
  return stages[idx + 1];
}

export function isReviewGate(completedStage: string, reviewAfter: string): boolean {
  return completedStage === reviewAfter;
}

// ─── RunState I/O ───────────────────────────────────────────────────────────

const RUN_STATE_FILE = "run-state.json";

export function readRunState(taskDir: string): RunState {
  const filePath = join(taskDir, RUN_STATE_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read run state at "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch (err) {
    throw new Error(`Corrupt run state JSON at "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function writeRunState(taskDir: string, state: RunState): void {
  const updated: RunState = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(join(taskDir, RUN_STATE_FILE), JSON.stringify(updated, null, 2), "utf-8");
}

// ─── Directory Helpers ──────────────────────────────────────────────────────

export function moveTaskDir(
  runtimeDir: string,
  slug: string,
  fromSubdir: string,
  toSubdir: string,
): string {
  const src = join(runtimeDir, fromSubdir, slug);
  const destParent = join(runtimeDir, toSubdir);
  mkdirSync(destParent, { recursive: true });
  const dest = join(destParent, slug);

  // Retry with backoff for Windows EBUSY/EPERM file locking issues.
  // renameSync fails on Windows when files inside the directory have open handles.
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      renameSync(src, dest);
      return dest;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxRetries) {
        // Wait for file handles to be released (100ms, 200ms, 400ms, 800ms, 1600ms)
        const delayMs = 100 * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // Intentional spin-wait: moveTaskDir must be synchronous because it's called
          // from both sync and async contexts in the pipeline. This path only executes
          // on Windows EBUSY/EPERM retry (rare), with max total wait of ~3.1s.
        }
        continue;
      }
      // If retries exhausted or different error, fall back to copy+delete
      if (code === "EBUSY" || code === "EPERM") {
        try {
          cpSync(src, dest, { recursive: true });
          rmSync(src, { recursive: true, force: true });
          return dest;
        } catch (copyErr) {
          throw new Error(
            `Failed to move task "${slug}" from "${fromSubdir}" to "${toSubdir}": ` +
            `rename failed (${(err as Error).message}), copy fallback also failed: ` +
            `${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
          );
        }
      }
      throw new Error(
        `Failed to move task "${slug}" from "${fromSubdir}" to "${toSubdir}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return dest;
}
