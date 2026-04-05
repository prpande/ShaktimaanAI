import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { parseTaskFile, type TaskMeta } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type AgentRunOptions, type RunState, type CompletedStage, type ReviewIssue } from "./types.js";
import { type AgentRegistry } from "./registry.js";
import { type TaskLogger, createTaskLogger } from "./logger.js";
import { STAGE_DIR_MAP, DIR_STAGE_MAP } from "./stage-map.js";
import { parseAgentVerdict, parseReviewFindings, decideAfterValidate, decideAfterReview } from "./retry.js";
import { createWorktree, recordWorktreeCompletion } from "./worktree.js";

// Re-export for backwards compatibility
export { STAGE_DIR_MAP, DIR_STAGE_MAP };

// ─── Pure Utilities ─────────────────────────────────────────────────────────

export function getNextStage(currentStage: string, stages: string[]): string | null {
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx === stages.length - 1) return null;
  return stages[idx + 1];
}

export function isReviewGate(completedStage: string, reviewAfter: string): boolean {
  return completedStage === reviewAfter;
}

// ─── RunState Factory & I/O ─────────────────────────────────────────────────

export function createRunState(
  slug: string,
  taskMeta: TaskMeta,
  config: ResolvedConfig,
): RunState {
  const now = new Date().toISOString();
  const stages =
    taskMeta.stages.length > 0
      ? [...taskMeta.stages]
      : [...config.agents.defaultStages];
  const reviewAfter =
    taskMeta.reviewAfter !== ""
      ? taskMeta.reviewAfter
      : config.agents.defaultReviewAfter;

  return {
    slug,
    taskFile: "task.task",
    stages,
    reviewAfter,
    currentStage: "",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedStages: [],
    validateRetryCount: 0,
    reviewRetryCount: 0,
    reviewIssues: [],
  };
}

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

