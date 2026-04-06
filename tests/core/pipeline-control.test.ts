import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunOptions, type AgentRunResult, type RunState } from "../../src/core/types.js";
import {
  STAGE_DIR_MAP,
  readRunState,
  writeRunState,
  createPipeline,
} from "../../src/core/pipeline.js";
import type { Notifier, NotifyEvent } from "../../src/surfaces/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let TEST_DIR: string;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR }, ...overrides }),
  );
}

const noopRunner = async (_opts: AgentRunOptions): Promise<AgentRunResult> => ({
  success: true,
  output: "done",
  costUsd: 0,
  turns: 1,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 100,
});

const noopLogger = {
  info(_msg: string) {},
  warn(_msg: string) {},
  error(_msg: string) {},
};

function makeRunState(slug: string, overrides: Partial<RunState> = {}): RunState {
  return {
    slug,
    taskFile: "task.task",
    stages: ["questions", "research", "impl"],
    reviewAfter: "research",
    currentStage: "questions",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: [],
    validateRetryCount: 0,
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    ...overrides,
  };
}

function setupTaskInDir(slug: string, subdir: string, stateOverrides: Partial<RunState> = {}): string {
  const taskDir = join(TEST_DIR, subdir, slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  writeFileSync(join(taskDir, "task.task"), "# Task: test\n\n## What I want done\nTest task.\n", "utf-8");
  const state = makeRunState(slug, stateOverrides);
  writeRunState(taskDir, state);
  return taskDir;
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-pipe-ctrl-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── cancel ────────────────────────────────────────────────────────────────

describe("cancel", () => {
  it("moves active task to 11-failed", async () => {
    const slug = "cancel-active";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await pipeline.cancel(slug);

    const failedDir = join(TEST_DIR, "11-failed", slug);
    expect(existsSync(failedDir)).toBe(true);
    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("Cancelled by user");
  });

  it("moves held task to 11-failed", async () => {
    const slug = "cancel-held";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "research",
      status: "hold",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await pipeline.cancel(slug);

    const failedDir = join(TEST_DIR, "11-failed", slug);
    expect(existsSync(failedDir)).toBe(true);
    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("Cancelled by user");
  });
});

// ─── skip ──────────────────────────────────────────────────────────────────

describe("skip", () => {
  it("advances task to the next stage directory", async () => {
    const slug = "skip-advance";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
      stages: ["questions", "research", "impl"],
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    // runner that records calls but returns success immediately
    const runnerCalls: string[] = [];
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      runnerCalls.push(opts.stage);
      return { success: true, output: "done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 50 };
    };
    const pipeline = createPipeline({ config, registry, runner: trackingRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.skip(slug);

    // Task should have moved to research/pending (the next stage)
    const researchDir = join(TEST_DIR, STAGE_DIR_MAP["research"], "pending", slug);
    // It may have already advanced further since processStage resumes — check state
    expect(events.some(e => e.type === "stage_skipped")).toBe(true);

    // The runner should have been called for the next stage (research), not questions
    expect(runnerCalls[0]).toBe("research");
    expect(runnerCalls).not.toContain("questions");
  });

  it("throws when there is no next stage to skip to", async () => {
    const slug = "skip-last";
    const stageDir = STAGE_DIR_MAP["impl"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "impl",
      status: "running",
      stages: ["impl"],
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.skip(slug)).rejects.toThrow(/No stage after/);
  });
});

// ─── pause ─────────────────────────────────────────────────────────────────

describe("pause", () => {
  it("moves active task to 12-hold with pausedAtStage", async () => {
    const slug = "pause-active";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await pipeline.pause(slug);

    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);
    const state = readRunState(holdDir);
    expect(state.status).toBe("hold");
    expect(state.pausedAtStage).toBe("questions");
  });
});

// ─── modifyStages ──────────────────────────────────────────────────────────

describe("modifyStages", () => {
  it("updates stages in RunState", async () => {
    const slug = "modify-stages";
    const stageDir = STAGE_DIR_MAP["questions"];
    const taskDir = setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
      stages: ["questions", "research", "impl"],
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await pipeline.modifyStages(slug, ["questions", "impl", "pr"]);

    const state = readRunState(taskDir);
    expect(state.stages).toEqual(["questions", "impl", "pr"]);
  });

  it("throws when newStages is empty", async () => {
    const slug = "modify-stages-empty";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.modifyStages(slug, [])).rejects.toThrow("Cannot set empty stage list");
  });

  it("throws when newStages contains invalid stage names", async () => {
    const slug = "modify-stages-invalid";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.modifyStages(slug, ["questions", "bogus", "notastage"])).rejects.toThrow(
      /Invalid stage names: bogus, notastage/,
    );
  });

  it("throws when newStages contains duplicates", async () => {
    const slug = "modify-stages-dupes";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.modifyStages(slug, ["questions", "impl", "impl"])).rejects.toThrow(
      /Duplicate stage names: impl/,
    );
  });
});

// ─── resume ────────────────────────────────────────────────────────────────

describe("resume", () => {
  it("errors on non-paused task (missing pausedAtStage)", async () => {
    const slug = "resume-no-pause";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "research",
      status: "hold",
      // no pausedAtStage — this was a review gate hold, not a pause
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.resume(slug)).rejects.toThrow("use approve");
  });
});

