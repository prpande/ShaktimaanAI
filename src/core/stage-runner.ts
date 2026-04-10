import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { parseTaskFile } from "../task/parser.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn, type AgentRunOptions, type RunState, type ReviewIssue } from "./types.js";
import { type AgentRegistry } from "./registry.js";
import { type TaskLogger, createTaskLogger } from "./logger.js";
import { STAGE_DIR_MAP } from "./stage-map.js";
import { TERMINAL_DIR_MAP } from "../config/paths.js";
import { type NotifyEvent } from "../surfaces/types.js";
import { parseAgentVerdict, parseReviewFindings, decideAfterValidate, decideAfterReview } from "./retry.js";
import { appendDailyLogEntry } from "./interactions.js";
import { resolveModelForStage, checkBudget, type BudgetCheckContext } from "./budget.js";
import type { BudgetConfig } from "../config/budget-schema.js";
import type { SessionTokenTracker } from "./budget.js";
import { readRunState, writeRunState, moveTaskDir, collectArtifacts, getNextStage, isReviewGate } from "./pipeline-utils.js";

// ─── StageContext ─────────────────────────────────────────────────────────────

export interface StageContext {
  config: ResolvedConfig;
  registry: AgentRegistry;
  runner: AgentRunnerFn;
  logger: TaskLogger;
  runtimeDir: string;
  interactionsDir: string;
  activeRuns: Map<string, RunState>;
  deferredTasks: { slug: string; taskDir: string }[];
  sessionTracker: SessionTokenTracker;
  budgetConfig: BudgetConfig;
  executionStages: Set<string>;

  // Callbacks that remain in pipeline.ts (they reference pipeline-internal state)
  emitNotify: (event: NotifyEvent) => void;
  failTask: (
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
  ) => void;
  retryDeferredTasks: () => void;
  resolveWorkDir: (state: RunState, taskMeta: ReturnType<typeof parseTaskFile>) => string;
  recordCompletionIfWorktree: (state: RunState) => void;
}

// ─── Helpers (moved from pipeline.ts) ─────────────────────────────────────────

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

// ─── runStage ─────────────────────────────────────────────────────────────────

export async function runStage(ctx: StageContext, slug: string, initialTaskDir: string): Promise<void> {
  const {
    config, registry, runner, logger, runtimeDir, interactionsDir,
    activeRuns, deferredTasks, sessionTracker, budgetConfig, executionStages,
    emitNotify, failTask, retryDeferredTasks, resolveWorkDir, recordCompletionIfWorktree,
  } = ctx;

  let currentTaskDir = initialTaskDir;

  // Iterative loop replaces recursion to avoid stack depth issues with long pipelines
  while (true) {
    const state = readRunState(currentTaskDir);
    const stage = state.currentStage;
    const taskLogger = createTaskLogger(config.paths.logsDir, slug);

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
    emitNotify({ type: "stage_started", slug, stage, agentName, timestamp: new Date().toISOString() });
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
    const stageCwd = executionStages.has(stage) && state.workDir
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
        moveTaskDir(runtimeDir, slug, join(STAGE_DIR_MAP[stage], "pending"), TERMINAL_DIR_MAP.hold);
      } catch (moveErr) {
        logger.error(
          `[pipeline] Failed to move budget-held task "${slug}" to ${TERMINAL_DIR_MAP.hold}: ` +
          `${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
        );
      }
      activeRuns.set(slug, readRunState(config.paths.resolveTask(slug, "hold").taskDir));
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
          TERMINAL_DIR_MAP.failed,
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
      artifactPath: outputFileName,
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
        TERMINAL_DIR_MAP.hold,
      );
      activeRuns.set(slug, readRunState(config.paths.resolveTask(slug, "hold").taskDir));
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
        TERMINAL_DIR_MAP.complete,
      );
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
