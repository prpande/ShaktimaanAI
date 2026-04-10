import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

import { parseTaskFile, type TaskMeta } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type RunState } from "./types.js";
import { type AgentRegistry } from "./registry.js";
import { type TaskLogger } from "./logger.js";
import { STAGE_DIR_MAP, STAGES_WITH_PENDING_DONE, type PipelineStageName } from "./stage-map.js";
import { TERMINAL_DIR_MAP, type TaskPaths } from "../config/paths.js";
import { type Notifier, type NotifyEvent } from "../surfaces/types.js";
import { createWorktree, recordWorktreeCompletion, resolveParentRepo } from "./worktree.js";
import { appendDailyLogEntry, appendInteraction } from "./interactions.js";
import { createSessionTracker, resolveModelForStage, type BudgetCheckContext } from "./budget.js";
import { loadBudgetConfig } from "../config/loader.js";
import { DEFAULT_BUDGET_CONFIG } from "../config/defaults.js";
import type { BudgetConfig } from "../config/budget-schema.js";
import { runRecoveryAgent } from "./recovery-agent.js";
import { runStage, type StageContext } from "./stage-runner.js";
import { readRunState, writeRunState, moveTaskDir, collectArtifacts, getNextStage, isReviewGate } from "./pipeline-utils.js";

// Re-exported for external consumers.
export { STAGE_DIR_MAP };

// Re-export pipeline utilities for backward compatibility (moved to pipeline-utils.ts)
export { readRunState, writeRunState, moveTaskDir, collectArtifacts, getNextStage, isReviewGate } from "./pipeline-utils.js";

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
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    requiredMcpServers: taskMeta.requiredMcpServers.length > 0 ? taskMeta.requiredMcpServers : undefined,
    repoSummary: taskMeta.repoSummary || undefined,
  };
}

// ─── Directory Helpers ──────────────────────────────────────────────────────

export function initTaskDir(tp: TaskPaths, taskFilePath: string): string {
  mkdirSync(tp.artifactsDir, { recursive: true });
  copyFileSync(taskFilePath, tp.taskFile);
  return tp.taskDir;
}

// ─── Pipeline Interfaces (type-only exports) ────────────────────────────────

export interface PipelineOptions {
  config: ResolvedConfig;
  registry: AgentRegistry;
  runner: AgentRunnerFn;
  logger: TaskLogger;
}

export interface Pipeline {
  // existing
  startRun(taskFilePath: string, invocationCwd?: string): Promise<void>;
  resumeRun(slug: string, stageSubdir: string): Promise<void>;
  approveAndResume(slug: string, feedback?: string): Promise<void>;
  getActiveRuns(): RunState[];

  // control operations
  cancel(slug: string): Promise<void>;
  skip(slug: string, stage?: string): Promise<void>;
  pause(slug: string): Promise<void>;
  resume(slug: string): Promise<void>;
  modifyStages(slug: string, newStages: string[]): Promise<void>;
  restartStage(slug: string, stage?: string): Promise<void>;
  retry(slug: string, feedback: string): Promise<void>;

  // notifier
  addNotifier(notifier: Notifier): void;
}

// ─── Pipeline Factory ──────────────────────────────────────────────────────