// ─── restartStage / retry — unmapped stage guard ───────────────────────────

describe("restartStage — unmapped stage guard", () => {
  it("throws a descriptive error when the target stage has no directory mapping", async () => {
    const slug = "restart-unmapped";
    // Place task in 12-hold with currentStage = "quick" (no STAGE_DIR_MAP entry)
    setupTaskInDir(slug, "12-hold", {
      currentStage: "quick",
      stages: ["quick"],
      status: "hold",
    });

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.restartStage(slug)).rejects.toThrow(
      /Cannot restartStage stage "quick" — no stage directory mapping exists/,
    );
  });
});

describe("retry — versioned artifact naming", () => {
  it("writes versioned feedback artifact and increments retryAttempts", async () => {
    const slug = "retry-versioned";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "research",
      status: "hold",
      stages: ["questions", "research", "impl"],
      reviewAfter: "research",
      retryAttempts: {},
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.retry(slug, "Please add more detail on the auth flow");

    // stage_retried event should have been emitted with attempt=1
    const retriedEvent = events.find(e => e.type === "stage_retried") as
      { type: "stage_retried"; slug: string; stage: string; attempt: number; feedback: string } | undefined;
    expect(retriedEvent).toBeDefined();
    expect(retriedEvent!.stage).toBe("research");
    expect(retriedEvent!.attempt).toBe(1);
    expect(retriedEvent!.feedback).toBe("Please add more detail on the auth flow");

    // After retry + processStage (noopRunner succeeds), the task advances through research
    // and hits the review gate at "research", landing in 12-hold.
    // The feedback artifact travels with the directory.
    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);

    const feedbackPath = join(holdDir, "artifacts", "retry-feedback-research-1.md");
    expect(existsSync(feedbackPath)).toBe(true);
    const feedbackContent = readFileSync(feedbackPath, "utf-8");
    expect(feedbackContent).toBe("Please add more detail on the auth flow");

    const state = readRunState(holdDir);
    expect(state.retryAttempts["research"]).toBe(1);
  });

  it("increments retryAttempts on subsequent retries", async () => {
    const slug = "retry-multi";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "research",
      status: "hold",
      stages: ["questions", "research", "impl"],
      reviewAfter: "research",
      retryAttempts: { research: 2 },
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.retry(slug, "Third attempt feedback");

    const retriedEvent = events.find(e => e.type === "stage_retried") as
      { type: "stage_retried"; attempt: number } | undefined;
    expect(retriedEvent).toBeDefined();
    expect(retriedEvent!.attempt).toBe(3);

    // Task advances through research and hits review gate, landing in hold
    const holdDir = join(TEST_DIR, "12-hold", slug);
    expect(existsSync(holdDir)).toBe(true);

    const feedbackPath = join(holdDir, "artifacts", "retry-feedback-research-3.md");
    expect(existsSync(feedbackPath)).toBe(true);

    const state = readRunState(holdDir);
    expect(state.retryAttempts["research"]).toBe(3);
  });
});

describe("retry — unmapped stage guard", () => {
  it("throws a descriptive error when the current stage has no directory mapping", async () => {
    const slug = "retry-unmapped";
    // Place task in 12-hold with currentStage = "quick" (no STAGE_DIR_MAP entry)
    const holdTaskDir = join(TEST_DIR, "12-hold", slug);
    mkdirSync(join(holdTaskDir, "artifacts"), { recursive: true });
    writeFileSync(join(holdTaskDir, "task.task"), "# Task: test\n\n## What I want done\nTest task.\n", "utf-8");
    const state = makeRunState(slug, {
      currentStage: "quick",
      stages: ["quick"],
      status: "hold",
    });
    writeRunState(holdTaskDir, state);

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });

    await expect(pipeline.retry(slug, "please fix the thing")).rejects.toThrow(
      /Cannot retry stage "quick" — no stage directory mapping exists/,
    );
  });
});

// ─── approveAndResume ──────────────────────────────────────────────────────

describe("approveAndResume", () => {
  it("emits task_approved event", async () => {
    const slug = "approve-notify";
    setupTaskInDir(slug, "12-hold", {
      currentStage: "questions",
      status: "hold",
      stages: ["questions", "research", "impl"],
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.approveAndResume(slug, "looks good");

    expect(events.some(e => e.type === "task_approved")).toBe(true);
    const approved = events.find(e => e.type === "task_approved")!;
    expect(approved).toMatchObject({
      type: "task_approved",
      slug: "approve-notify",
      approvedBy: "user",
    });
  });
});

// ─── addNotifier & event emissions ─────────────────────────────────────────

describe("addNotifier", () => {
  it("emits task_cancelled event on cancel", async () => {
    const slug = "notify-cancel";
    const stageDir = STAGE_DIR_MAP["questions"];
    setupTaskInDir(slug, join(stageDir, "pending"), {
      currentStage: "questions",
      status: "running",
    });

    const events: NotifyEvent[] = [];
    const testNotifier: Notifier = {
      async notify(event: NotifyEvent) { events.push(event); },
    };

    const config = makeConfig();
    const registry = createAgentRegistry(5);
    const pipeline = createPipeline({ config, registry, runner: noopRunner, logger: noopLogger });
    pipeline.addNotifier(testNotifier);

    await pipeline.cancel(slug);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.type === "task_cancelled")).toBe(true);
  });
});
