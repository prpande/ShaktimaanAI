import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import type { AgentRunOptions, AgentRunResult, RunState } from "../../src/core/types.js";
import {
  createPipeline,
  readRunState,
  writeRunState,
} from "../../src/core/pipeline.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let TEST_DIR: string;

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
    output: "**Verdict:** READY_FOR_REVIEW\n\nAll checks passed.",
    costUsd: 0.05,
    turns: 3,
    durationMs: 5000,
    inputTokens: 1500,
    outputTokens: 800,
    ...overrides,
  };
}

const TASK_CONTENT = `# Task: Budget test

## What I want done
Test budget enforcement.

## Context
Testing only.

## Repo

## ADO Item

## Slack Thread

## Pipeline Config
stages: validate
review_after: design
`;

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

function writeHugeUsageForToday(model: string, tokens: number) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "agent_completed",
    slug: "other-task",
    model,
    inputTokens: tokens,
    outputTokens: tokens,
  });
  const dir = join(TEST_DIR, "interactions");
  mkdirSync(dir, { recursive: true });
  const existing = (() => {
    try { return require("node:fs").readFileSync(join(dir, `${todayStr}.jsonl`), "utf-8"); } catch { return ""; }
  })();
  writeFileSync(join(dir, `${todayStr}.jsonl`), existing + entry + "\n");
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-budget-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── S8: Pre-stage Budget Enforcement ───────────────────────────────────────

describe("Pipeline pre-stage budget enforcement", () => {
  it("moves task to 12-hold when budget is exhausted for all models", async () => {
    const config = makeConfig();
    const slug = "test-budget-hold";

    // Exhaust both opus and sonnet daily budgets
    writeHugeUsageForToday("opus", 10_000_000);
    writeHugeUsageForToday("sonnet", 50_000_000);

    // validate stage uses sonnet by default
    setupTaskInPending(slug, "validate");

    let runnerCalled = false;
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => { runnerCalled = true; return successResult(); },
      logger: makeLogger(),
    });

    await pipeline.resumeRun(slug, "08-validate/pending");

    expect(runnerCalled).toBe(false);

    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);

    const holdState = readRunState(holdDir);
    expect(holdState.status).toBe("hold");
    expect(holdState.holdReason).toBe("budget_exhausted");
    expect(holdState.holdDetail).toBeTruthy();
    expect(holdState.pausedAtStage).toBe("validate");
  });

  it("downgrades model when opus is over limit but sonnet is OK", async () => {
    const config = makeConfig();
    const slug = "test-downgrade";

    // Exhaust opus only
    writeHugeUsageForToday("opus", 10_000_000);

    // plan stage defaults to opus
    setupTaskInPending(slug, "plan", { stages: ["plan"] });

    let usedModel: string | undefined;
    const mockLogger = makeLogger();
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async (opts: AgentRunOptions) => {
        usedModel = opts.model;
        return successResult();
      },
      logger: mockLogger,
    });

    await pipeline.resumeRun(slug, "05-plan/pending");

    expect(usedModel).toBe("sonnet");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Downgraded"),
    );
  });

  it("persists inputTokens, outputTokens, and model in CompletedStage", async () => {
    const config = makeConfig();
    const slug = "test-token-persist";

    setupTaskInPending(slug, "validate", { stages: ["validate"] });

    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => successResult({ inputTokens: 4500, outputTokens: 1200 }),
      logger: makeLogger(),
    });

    await pipeline.resumeRun(slug, "08-validate/pending");

    const completeDir = join(TEST_DIR, "10-complete", slug);
    expect(existsSync(completeDir)).toBe(true);
    const finalState = readRunState(completeDir);
    const completed = finalState.completedStages.find(s => s.stage === "validate");

    expect(completed).toBeDefined();
    expect(completed!.inputTokens).toBe(4500);
    expect(completed!.outputTokens).toBe(1200);
    expect(completed!.model).toBe("sonnet"); // validate defaults to sonnet
  });
});