export function initTaskDir(
  runtimeDir: string,
  slug: string,
  stageDir: string,
  taskFilePath: string,
): string {
  const taskDir = join(runtimeDir, stageDir, "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  copyFileSync(taskFilePath, join(taskDir, "task.task"));
  return taskDir;
}

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
  try {
    renameSync(src, dest);
  } catch (err) {
    throw new Error(
      `Failed to move task "${slug}" from "${fromSubdir}" to "${toSubdir}": ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return dest;
}

// ─── Pipeline Interfaces (type-only exports) ────────────────────────────────

export interface PipelineOptions {
  config: ResolvedConfig;
  registry: AgentRegistry;
  runner: AgentRunnerFn;
  logger: TaskLogger;
}

export interface Pipeline {
  startRun(taskFilePath: string, invocationCwd?: string): Promise<void>;
  resumeRun(slug: string, stageSubdir: string): Promise<void>;
  approveAndResume(slug: string, feedback?: string): Promise<void>;
  getActiveRuns(): RunState[];
}

// ─── Pipeline Factory ──────────────────────────────────────────────────────

export function createPipeline(options: PipelineOptions): Pipeline {
  const { config, registry, runner, logger } = options;
  const runtimeDir = config.pipeline.runtimeDir;
  const activeRuns = new Map<string, RunState>();

  const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);

  function mergeReviewIssues(
    existing: ReviewIssue[],
    current: ReviewIssue[],
    iteration: number,
  ): ReviewIssue[] {
    const merged = [...existing];
    for (const finding of current) {
      const idx = merged.findIndex(e => e.id === finding.id);
      if (idx !== -1) {
        merged[idx] = { ...merged[idx], lastSeen: iteration };
      } else {
        merged.push({ ...finding, firstSeen: iteration, lastSeen: iteration });
      }
    }
    return merged;
  }

  function recordCompletionIfWorktree(state: RunState): void {
    if (!state.worktreePath) return;
    const manifestPath = join(runtimeDir, "worktree-manifest.json");
    try {
      recordWorktreeCompletion(manifestPath, {
        slug: state.slug,
        repoPath: state.worktreePath,
        worktreePath: state.worktreePath,
        completedAt: new Date().toISOString(),
      });
    } catch {
      // log but don't fail
    }
  }

  function resolveWorkDir(state: RunState, taskMeta: TaskMeta): string {
    // Resolution chain:
    // 0. workDir already set (retry or resume) → reuse
    if (state.workDir) return state.workDir;

    // 1. Task has a repo path → create worktree
    if (taskMeta.repo) {
      // Resolve repo path: check aliases first, then use raw path
      const alias = config.repos.aliases[taskMeta.repo];
      const repoPath = alias ? alias.path : taskMeta.repo;

      try {
        const worktreesDir = join(runtimeDir, "worktrees");
        const worktreePath = createWorktree(repoPath, state.slug, worktreesDir);
        state.worktreePath = worktreePath;
        return worktreePath;
      } catch (err) {
        // Not a git repo or git not available — fall through to next step
        logger.warn(
          `[pipeline] Could not create worktree for "${state.slug}" at "${repoPath}": ` +
          `${err instanceof Error ? err.message : String(err)}. Falling back.`,
        );
      }
    }

    // 2. No repo (or worktree failed) — check repos.root
    if (config.repos.root) {
      const dir = join(config.repos.root, state.slug);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    // 3. Fall back to invocation cwd
    return state.invocationCwd ?? runtimeDir;
  }

  async function processStage(slug: string, initialTaskDir: string): Promise<void> {
    let currentTaskDir = initialTaskDir;

    // Iterative loop replaces recursion to avoid stack depth issues with long pipelines
    while (true) {
      const state = readRunState(currentTaskDir);
      const stage = state.currentStage;
      const taskLogger = createTaskLogger(join(runtimeDir, "logs"), slug);

      // Resolve workDir when entering impl for the first time
      if (stage === "impl" && !state.workDir) {
        const taskContent = readFileSync(join(currentTaskDir, "task.task"), "utf-8");
        const taskMeta = parseTaskFile(taskContent);
        state.workDir = resolveWorkDir(state, taskMeta);
        writeRunState(currentTaskDir, state);
      }

      if (!registry.canStartAgent(stage)) {
        // Task stays in pending/ — crash recovery will resume it on next startup.
        logger.warn(
          `[pipeline] Capacity reached — task "${slug}" stage "${stage}" deferred (remains in pending/)`,
        );
        return;
      }

      const abortController = new AbortController();
      const agentName = config.agents.names[stage] ?? stage;
      const agentId = registry.register(slug, stage, agentName, abortController);

      // Collect previous outputs from artifacts/
      const artifactsDir = join(currentTaskDir, "artifacts");
      let previousOutput = "";
      if (existsSync(artifactsDir)) {
        const files = readdirSync(artifactsDir).filter(f => f.endsWith(".md")).sort();
        for (const file of files) {
          previousOutput += readFileSync(join(artifactsDir, file), "utf-8") + "\n";
        }
      }

      // Read task content
      const taskContent = readFileSync(join(currentTaskDir, "task.task"), "utf-8");

      const outputPath = join(artifactsDir, `${stage}-output.md`);

      // Execution stages (impl, validate, review, pr) work in the resolved workDir.
      // Alignment stages work in the task directory as before.
      const stageCwd = EXECUTION_STAGES.has(stage) && state.workDir
        ? state.workDir
        : currentTaskDir;

      const runOptions: AgentRunOptions = {
        stage,
        slug,
        taskContent,
        previousOutput: previousOutput.trim(),
        outputPath,
        cwd: stageCwd,
        config,
        abortController,
        logger: taskLogger,
      };

      let result;
      try {
        result = await runner(runOptions);
      } catch (err) {
        registry.unregister(agentId);
        state.status = "failed";
        state.error = err instanceof Error ? err.message : String(err);
        writeRunState(currentTaskDir, state);
        recordCompletionIfWorktree(state);
        try {
          moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            "11-failed",
          );
        } catch (moveErr) {
          logger.error(
            `[pipeline] Failed to move task "${slug}" to 11-failed: ` +
            `${moveErr instanceof Error ? moveErr.message : String(moveErr)}. ` +
            `Original error: ${state.error}`,
          );
        }
        activeRuns.delete(slug);
        return;
      }

      registry.unregister(agentId);

      if (!result.success) {
        state.status = "failed";
        state.error = result.error ?? "Agent failed";
        writeRunState(currentTaskDir, state);
        recordCompletionIfWorktree(state);
        try {
          moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            "11-failed",
          );
        } catch (moveErr) {
          logger.error(
            `[pipeline] Failed to move task "${slug}" to 11-failed: ` +
            `${moveErr instanceof Error ? moveErr.message : String(moveErr)}. ` +
            `Original error: ${state.error}`,
          );
        }
        activeRuns.delete(slug);
        return;
      }

      // If agent didn't write outputPath file, create it from result.output
      if (!existsSync(outputPath)) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, result.output, "utf-8");
      }

      // ─── Verdict checking and retry logic ─────────────────────────────────
      //
      // For validate and review: parse the verdict from the agent output and
      // decide whether to continue, retry (go back to impl), or fail.
      // Non-verdict stages (impl, questions, etc.) fall through immediately.

      if (stage === "validate" || stage === "review") {
        const verdict = parseAgentVerdict(result.output, stage);
        const outcome = { stage, success: true, verdict, output: result.output };

        let decision;
        if (stage === "validate") {
          decision = decideAfterValidate(
            outcome,
            state.validateRetryCount,
            config.agents.maxValidateRetries,
          );
        } else {
          decision = decideAfterReview(
            outcome,
            state.reviewIssues,
            state.reviewRetryCount + 1,
            config.agents.maxReviewRecurrence,
            config.review.enforceSuggestions,
          );
        }

        logger.info(
          `[pipeline] ${stage} verdict="${verdict}" for "${slug}" → action="${decision.action}" reason="${decision.reason}"`,
        );

        if (decision.action === "fail") {
          state.status = "failed";
          state.error = decision.reason;
          writeRunState(currentTaskDir, state);
          recordCompletionIfWorktree(state);
          moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            "11-failed",
          );
          activeRuns.delete(slug);
          return;
        }

        if (decision.action === "retry") {
          // Write feedback artifact for impl to read
          const retryCount = stage === "validate"
            ? state.validateRetryCount + 1
            : state.reviewRetryCount + 1;
          const feedbackFile = `retry-feedback-${stage}-${retryCount}.md`;

          if (decision.feedbackContent) {
            writeFileSync(
              join(currentTaskDir, "artifacts", feedbackFile),
              decision.feedbackContent,
              "utf-8",
            );
          }

          // Update retry counters and issue tracking
          if (stage === "validate") {
            state.validateRetryCount += 1;
          } else {
            state.reviewRetryCount += 1;
            // Merge current findings into reviewIssues
            const currentFindings = parseReviewFindings(result.output);
            state.reviewIssues = mergeReviewIssues(
              state.reviewIssues,
              currentFindings,
              state.reviewRetryCount,
            );
          }

          // Move back to impl/pending
          state.currentStage = "impl";
          state.status = "running";
          writeRunState(currentTaskDir, state);
          currentTaskDir = moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            join(STAGE_DIR_MAP["impl"], "pending"),
          );
          // Continue the while loop — will re-run impl
          continue;
        }

        // decision.action === "continue" — fall through to normal stage completion
      }

      // Add completed stage
      state.completedStages.push({
        stage,
        completedAt: new Date().toISOString(),
        outputFile: `${stage}-output.md`,
        costUsd: result.costUsd,
        turns: result.turns,
      });

      // Move from pending to done
      const doneDir = moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "pending"),
        join(STAGE_DIR_MAP[stage], "done"),
      );

      // Check review gate
      if (isReviewGate(stage, state.reviewAfter)) {
        state.status = "hold";
        writeRunState(doneDir, state);
        moveTaskDir(
          runtimeDir, slug,
          join(STAGE_DIR_MAP[stage], "done"),
          "12-hold",
        );
        activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));
        return;
      }

      // Check next stage
      const nextStage = getNextStage(stage, state.stages);
      if (nextStage === null) {
        state.status = "complete";
        writeRunState(doneDir, state);
        recordCompletionIfWorktree(state);
        moveTaskDir(
          runtimeDir, slug,
          join(STAGE_DIR_MAP[stage], "done"),
          "10-complete",
        );
        activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
        return;
      }

      // Continue to next stage (iterative — no recursion)
      state.currentStage = nextStage;
      state.status = "running";
      writeRunState(doneDir, state);
      currentTaskDir = moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "done"),
        join(STAGE_DIR_MAP[nextStage], "pending"),
      );
    }
  }

  return {
    async startRun(taskFilePath: string, invocationCwd?: string): Promise<void> {
      const slug = basename(taskFilePath, ".task");
      const taskContent = readFileSync(taskFilePath, "utf-8");
      const taskMeta = parseTaskFile(taskContent);
      const state = createRunState(slug, taskMeta, config);

      const firstStage = state.stages[0];
      state.currentStage = firstStage;

      if (invocationCwd) {
        state.invocationCwd = invocationCwd;
      }

      const stageDir = STAGE_DIR_MAP[firstStage];
      const taskDir = initTaskDir(runtimeDir, slug, stageDir, taskFilePath);
      writeRunState(taskDir, state);

      // Delete original inbox file
      unlinkSync(taskFilePath);

      activeRuns.set(slug, state);
      await processStage(slug, taskDir);
    },

    async resumeRun(slug: string, stageSubdir: string): Promise<void> {
      const taskDir = join(runtimeDir, stageSubdir, slug);
      const state = readRunState(taskDir);
      activeRuns.set(slug, state);
      await processStage(slug, taskDir);
    },

    async approveAndResume(slug: string, feedback?: string): Promise<void> {
      const holdDir = join(runtimeDir, "12-hold", slug);
      if (!existsSync(holdDir)) {
        throw new Error(`Task "${slug}" not found in hold`);
      }

      const state = readRunState(holdDir);
      const nextStage = getNextStage(state.currentStage, state.stages);

      if (nextStage === null) {
        state.status = "complete";
        writeRunState(holdDir, state);
        moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
        activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
        return;
      }

      state.status = "running";
      state.currentStage = nextStage;

      if (feedback) {
        writeFileSync(
          join(holdDir, "artifacts", "review-feedback.md"),
          feedback,
          "utf-8",
        );
      }

      writeRunState(holdDir, state);
      const nextTaskDir = moveTaskDir(
        runtimeDir, slug,
        "12-hold",
        join(STAGE_DIR_MAP[nextStage], "pending"),
      );
      activeRuns.set(slug, state);
      await processStage(slug, nextTaskDir);
    },

    getActiveRuns(): RunState[] {
      return Array.from(activeRuns.values());
    },
  };
}