export function createPipeline(options: PipelineOptions): Pipeline {
  const { config, registry, runner, logger } = options;
  const runtimeDir = config.pipeline.runtimeDir;
  const interactionsDir = config.paths.interactionsDir;
  const activeRuns = new Map<string, RunState>();
  const deferredTasks: { slug: string; taskDir: string }[] = [];
  const sessionTracker = createSessionTracker();
  const budgetConfig: BudgetConfig = (() => {
    try {
      return loadBudgetConfig(config.paths.usageBudget);
    } catch (err) {
      logger.error(`[pipeline] Failed to load budget config: ${err instanceof Error ? err.message : String(err)}`);
      return DEFAULT_BUDGET_CONFIG;
    }
  })();

  const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);

  // ─── Notifier infrastructure ───────────────────────────────────────────────
  const notifiers: Notifier[] = [];

  function emitNotify(event: NotifyEvent): void {
    for (const n of notifiers) {
      n.notify(event).catch(() => { /* swallow errors */ });
    }
  }

  // ─── failTask: mark a task as failed and move to 11-failed ─────────────────
  function failTask(
    slug: string,
    stage: string,
    taskDir: string,
    state: RunState,
    errorMsg: string,
    fromSubdir: string,
    metrics?: {
      durationSeconds?: number; costUsd?: number; model?: string;
      inputTokens?: number; outputTokens?: number; turns?: number;
    },
  ): void {
    state.status = "failed";
    state.error = errorMsg;
    delete state.holdReason;
    delete state.holdDetail;
    delete state.pausedAtStage;
    writeRunState(taskDir, state);
    try {
      moveTaskDir(runtimeDir, slug, fromSubdir, TERMINAL_DIR_MAP.failed);
    } catch (moveErr) {
      logger.error(
        `[pipeline] Failed to move task "${slug}" to ${TERMINAL_DIR_MAP.failed}: ` +
        `${moveErr instanceof Error ? moveErr.message : String(moveErr)}. ` +
        `Original error: ${state.error}`,
      );
    }
    emitNotify({
      type: "task_failed", slug, stage, error: state.error,
      durationSeconds: metrics?.durationSeconds,
      costUsd: metrics?.costUsd,
      model: metrics?.model,
      inputTokens: metrics?.inputTokens,
      outputTokens: metrics?.outputTokens,
      turns: metrics?.turns,
      agentName: config.agents.names[stage] ?? stage,
      timestamp: new Date().toISOString(),
    });
    try {
      appendDailyLogEntry(interactionsDir, {
        timestamp: new Date().toISOString(),
        type: "agent_failed",
        slug,
        stage,
        agentName: config.agents.names[stage] ?? stage,
        error: state.error ?? "Unknown error",
        success: false,
      });
    } catch { /* swallow */ }
    activeRuns.delete(slug);

    // Fire recovery agent asynchronously — does not block the pipeline
    const failedTaskDir = config.paths.resolveTask(slug, "failed").taskDir;
    if (existsSync(failedTaskDir)) {
      runRecoveryAgent(failedTaskDir, { ...state }, runner, config, logger, (event) => {
        for (const n of notifiers) {
          n.notify(event as any).catch(() => {});
        }
      }).catch((err) => {
        logger.error(`[pipeline] Recovery agent error for "${slug}": ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ─── retryDeferredTasks: called after an agent finishes to unblock waiting tasks
  function retryDeferredTasks(): void {
    if (deferredTasks.length === 0) return;

    // Snapshot and clear — processStage will re-add if still at capacity
    const toRetry = deferredTasks.splice(0);
    for (const { slug, taskDir } of toRetry) {
      // Verify the task is still in pending/ (not cancelled, failed, or already running)
      if (!existsSync(taskDir)) continue;
      let state: RunState;
      try {
        state = readRunState(taskDir);
        if (state.status !== "running") continue;
      } catch {
        continue;
      }
      if (activeRuns.has(slug)) continue;

      logger.info(`[pipeline] Retrying deferred task "${slug}"`);
      activeRuns.set(slug, state);
      // Fire-and-forget — processStage will re-defer if still at capacity
      processStage(slug, taskDir).catch((err: unknown) => {
        logger.error(
          `[pipeline] Failed to retry deferred task "${slug}": ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  // ─── findTaskDir: search 12-hold first, then all stage dirs (pending+done) ─
  function findTaskDir(slug: string): { dir: string; subdir: string } | null {
    // Check 12-hold first
    const holdPath = config.paths.resolveTask(slug, "hold").taskDir;
    if (existsSync(holdPath)) return { dir: holdPath, subdir: TERMINAL_DIR_MAP.hold };

    // Check all stage dirs (pending and done)
    for (const [stageName, stageAbsDir] of Object.entries(config.paths.stages)) {
      if (!STAGES_WITH_PENDING_DONE.includes(STAGE_DIR_MAP[stageName as PipelineStageName])) continue;
      const pendingPath = join(stageAbsDir, "pending", slug);
      if (existsSync(pendingPath)) return { dir: pendingPath, subdir: join(STAGE_DIR_MAP[stageName as PipelineStageName], "pending") };
      const donePath = join(stageAbsDir, "done", slug);
      if (existsSync(donePath)) return { dir: donePath, subdir: join(STAGE_DIR_MAP[stageName as PipelineStageName], "done") };
    }

    return null;
  }

  function recordCompletionIfWorktree(state: RunState): void {
    if (!state.worktreePath) return;
    const manifestPath = config.paths.worktreeManifest;

    // Resolution chain for repoPath:
    // 1. state.repoRoot (set when task had explicit repo)
    // 2. Derive from worktree .git metadata
    // 3. Fall back to config.repos.root
    let repoPath = state.repoRoot ?? null;
    if (!repoPath) {
      repoPath = resolveParentRepo(state.worktreePath);
    }
    if (!repoPath && config.repos.root) {
      const rootGitPath = join(config.repos.root, ".git");
      if (existsSync(rootGitPath)) {
        repoPath = config.repos.root;
      } else {
        logger.warn(
          `[pipeline] Configured repos.root is not a git repo; ` +
          `skipping fallback manifest recording for "${state.slug}". ` +
          `repos.root="${config.repos.root}"`,
        );
      }
    }

    // Guard: if repoPath is still null or equals worktreePath, skip recording
    if (!repoPath || repoPath === state.worktreePath) {
      logger.warn(
        `[pipeline] Cannot determine parent repo for worktree "${state.slug}" — ` +
        `skipping manifest recording to avoid broken cleanup. ` +
        `worktreePath="${state.worktreePath}"`,
      );
      return;
    }

    try {
      recordWorktreeCompletion(manifestPath, {
        slug: state.slug,
        repoPath,
        worktreePath: state.worktreePath,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        `[pipeline] Failed to record worktree completion for "${state.slug}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
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
        const worktreesDir = config.paths.worktreesDir;
        const worktreePath = createWorktree(repoPath, state.slug, worktreesDir, undefined, config.paths.worktreeManifest);
        state.repoRoot = repoPath;
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


  // ─── Stage Context (shared with stage-runner.ts) ───────────────────────────
  const stageCtx: StageContext = {
    config,
    registry,
    runner,
    logger,
    runtimeDir,
    interactionsDir,
    activeRuns,
    deferredTasks,
    sessionTracker,
    budgetConfig,
    executionStages: EXECUTION_STAGES,
    emitNotify,
    failTask,
    retryDeferredTasks,
    resolveWorkDir,
    recordCompletionIfWorktree,
  };

  async function processStage(slug: string, initialTaskDir: string): Promise<void> {
    return runStage(stageCtx, slug, initialTaskDir);
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

      const tp = config.paths.resolveTask(slug, firstStage as PipelineStageName, "pending");
      const taskDir = initTaskDir(tp, taskFilePath);
      writeRunState(taskDir, state);

      // Log task creation interaction
      try {
        appendInteraction(taskDir, slug, {
          timestamp: new Date().toISOString(),
          source: "pipeline",
          intent: "create_task",
          message: taskMeta.title,
          action: "Task created, pipeline started",
        });
      } catch { /* swallow */ }

      // Delete original inbox file
      unlinkSync(taskFilePath);

      activeRuns.set(slug, state);
      emitNotify({
        type: "task_created",
        slug,
        title: slug,
        source: "cli",
        stages: state.stages,
        slackThread: taskMeta.slackThread || undefined,
        timestamp: new Date().toISOString(),
      });
      await processStage(slug, taskDir);
    },

    async resumeRun(slug: string, stageSubdir: string): Promise<void> {
      const taskDir = join(runtimeDir, stageSubdir, slug);
      const state = readRunState(taskDir);
      activeRuns.set(slug, state);
      await processStage(slug, taskDir);
    },

    async approveAndResume(slug: string, feedback?: string): Promise<void> {
      const holdDir = config.paths.resolveTask(slug, "hold").taskDir;
      if (!existsSync(holdDir)) {
        throw new Error(`Task "${slug}" not found in hold`);
      }

      const state = readRunState(holdDir);

      // Guard: budget/pause holds mean the stage was interrupted — resume at current stage
      if (state.holdReason === "budget_exhausted" || state.holdReason === "user_paused") {
        if (state.holdReason === "budget_exhausted") {
          state.budgetResetAtIndex = state.completedStages.length;
        }
        delete state.holdReason;
        delete state.holdDetail;
        delete state.pausedAtStage;
        state.status = "running";
        writeRunState(holdDir, state);

        const stageDir = STAGE_DIR_MAP[state.currentStage];
        const nextDir = moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, join(stageDir, "pending"));
        activeRuns.set(slug, state);
        await processStage(slug, nextDir);
        return;
      }

      // Original behavior: advance to next stage (for approval_required holds)
      const nextStage = getNextStage(state.currentStage, state.stages);

      if (nextStage === null) {
        state.status = "complete";
        writeRunState(holdDir, state);
        recordCompletionIfWorktree(state);
        moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, TERMINAL_DIR_MAP.complete);
        activeRuns.set(slug, readRunState(config.paths.resolveTask(slug, "complete").taskDir));
        emitNotify({
          type: "task_completed", slug,
          completedStages: state.completedStages,
          startedAt: state.startedAt,
          agentNames: config.agents.names,
          timestamp: new Date().toISOString(),
        });
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
      emitNotify({
        type: "task_approved",
        slug,
        approvedBy: "user",
        feedback: feedback ?? "",
        timestamp: new Date().toISOString(),
      });
      const nextTaskDir = moveTaskDir(
        runtimeDir, slug,
        TERMINAL_DIR_MAP.hold,
        join(STAGE_DIR_MAP[nextStage], "pending"),
      );
      activeRuns.set(slug, state);
      await processStage(slug, nextTaskDir);
    },

    getActiveRuns(): RunState[] {
      return Array.from(activeRuns.values());
    },

    // ─── Control Operations ──────────────────────────────────────────────────

    async cancel(slug: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);
      const state = readRunState(found.dir);
      recordCompletionIfWorktree(state);
      state.status = "failed";
      state.error = "Cancelled by user";
      writeRunState(found.dir, state);
      moveTaskDir(runtimeDir, slug, found.subdir, TERMINAL_DIR_MAP.failed);
      activeRuns.delete(slug);
      emitNotify({ type: "task_cancelled", slug, cancelledBy: "user", timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "cancel",
        });
      } catch { /* swallow */ }
    },

    async skip(slug: string, stage?: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);
      const state = readRunState(found.dir);
      const targetStage = stage ?? state.currentStage;
      const nextStage = getNextStage(targetStage, state.stages);
      if (!nextStage) throw new Error(`No stage after "${targetStage}" to skip to`);
      const nextStageDir = STAGE_DIR_MAP[nextStage];
      if (!nextStageDir) {
        throw new Error(`Cannot skip to stage "${nextStage}" — no stage directory mapping exists`);
      }
      state.currentStage = nextStage;
      state.status = "running";
      writeRunState(found.dir, state);
      const nextDir = moveTaskDir(runtimeDir, slug, found.subdir, join(nextStageDir, "pending"));
      emitNotify({ type: "stage_skipped", slug, stage: targetStage, timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "skip",
        });
      } catch { /* swallow */ }
      await processStage(slug, nextDir);
    },

    async pause(slug: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);
      const state = readRunState(found.dir);
      state.status = "hold";
      state.pausedAtStage = state.currentStage;
      state.holdReason = "user_paused";
      writeRunState(found.dir, state);
      moveTaskDir(runtimeDir, slug, found.subdir, TERMINAL_DIR_MAP.hold);
      activeRuns.set(slug, readRunState(config.paths.resolveTask(slug, "hold").taskDir));
      emitNotify({ type: "task_paused", slug, pausedBy: "user", timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "pause",
        });
      } catch { /* swallow */ }
    },

    async resume(slug: string): Promise<void> {
      const holdDir = config.paths.resolveTask(slug, "hold").taskDir;
      if (!existsSync(holdDir)) throw new Error(`Task "${slug}" not found in hold`);
      const state = readRunState(holdDir);
      if (!state.pausedAtStage) throw new Error(`Task "${slug}" was not paused — use approve instead`);
      const resumeStage = state.pausedAtStage;

      // Budget-aware resume: re-check budget before allowing resume
      if (state.holdReason === "budget_exhausted") {
        state.budgetResetAtIndex = state.completedStages.length;
        const budgetCtx: BudgetCheckContext = {
          interactionsDir,
          sessionTracker,
          taskCompletedStages: state.completedStages.slice(state.budgetResetAtIndex),
          today: new Date(),
        };
        const resolution = resolveModelForStage(resumeStage, config, budgetConfig, budgetCtx);
        if (resolution.action === "hold") {
          state.holdDetail = resolution.reason;
          writeRunState(holdDir, state);
          logger.warn(`[pipeline] Budget still exhausted for "${slug}": ${resolution.reason} — keeping in hold`);
          return;
        }
        // Budget is now OK — clear hold detail
        delete state.holdDetail;
      }

      state.status = "running";
      state.currentStage = resumeStage;
      delete state.holdReason;
      delete state.pausedAtStage;
      writeRunState(holdDir, state);
      const nextDir = moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, join(STAGE_DIR_MAP[resumeStage], "pending"));
      activeRuns.set(slug, state);
      emitNotify({ type: "task_resumed", slug, resumedBy: "user", timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "resume",
        });
      } catch { /* swallow */ }
      await processStage(slug, nextDir);
    },

    async modifyStages(slug: string, newStages: string[]): Promise<void> {
      if (newStages.length === 0) throw new Error("Cannot set empty stage list");
      const validStages = new Set([...Object.keys(STAGE_DIR_MAP), "quick"]);
      const invalid = newStages.filter(s => !validStages.has(s));
      if (invalid.length > 0) throw new Error(`Invalid stage names: ${invalid.join(", ")}`);
      const dupes = newStages.filter((s, i) => newStages.indexOf(s) !== i);
      if (dupes.length > 0) throw new Error(`Duplicate stage names: ${dupes.join(", ")}`);

      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);
      const state = readRunState(found.dir);
      if (!newStages.includes(state.currentStage)) {
        throw new Error(
          `Cannot remove current stage "${state.currentStage}" from stage list. ` +
          `The task is currently executing this stage.`,
        );
      }
      const oldStages = [...state.stages];
      state.stages = newStages;
      writeRunState(found.dir, state);
      emitNotify({ type: "stages_modified", slug, oldStages, newStages, timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "modifyStages",
        });
      } catch { /* swallow */ }
    },

    async restartStage(slug: string, stage?: string): Promise<void> {
      registry.abortBySlug(slug);
      const found = findTaskDir(slug);
      if (!found) throw new Error(`Task "${slug}" not found`);
      const state = readRunState(found.dir);
      const targetStage = stage ?? state.currentStage;
      const stageDir = STAGE_DIR_MAP[targetStage];
      if (!stageDir) {
        throw new Error(`Cannot restartStage stage "${targetStage}" — no stage directory mapping exists`);
      }
      state.currentStage = targetStage;
      state.status = "running";
      writeRunState(found.dir, state);
      const nextDir = moveTaskDir(runtimeDir, slug, found.subdir, join(stageDir, "pending"));
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "restartStage",
        });
      } catch { /* swallow */ }
      await processStage(slug, nextDir);
    },

    async retry(slug: string, feedback: string): Promise<void> {
      const holdDir = config.paths.resolveTask(slug, "hold").taskDir;
      if (!existsSync(holdDir)) throw new Error(`Task "${slug}" not found in hold`);
      const state = readRunState(holdDir);
      if (state.pausedAtStage) throw new Error(`Task "${slug}" was paused — use resume instead`);
      const retryStage = state.currentStage;
      const stageDir = STAGE_DIR_MAP[retryStage];
      if (!stageDir) {
        throw new Error(`Cannot retry stage "${retryStage}" — no stage directory mapping exists`);
      }
      state.retryAttempts = state.retryAttempts ?? {};
      state.retryAttempts[retryStage] = (state.retryAttempts[retryStage] ?? 0) + 1;
      state.status = "running";

      // Write versioned feedback artifact
      const feedbackFile = `retry-feedback-${retryStage}-${state.retryAttempts[retryStage]}.md`;
      writeFileSync(join(holdDir, "artifacts", feedbackFile), feedback, "utf-8");

      writeRunState(holdDir, state);
      const nextDir = moveTaskDir(runtimeDir, slug, TERMINAL_DIR_MAP.hold, join(stageDir, "pending"));
      activeRuns.set(slug, state);
      emitNotify({ type: "stage_retried", slug, stage: retryStage, attempt: state.retryAttempts[retryStage], feedback, timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "control",
          slug,
          source: "user",
          command: "retry",
        });
      } catch { /* swallow */ }
      await processStage(slug, nextDir);
    },

    // ─── Notifier ────────────────────────────────────────────────────────────

    addNotifier(notifier: Notifier): void {
      notifiers.push(notifier);
    },
  };
}
