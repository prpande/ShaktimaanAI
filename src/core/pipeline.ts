import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, unlinkSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";

import { parseTaskFile, type TaskMeta } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type AgentRunOptions, type RunState, type CompletedStage, type ReviewIssue } from "./types.js";
import { type AgentRegistry } from "./registry.js";
import { type TaskLogger, createTaskLogger } from "./logger.js";
import { STAGE_DIR_MAP, DIR_STAGE_MAP, STAGES_WITH_PENDING_DONE } from "./stage-map.js";
import { STAGE_ARTIFACT_RULES } from "../config/defaults.js";
import { type Notifier, type NotifyEvent } from "../surfaces/types.js";
import { parseAgentVerdict, parseReviewFindings, decideAfterValidate, decideAfterReview } from "./retry.js";
import { createWorktree, recordWorktreeCompletion } from "./worktree.js";
import { appendDailyLogEntry, appendInteraction } from "./interactions.js";
import { createSessionTracker, resolveModelForStage, checkBudget, type BudgetCheckContext } from "./budget.js";
import { loadBudgetConfig } from "../config/loader.js";
import { DEFAULT_BUDGET_CONFIG } from "../config/defaults.js";
import type { BudgetConfig } from "../config/budget-schema.js";

// Re-exported for external consumers; DIR_STAGE_MAP is not used internally in this module.
export { STAGE_DIR_MAP, DIR_STAGE_MAP };

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
  const interactionsDir = join(runtimeDir, "interactions");
  const activeRuns = new Map<string, RunState>();
  const deferredTasks: { slug: string; taskDir: string }[] = [];
  const sessionTracker = createSessionTracker();
  const budgetConfig: BudgetConfig = (() => {
    try {
      return loadBudgetConfig(runtimeDir);
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
      moveTaskDir(runtimeDir, slug, fromSubdir, "11-failed");
    } catch (moveErr) {
      logger.error(
        `[pipeline] Failed to move task "${slug}" to 11-failed: ` +
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
  }

  // ─── retryDeferredTasks: called after an agent finishes to unblock waiting tasks
  function retryDeferredTasks(): void {
    if (deferredTasks.length === 0) return;

    // Snapshot and clear — processStage will re-add if still at capacity
    const toRetry = deferredTasks.splice(0);
    for (const { slug, taskDir } of toRetry) {
      // Verify the task is still in pending/ (not cancelled, failed, or already running)
      if (!existsSync(taskDir)) continue;
      try {
        const state = readRunState(taskDir);
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
    const holdPath = join(runtimeDir, "12-hold", slug);
    if (existsSync(holdPath)) return { dir: holdPath, subdir: "12-hold" };

    // Check all stage dirs (pending and done)
    for (const stageDir of STAGES_WITH_PENDING_DONE) {
      const pendingPath = join(runtimeDir, stageDir, "pending", slug);
      if (existsSync(pendingPath)) return { dir: pendingPath, subdir: join(stageDir, "pending") };
      const donePath = join(runtimeDir, stageDir, "done", slug);
      if (existsSync(donePath)) return { dir: donePath, subdir: join(stageDir, "done") };
    }

    return null;
  }

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
        repoPath: state.repoRoot ?? state.worktreePath,
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
        // Track deferred task so we can retry when a slot frees up
        if (!deferredTasks.some(d => d.slug === slug)) {
          deferredTasks.push({ slug, taskDir: currentTaskDir });
        }
        logger.warn(
          `[pipeline] Capacity reached — task "${slug}" stage "${stage}" deferred (remains in pending/)`,
        );
        return;
      }

      const abortController = new AbortController();
      const agentName = config.agents.names[stage] ?? stage;
      const agentId = registry.register(slug, stage, agentName, abortController);
      emitNotify({ type: "stage_started", slug, stage, agentName: config.agents.names[stage] ?? stage, timestamp: new Date().toISOString() });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "agent_started",
          slug,
          stage,
          agentName: config.agents.names[stage] ?? stage,
          attempt: state.retryAttempts?.[stage] ?? 0,
        });
      } catch { /* swallow */ }

      // Collect previous outputs from artifacts/
      const artifactsDir = join(currentTaskDir, "artifacts");
      const previousOutput = existsSync(artifactsDir)
        ? collectArtifacts(artifactsDir, stage, state.stages)
        : "";

      // Read task content
      const taskContent = readFileSync(join(currentTaskDir, "task.task"), "utf-8");

      const stageRetryCount = state.retryAttempts?.[stage] ?? 0;
      const outputSuffix = stageRetryCount > 0 ? `-r${stageRetryCount}` : "";
      const outputPath = join(artifactsDir, `${stage}-output${outputSuffix}.md`);

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
        stageHints: state.stageHints,
        abortController,
        logger: taskLogger,
        requiredMcpServers: state.requiredMcpServers,
        repoSummary: state.repoSummary,
      };

      // ─── Pre-stage budget check ──────────────────────────────────────────
      const budgetContext: BudgetCheckContext = {
        interactionsDir,
        sessionTracker,
        taskCompletedStages: state.budgetResetAtIndex
          ? state.completedStages.slice(state.budgetResetAtIndex)
          : state.completedStages,
        today: new Date(),
      };
      const modelResolution = resolveModelForStage(stage, config, budgetConfig, budgetContext);

      if (modelResolution.action === "hold") {
        registry.unregister(agentId);
        retryDeferredTasks();
        state.status = "hold";
        state.holdReason = "budget_exhausted";
        state.holdDetail = modelResolution.reason;
        state.pausedAtStage = stage;
        writeRunState(currentTaskDir, state);
        try {
          moveTaskDir(runtimeDir, slug, join(STAGE_DIR_MAP[stage], "pending"), "12-hold");
        } catch (moveErr) {
          logger.error(
            `[pipeline] Failed to move budget-held task "${slug}" to 12-hold: ` +
            `${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
          );
        }
        activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));
        emitNotify({
          type: "task_held", slug, stage, artifactUrl: "",
          holdReason: "budget_exhausted",
          holdDetail: modelResolution.reason,
          agentName: config.agents.names[stage] ?? stage,
          model: runOptions.model,
          timestamp: new Date().toISOString(),
        });
        logger.warn(`[pipeline] Budget exhausted for "${slug}" at stage "${stage}": ${modelResolution.reason}`);
        try {
          appendDailyLogEntry(interactionsDir, {
            timestamp: new Date().toISOString(),
            type: "budget_hold",
            slug,
            stage,
            reason: modelResolution.reason,
          });
        } catch { /* swallow */ }
        return;
      }

      if (modelResolution.action === "downgrade") {
        logger.warn(
          `[pipeline] Downgraded "${slug}" stage "${stage}" from ${config.agents.models?.[stage] ?? "unknown"} to ${modelResolution.model}: ${modelResolution.reason}`,
        );
      }
      runOptions.model = modelResolution.model;

      let result;
      try {
        result = await runner(runOptions);
      } catch (err) {
        registry.unregister(agentId);
        retryDeferredTasks();
        failTask(slug, stage, currentTaskDir, state, err instanceof Error ? err.message : String(err), join(STAGE_DIR_MAP[stage], "pending"));
        recordCompletionIfWorktree(state);
        return;
      }

      registry.unregister(agentId);
      retryDeferredTasks();

      if (!result.success) {
        failTask(slug, stage, currentTaskDir, state, result.error ?? "Agent failed", join(STAGE_DIR_MAP[stage], "pending"), {
          durationSeconds: Math.round(result.durationMs / 1000),
          costUsd: result.costUsd,
          model: runOptions.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          turns: result.turns,
        });
        recordCompletionIfWorktree(state);
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

      let verdict: string | undefined;

      if (stage === "validate" || stage === "review") {
        verdict = parseAgentVerdict(result.output, stage);
        const outcome = { stage, success: true, verdict, output: result.output };

        let decision;
        if (stage === "validate") {
          decision = decideAfterValidate(
            outcome,
            state.validateFailCount,
            config.agents.maxValidateRetries,
          );
        } else {
          decision = decideAfterReview(
            outcome,
            state.reviewIssues,
            state.reviewRetryCount + 1,
            state.suggestionRetryUsed,
            config.review.enforceSuggestions,
            config.agents.maxReviewRetries,
          );
        }

        logger.info(
          `[pipeline] ${stage} verdict="${verdict}" for "${slug}" → action="${decision.action}" reason="${decision.reason}"`,
        );

        if (decision.action === "fail") {
          // Log completion for failed verdict stages — critical for budget accuracy
          try {
            appendDailyLogEntry(interactionsDir, {
              timestamp: new Date().toISOString(),
              type: "agent_completed",
              slug,
              stage,
              agentName: config.agents.names[stage] ?? stage,
              model: runOptions.model ?? "",
              durationSeconds: Math.round(result.durationMs / 1000),
              costUsd: result.costUsd,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              artifactPath: `${stage}-output${outputSuffix}.md`,
              agentStreamLog: result.streamLogPath ?? "",
              success: true,
              verdict,
              retryAction: decision.action,
            });
          } catch { /* swallow */ }

          state.status = "failed";
          state.error = decision.reason;
          emitNotify({
            type: "task_failed", slug, stage, error: decision.reason,
            durationSeconds: Math.round(result.durationMs / 1000),
            costUsd: result.costUsd,
            model: runOptions.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            turns: result.turns,
            agentName: config.agents.names[stage] ?? stage,
            timestamp: new Date().toISOString(),
          });
          delete state.holdReason;
          delete state.holdDetail;
          delete state.pausedAtStage;
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
          // Log completion even for retried stages — critical for budget accuracy
          try {
            appendDailyLogEntry(interactionsDir, {
              timestamp: new Date().toISOString(),
              type: "agent_completed",
              slug,
              stage,
              agentName: config.agents.names[stage] ?? stage,
              model: runOptions.model ?? "",
              durationSeconds: Math.round(result.durationMs / 1000),
              costUsd: result.costUsd,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              artifactPath: `${stage}-output${outputSuffix}.md`,
              agentStreamLog: result.streamLogPath ?? "",
              success: true,
              verdict,
              retryAction: decision.action,
            });
          } catch { /* swallow */ }

          // Write feedback artifact for impl to read
          const retryCount = stage === "validate"
            ? state.validateFailCount + 1
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
            state.validateFailCount += 1;
            state.suggestionRetryUsed = false; // reset suggestion budget for new cycle
          } else {
            state.reviewRetryCount += 1;
            if (outcome.verdict === "APPROVED_WITH_SUGGESTIONS") {
              state.suggestionRetryUsed = true;
            }
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
      const outputFileName = `${stage}-output${outputSuffix}.md`;
      const resolvedModel = runOptions.model ?? config.agents.models?.[stage];
      state.completedStages.push({
        stage,
        completedAt: new Date().toISOString(),
        outputFile: outputFileName,
        durationSeconds: Math.round(result.durationMs / 1000),
        costUsd: result.costUsd,
        turns: result.turns,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: resolvedModel,
      });

      // Track session-level token usage
      const totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
      if (resolvedModel) {
        sessionTracker.addUsage(resolvedModel, totalTokens);
      }

      // Post-stage budget warning (informational only — completed work is never rolled back)
      try {
        const postStatus = checkBudget(resolvedModel ?? "sonnet", budgetConfig, {
          interactionsDir,
          sessionTracker,
          taskCompletedStages: state.completedStages,
          today: new Date(),
        });
        if (postStatus.isOverLimit) {
          logger.warn(
            `[pipeline] Budget warning after "${stage}" for "${slug}": ${resolvedModel} ${postStatus.limitBreached} limit now exceeded`,
          );
        }
      } catch { /* swallow — post-stage warning is non-critical */ }

      emitNotify({
        type: "stage_completed", slug, stage,
        artifactPath: `${stage}-output${outputSuffix}.md`,
        durationSeconds: Math.round(result.durationMs / 1000),
        costUsd: result.costUsd,
        model: resolvedModel,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turns: result.turns,
        verdict,
        agentName: config.agents.names[stage] ?? stage,
        timestamp: new Date().toISOString(),
      });
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "agent_completed",
          slug,
          stage,
          agentName: config.agents.names[stage] ?? stage,
          model: resolvedModel ?? "",
          durationSeconds: Math.round(result.durationMs / 1000),
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          artifactPath: `${stage}-output${outputSuffix}.md`,
          agentStreamLog: result.streamLogPath ?? "",
          success: true,
        });
      } catch { /* swallow */ }

      // Move from pending to done
      const doneDir = moveTaskDir(
        runtimeDir, slug,
        join(STAGE_DIR_MAP[stage], "pending"),
        join(STAGE_DIR_MAP[stage], "done"),
      );

      // Check review gate
      if (isReviewGate(stage, state.reviewAfter)) {
        state.status = "hold";
        state.holdReason = "approval_required";
        writeRunState(doneDir, state);
        moveTaskDir(
          runtimeDir, slug,
          join(STAGE_DIR_MAP[stage], "done"),
          "12-hold",
        );
        activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));
        emitNotify({
          type: "task_held", slug, stage, artifactUrl: "",
          holdReason: "approval_required",
          agentName: config.agents.names[stage] ?? stage,
          timestamp: new Date().toISOString(),
        });
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
        emitNotify({
          type: "task_completed", slug,
          completedStages: state.completedStages,
          startedAt: state.startedAt,
          agentNames: config.agents.names,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Continue to next stage (iterative — no recursion)
      state.currentStage = nextStage;
      state.status = "running";
      writeRunState(doneDir, state);
      try {
        appendDailyLogEntry(interactionsDir, {
          timestamp: new Date().toISOString(),
          type: "stage_transition",
          slug,
          fromStage: stage,
          toStage: nextStage,
        });
      } catch { /* swallow */ }
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
      const holdDir = join(runtimeDir, "12-hold", slug);
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
        const nextDir = moveTaskDir(runtimeDir, slug, "12-hold", join(stageDir, "pending"));
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
        moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
        activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
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
        "12-hold",
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
      moveTaskDir(runtimeDir, slug, found.subdir, "11-failed");
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
      moveTaskDir(runtimeDir, slug, found.subdir, "12-hold");
      activeRuns.set(slug, readRunState(join(runtimeDir, "12-hold", slug)));
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
      const holdDir = join(runtimeDir, "12-hold", slug);
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
      const nextDir = moveTaskDir(runtimeDir, slug, "12-hold", join(STAGE_DIR_MAP[resumeStage], "pending"));
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
      const holdDir = join(runtimeDir, "12-hold", slug);
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
      const nextDir = moveTaskDir(runtimeDir, slug, "12-hold", join(stageDir, "pending"));
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
