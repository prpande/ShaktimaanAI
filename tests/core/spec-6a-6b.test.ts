import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { aggregateTaskTokens } from "../../src/core/budget.js";
import { decideAfterReview } from "../../src/core/retry.js";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { buildPaths } from "../../src/config/paths.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import type { AgentRunOptions, AgentRunResult, RunState, CompletedStage } from "../../src/core/types.js";
import {
  createPipeline,
  readRunState,
  writeRunState,
} from "../../src/core/pipeline.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let TEST_DIR: string;

const TASK_CONTENT = `# Task: Spec 6 test

## What I want done
Test spec 6a/6b fixes.

## Context
Testing only.

## Repo

## ADO Item

## Slack Thread

## Pipeline Config
stages: questions
review_after: design
`;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR }, ...overrides }),
  );
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => makeLogger(),
  } as any;
}

function successResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    success: true,
    output: "**Verdict:** PASS\n\nAll checks passed.",
    costUsd: 0.05,
    turns: 3,
    durationMs: 5000,
    inputTokens: 1500,
    outputTokens: 800,
    ...overrides,
  };
}

function setupTaskInPending(slug: string, stage: string, state: Partial<RunState> = {}): string {
  const stageDir = {
    questions: "01-questions", research: "02-research", design: "03-design",
    structure: "04-structure", plan: "05-plan", impl: "06-impl",
    review: "07-review", validate: "08-validate", pr: "09-pr",
  }[stage] ?? stage;
  const taskDir = join(TEST_DIR, stageDir, "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  writeFileSync(join(taskDir, "task.task"), TASK_CONTENT);

  const fullState: RunState = {
    slug,
    taskFile: "task.task",
    stages: [stage],
    reviewAfter: "design",
    currentStage: stage,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    ...state,
  };
  writeRunState(taskDir, fullState);
  return taskDir;
}

function setupTaskInHold(slug: string, stage: string, state: Partial<RunState> = {}): string {
  const holdDir = join(TEST_DIR, "12-hold", slug);
  mkdirSync(join(holdDir, "artifacts"), { recursive: true });
  writeFileSync(join(holdDir, "task.task"), TASK_CONTENT);

  const fullState: RunState = {
    slug,
    taskFile: "task.task",
    stages: [stage],
    reviewAfter: "design",
    currentStage: stage,
    status: "hold",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    pausedAtStage: stage,
    ...state,
  };
  writeRunState(holdDir, fullState);
  return holdDir;
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-spec6-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(buildPaths(TEST_DIR));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 1: Budget-Reset on Resume
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-1: aggregateTaskTokens with startIndex", () => {
  const stages: CompletedStage[] = [
    { stage: "questions", completedAt: "2024-01-01T10:00:00Z", model: "sonnet", inputTokens: 50_000, outputTokens: 30_000 },
    { stage: "research", completedAt: "2024-01-01T11:00:00Z", model: "sonnet", inputTokens: 40_000, outputTokens: 20_000 },
    { stage: "design", completedAt: "2024-01-01T12:00:00Z", model: "opus", inputTokens: 30_000, outputTokens: 10_000 },
    { stage: "impl", completedAt: "2024-01-01T13:00:00Z", model: "sonnet", inputTokens: 60_000, outputTokens: 40_000 },
  ];

  it("sums all tokens when startIndex is 0 (default)", () => {
    expect(aggregateTaskTokens(stages, "sonnet")).toBe(240_000); // 80k + 60k + 100k
  });

  it("sums only tokens from startIndex onward", () => {
    // startIndex=2 → only design (opus, skipped) and impl (sonnet: 60k+40k=100k)
    expect(aggregateTaskTokens(stages, "sonnet", 2)).toBe(100_000);
  });

  it("returns 0 when startIndex equals array length", () => {
    expect(aggregateTaskTokens(stages, "sonnet", 4)).toBe(0);
  });

  it("returns 0 when startIndex exceeds array length", () => {
    expect(aggregateTaskTokens(stages, "sonnet", 10)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 2: Approve Guard — budget-held task resumes at current stage
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-2: approveAndResume for budget-held task", () => {
  it("resumes at current stage instead of advancing for budget_exhausted hold", async () => {
    const config = makeConfig();
    const slug = "test-approve-budget";

    setupTaskInHold(slug, "review", {
      stages: ["impl", "review", "validate"],
      holdReason: "budget_exhausted",
      holdDetail: "opus daily limit at 110%",
      completedStages: [
        { stage: "impl", completedAt: "2024-01-01T10:00:00Z", model: "opus", inputTokens: 50_000, outputTokens: 30_000 },
      ],
    });

    const ranStages: string[] = [];
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async (opts: AgentRunOptions) => {
        ranStages.push(opts.stage);
        return successResult({ output: "**Verdict:** APPROVED\n\nAll good." });
      },
      logger: makeLogger(),
    });

    await pipeline.approveAndResume(slug);

    // Should resume at review (current stage), not skip to validate
    // Review runs first, then pipeline continues to validate
    expect(ranStages[0]).toBe("review");
  });

  it("resumes at current stage for user_paused hold", async () => {
    const config = makeConfig();
    const slug = "test-approve-paused";

    setupTaskInHold(slug, "impl", {
      stages: ["impl"],
      holdReason: "user_paused",
    });

    const ranStages: string[] = [];
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async (opts: AgentRunOptions) => {
        ranStages.push(opts.stage);
        return successResult();
      },
      logger: makeLogger(),
    });

    await pipeline.approveAndResume(slug);

    // Should resume at impl (current stage, not advance past it)
    expect(ranStages[0]).toBe("impl");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 3: Review Counter Hard-Cap
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-3: decideAfterReview hard cap", () => {
  it("returns fail when currentIteration exceeds maxReviewRetries", () => {
    const outcome = {
      stage: "review",
      success: true,
      verdict: "CHANGES_REQUIRED",
      output: "[R1] MUST_FIX: Error\n\n**Verdict:** CHANGES_REQUIRED",
    };
    const decision = decideAfterReview(outcome, [], 6, false, true, 5);
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("Review retry limit");
    expect(decision.reason).toContain("5");
  });

  it("allows retry when currentIteration is within limit", () => {
    const outcome = {
      stage: "review",
      success: true,
      verdict: "CHANGES_REQUIRED",
      output: "[R1] MUST_FIX: Error\n\n**Verdict:** CHANGES_REQUIRED",
    };
    const decision = decideAfterReview(outcome, [], 3, false, true, 5);
    expect(decision.action).toBe("retry");
  });

  it("maxReviewRetries defaults to 5 when not provided", () => {
    const outcome = {
      stage: "review",
      success: true,
      verdict: "CHANGES_REQUIRED",
      output: "[R1] MUST_FIX: Error\n\n**Verdict:** CHANGES_REQUIRED",
    };
    // Iteration 6 exceeds default of 5
    const decision = decideAfterReview(outcome, [], 6, false, true);
    expect(decision.action).toBe("fail");
  });

  it("maxReviewRetries in config is respected", () => {
    expect(DEFAULT_CONFIG.agents.maxReviewRetries).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 4: Log agent_completed for Retried Stages
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-4: retry/fail stages log agent_completed", () => {
  it("logs agent_completed entry for retried review stage", async () => {
    const config = makeConfig();
    const slug = "test-retry-log";

    setupTaskInPending(slug, "review", {
      stages: ["impl", "review", "validate"],
      completedStages: [
        { stage: "impl", completedAt: "2024-01-01T10:00:00Z", model: "sonnet", inputTokens: 1000, outputTokens: 500 },
      ],
    });

    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async (opts: AgentRunOptions) => {
        if (opts.stage === "review") {
          return successResult({
            output: "[R1] MUST_FIX: Error\n\n**Verdict:** CHANGES_REQUIRED",
            inputTokens: 2000,
            outputTokens: 1000,
          });
        }
        // impl retry — just succeed with PASS for review next time
        return successResult({ output: "Implementation done." });
      },
      logger: makeLogger(),
    });

    await pipeline.resumeRun(slug, "07-review/pending");

    // Verify JSONL was written for the retried review
    const interactionsDir = join(TEST_DIR, "interactions");
    const todayStr = new Date().toISOString().slice(0, 10);
    const logPath = join(interactionsDir, `${todayStr}.jsonl`);
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const entries = lines.map(l => JSON.parse(l));
    const completedEntries = entries.filter(
      (e: any) => e.type === "agent_completed" && e.stage === "review",
    );
    // Should have at least one agent_completed for the retried review
    expect(completedEntries.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 5: holdReason for Review Gate
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-5: review gate sets holdReason", () => {
  it("sets holdReason to approval_required at review gate", async () => {
    const config = makeConfig();
    const slug = "test-review-gate-reason";

    setupTaskInPending(slug, "design", {
      stages: ["design", "structure", "plan"],
      reviewAfter: "design",
    });

    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => successResult(),
      logger: makeLogger(),
    });

    await pipeline.resumeRun(slug, "03-design/pending");

    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);
    const state = readRunState(holdDir);
    expect(state.status).toBe("hold");
    expect(state.holdReason).toBe("approval_required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 6: failTask Clears Stale Hold Metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-6: failTask clears hold metadata", () => {
  it("failed task has no holdReason, holdDetail, or pausedAtStage", async () => {
    const config = makeConfig();
    const slug = "test-fail-clean";

    // Set up a task that will fail (unknown verdict)
    setupTaskInPending(slug, "validate", {
      stages: ["impl", "review", "validate"],
      holdReason: "budget_exhausted",
      holdDetail: "was budget held before",
      pausedAtStage: "validate",
      completedStages: [
        { stage: "impl", completedAt: "2024-01-01T10:00:00Z", model: "sonnet", inputTokens: 1000, outputTokens: 500 },
        { stage: "review", completedAt: "2024-01-01T11:00:00Z", model: "sonnet", inputTokens: 1000, outputTokens: 500 },
      ],
    });

    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => successResult({
        output: "No verdict here — will fail with unknown verdict",
      }),
      logger: makeLogger(),
    });

    await pipeline.resumeRun(slug, "08-validate/pending");

    const failedDir = join(TEST_DIR, "11-failed", slug);
    expect(existsSync(failedDir)).toBe(true);
    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.holdReason).toBeUndefined();
    expect(state.holdDetail).toBeUndefined();
    expect(state.pausedAtStage).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec 6a Fix 1 + Fix 2: Budget reset integration
// ═══════════════════════════════════════════════════════════════════════════

describe("6a-1+2: budget reset on resume integration", () => {
  it("budgetResetAtIndex is set when approving budget-held task", async () => {
    const config = makeConfig();
    const slug = "test-budget-reset-idx";

    const priorStages: CompletedStage[] = [
      { stage: "questions", completedAt: "2024-01-01T10:00:00Z", model: "sonnet", inputTokens: 50_000, outputTokens: 30_000 },
      { stage: "research", completedAt: "2024-01-01T11:00:00Z", model: "sonnet", inputTokens: 40_000, outputTokens: 20_000 },
    ];

    setupTaskInHold(slug, "design", {
      stages: ["questions", "research", "design"],
      holdReason: "budget_exhausted",
      holdDetail: "sonnet daily limit at 110%",
      completedStages: priorStages,
    });

    let capturedState: RunState | undefined;
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async (opts: AgentRunOptions) => {
        // Capture the state at the point the agent runs
        const taskDir = join(TEST_DIR, "03-design", "pending", slug);
        if (existsSync(taskDir)) {
          capturedState = readRunState(taskDir);
        }
        return successResult();
      },
      logger: makeLogger(),
    });

    await pipeline.approveAndResume(slug);

    // budgetResetAtIndex should be 2 (length of completedStages at time of reset)
    expect(capturedState).toBeDefined();
    expect(capturedState!.budgetResetAtIndex).toBe(2);
  });
});