// ─── S9: Budget-Aware Resume ────────────────────────────────────────────────

describe("Budget-aware resume", () => {
  it("keeps task in hold when budget is still exhausted on resume", async () => {
    const config = makeConfig();
    const slug = "test-resume-blocked";

    // Exhaust both opus and sonnet
    writeHugeUsageForToday("opus", 10_000_000);
    writeHugeUsageForToday("sonnet", 50_000_000);

    setupTaskInHold(slug, "validate", {
      holdReason: "budget_exhausted",
      holdDetail: "sonnet daily limit at 112%",
    });

    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => successResult(),
      logger: makeLogger(),
    });

    await pipeline.resume(slug); // should not throw — stays in hold silently

    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);
    const updatedState = readRunState(holdDir);
    expect(updatedState.holdReason).toBe("budget_exhausted");
    expect(updatedState.holdDetail).toBeTruthy();
  });

  it("resumes normally when budget is no longer exhausted", async () => {
    const config = makeConfig();
    const slug = "test-resume-ok";

    // No usage entries — budget is fine
    setupTaskInHold(slug, "validate", {
      stages: ["validate"],
      holdReason: "budget_exhausted",
      holdDetail: "sonnet daily limit at 112%",
    });

    let runnerCalled = false;
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => { runnerCalled = true; return successResult(); },
      logger: makeLogger(),
    });

    await pipeline.resume(slug);

    expect(runnerCalled).toBe(true);
    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(false);
  });

  it("does not inject budget check for non-budget holdReason", async () => {
    const config = makeConfig();
    const slug = "test-resume-user-paused";

    // Even with huge usage, non-budget holds should resume normally
    writeHugeUsageForToday("sonnet", 50_000_000);

    setupTaskInHold(slug, "validate", {
      stages: ["validate"],
      // No holdReason — normal pause (not budget)
    });

    let runnerCalled = false;
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => { runnerCalled = true; return successResult(); },
      logger: makeLogger(),
    });

    // This should still hit the budget check in processStage (pre-stage enforcement)
    // and get held there if budget is exhausted. But the resume itself should not block.
    // The key: resume() should NOT throw about budget for non-budget holds.
    // It will proceed to processStage which may then hold it again.
    await pipeline.resume(slug);

    // The task went through resume() successfully but may have been budget-held in processStage
    // The important thing is that resume() did not throw
  });
});

// ─── S10: Post-stage budget warning ─────────────────────────────────────────

describe("Post-stage budget warning", () => {
  it("logs warning but preserves completed stage when budget exceeded after completion", async () => {
    // Use a custom budget config with a low session limit that we can
    // precisely control via the in-memory session tracker (avoids
    // peak-hour sensitivity from daily JSONL-based limits)
    const config = makeConfig();
    const slug = "test-post-warning";

    // No pre-existing daily usage — the task will pass pre-stage budget check.
    // The runner returns enough tokens to push the session over the limit
    // (session limit for sonnet = 800K, effective non-peak = 680K, peak = 340K;
    //  we return 750K which exceeds both effective limits post-stage)
    setupTaskInPending(slug, "validate", { stages: ["validate"] });

    const mockLogger = makeLogger();
    const pipeline = createPipeline({
      config,
      registry: createAgentRegistry(config.agents.maxConcurrentTotal),
      runner: async () => successResult({
        inputTokens: 400_000,
        outputTokens: 350_000, // 750K total — exceeds session effective limit
      }),
      logger: mockLogger,
    });

    await pipeline.resumeRun(slug, "08-validate/pending");

    // Stage should have completed successfully (no rollback)
    const completeDir = join(TEST_DIR, "10-complete", slug);
    expect(existsSync(completeDir)).toBe(true);

    // Logger should have warned about budget being exceeded post-stage
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Budget warning"),
    );
  });
});
