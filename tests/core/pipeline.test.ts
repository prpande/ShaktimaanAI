import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { parseTaskFile } from "../../src/task/parser.js";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunOptions, type AgentRunResult } from "../../src/core/types.js";
import {
  STAGE_DIR_MAP,
  DIR_STAGE_MAP,
  getNextStage,
  isReviewGate,
  createRunState,
  readRunState,
  writeRunState,
  initTaskDir,
  moveTaskDir,
  createPipeline,
} from "../../src/core/pipeline.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let TEST_DIR: string;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR }, ...overrides }),
  );
}

const SAMPLE_TASK = `# Task: Add logging

## What I want done
Add structured logging to the API layer.

## Context
We need better observability.

## Repo
myorg/myrepo

## ADO Item
AB#1234

## Slack Thread
https://slack.com/thread/123

## Pipeline Config
stages: questions, research, impl, validate, pr
review_after: research
`;

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-pipeline-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── STAGE_DIR_MAP ──────────────────────────────────────────────────────────

describe("STAGE_DIR_MAP", () => {
  it("has 9 entries", () => {
    expect(Object.keys(STAGE_DIR_MAP)).toHaveLength(9);
  });

  it("maps stage names to numbered directory names", () => {
    expect(STAGE_DIR_MAP["questions"]).toBe("01-questions");
    expect(STAGE_DIR_MAP["research"]).toBe("02-research");
    expect(STAGE_DIR_MAP["design"]).toBe("03-design");
    expect(STAGE_DIR_MAP["structure"]).toBe("04-structure");
    expect(STAGE_DIR_MAP["plan"]).toBe("05-plan");
    expect(STAGE_DIR_MAP["impl"]).toBe("06-impl");
    expect(STAGE_DIR_MAP["validate"]).toBe("07-validate");
    expect(STAGE_DIR_MAP["review"]).toBe("08-review");
    expect(STAGE_DIR_MAP["pr"]).toBe("09-pr");
  });
});

// ─── DIR_STAGE_MAP ──────────────────────────────────────────────────────────

describe("DIR_STAGE_MAP", () => {
  it("is correct inverse of STAGE_DIR_MAP", () => {
    for (const [stage, dir] of Object.entries(STAGE_DIR_MAP)) {
      expect(DIR_STAGE_MAP[dir]).toBe(stage);
    }
    expect(Object.keys(DIR_STAGE_MAP)).toHaveLength(9);
  });
});

// ─── getNextStage ───────────────────────────────────────────────────────────

describe("getNextStage", () => {
  const stages = ["questions", "research", "design", "impl"];

  it("returns next stage in sequence", () => {
    expect(getNextStage("questions", stages)).toBe("research");
    expect(getNextStage("research", stages)).toBe("design");
    expect(getNextStage("design", stages)).toBe("impl");
  });

  it("returns null for the last stage", () => {
    expect(getNextStage("impl", stages)).toBeNull();
  });

  it("returns null when stage not found", () => {
    expect(getNextStage("nonexistent", stages)).toBeNull();
  });
});

// ─── isReviewGate ───────────────────────────────────────────────────────────

describe("isReviewGate", () => {
  it("returns true when completedStage matches reviewAfter", () => {
    expect(isReviewGate("design", "design")).toBe(true);
  });

  it("returns false when they do not match", () => {
    expect(isReviewGate("research", "design")).toBe(false);
  });
});

// ─── createRunState ─────────────────────────────────────────────────────────

describe("createRunState", () => {
  it("uses task stages when provided", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(SAMPLE_TASK);
    const state = createRunState("add-logging", taskMeta, config);

    expect(state.slug).toBe("add-logging");
    expect(state.stages).toEqual(["questions", "research", "impl", "validate", "pr"]);
    expect(state.reviewAfter).toBe("research");
    expect(state.status).toBe("running");
    expect(state.currentStage).toBe("");
    expect(state.completedStages).toEqual([]);
  });

  it("falls back to config defaults when task has no stages", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(`# Task: Simple task\n\n## What I want done\nDo the thing.\n`);
    const state = createRunState("simple-task", taskMeta, config);

    // defaults from DEFAULT_CONFIG
    expect(state.stages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(state.reviewAfter).toBe("design");
  });

  it("sets startedAt and updatedAt as ISO strings", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(SAMPLE_TASK);
    const before = new Date().toISOString();
    const state = createRunState("add-logging", taskMeta, config);
    const after = new Date().toISOString();

    expect(state.startedAt >= before).toBe(true);
    expect(state.startedAt <= after).toBe(true);
    expect(state.updatedAt >= before).toBe(true);
    expect(state.updatedAt <= after).toBe(true);
  });
});

// ─── readRunState / writeRunState ───────────────────────────────────────────

describe("readRunState / writeRunState", () => {
  it("round-trips through JSON", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(SAMPLE_TASK);
    const state = createRunState("add-logging", taskMeta, config);

    const taskDir = join(TEST_DIR, "task-dir");
    mkdirSync(taskDir, { recursive: true });

    writeRunState(taskDir, state);

    const raw = JSON.parse(readFileSync(join(taskDir, "run-state.json"), "utf-8"));
    expect(raw.slug).toBe("add-logging");

    const loaded = readRunState(taskDir);
    expect(loaded.slug).toBe(state.slug);
    expect(loaded.stages).toEqual(state.stages);
    expect(loaded.reviewAfter).toBe(state.reviewAfter);
    expect(loaded.status).toBe(state.status);
    expect(loaded.completedStages).toEqual(state.completedStages);
  });

  it("writeRunState updates updatedAt", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(SAMPLE_TASK);
    const state = createRunState("add-logging", taskMeta, config);
    const originalUpdatedAt = state.updatedAt;

    const taskDir = join(TEST_DIR, "task-dir-2");
    mkdirSync(taskDir, { recursive: true });

    // Small delay to ensure timestamp difference
    state.currentStage = "questions";
    writeRunState(taskDir, state);

    const loaded = readRunState(taskDir);
    expect(loaded.currentStage).toBe("questions");
    // updatedAt should be >= the original
    expect(loaded.updatedAt >= originalUpdatedAt).toBe(true);
  });
});

// ─── initTaskDir ────────────────────────────────────────────────────────────

describe("initTaskDir", () => {
  it("creates dir structure with task.task and artifacts/", () => {
    // Write a sample task file to disk
    const taskFilePath = join(TEST_DIR, "my-task.task");
    writeFileSync(taskFilePath, SAMPLE_TASK, "utf-8");

    const taskDir = initTaskDir(TEST_DIR, "add-logging", "01-questions", taskFilePath);

    expect(taskDir).toBe(join(TEST_DIR, "01-questions", "pending", "add-logging"));
    expect(existsSync(join(taskDir, "artifacts"))).toBe(true);
    expect(existsSync(join(taskDir, "task.task"))).toBe(true);

    const copied = readFileSync(join(taskDir, "task.task"), "utf-8");
    expect(copied).toBe(SAMPLE_TASK);
  });
});

// ─── moveTaskDir ────────────────────────────────────────────────────────────

describe("moveTaskDir", () => {
  it("moves atomically and creates dest parent", () => {
    // Set up source
    const srcParent = join(TEST_DIR, "01-questions", "pending");
    const srcDir = join(srcParent, "add-logging");
    mkdirSync(join(srcDir, "artifacts"), { recursive: true });
    writeFileSync(join(srcDir, "task.task"), "hello", "utf-8");

    const newPath = moveTaskDir(
      TEST_DIR, "add-logging",
      join("01-questions", "pending"),
      join("01-questions", "active"),
    );

    expect(newPath).toBe(join(TEST_DIR, "01-questions", "active", "add-logging"));
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(join(newPath, "task.task"))).toBe(true);
    expect(existsSync(srcDir)).toBe(false);
  });
});

// ─── createPipeline integration tests ──────────────────────────────────────

function createStubRunner(behavior: "success" | "fail" = "success") {
  return async (options: AgentRunOptions): Promise<AgentRunResult> => {
    if (behavior === "success" && options.outputPath) {
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, `Stub output for ${options.stage}`);
    }
    return {
      success: behavior === "success",
      output: behavior === "success" ? `Output for ${options.stage}` : "",
      costUsd: 0.001,
      turns: 2,
      durationMs: 50,
      error: behavior === "fail" ? "Stub failure" : undefined,
    };
  };
}

function makeSimpleTask(stages: string, reviewAfter?: string): string {
  let task = `# Task: Test task

## What I want done
Do the thing.

## Pipeline Config
stages: ${stages}
`;
  if (reviewAfter) {
    task += `review_after: ${reviewAfter}\n`;
  }
  return task;
}

describe("createPipeline", () => {
  it("runs two stages to completion", async () => {
    createRuntimeDirs(TEST_DIR);
    // Create stub templates
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-research.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, research");
    const inboxPath = join(TEST_DIR, "00-inbox", "test-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // inbox file should be gone
    expect(existsSync(inboxPath)).toBe(false);

    // task should be in 10-complete
    const completeDir = join(TEST_DIR, "10-complete", "test-task");
    expect(existsSync(completeDir)).toBe(true);

    const finalState = readRunState(completeDir);
    expect(finalState.status).toBe("complete");
    expect(finalState.completedStages).toHaveLength(2);

    // registry should be empty
    expect(registry.getActiveCount()).toBe(0);
  });

  it("pauses at review gate", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "gate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // task should be in 12-hold
    const holdDir = join(TEST_DIR, "12-hold", "gate-task");
    expect(existsSync(holdDir)).toBe(true);

    const state = readRunState(holdDir);
    expect(state.status).toBe("hold");
    expect(state.completedStages).toHaveLength(2);
  });

  it("resumes from hold after approval", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "resume-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // Should be in hold
    expect(existsSync(join(TEST_DIR, "12-hold", "resume-task"))).toBe(true);

    await pipeline.approveAndResume("resume-task", "Looks good, proceed!");

    // Should now be in 10-complete
    const completeDir = join(TEST_DIR, "10-complete", "resume-task");
    expect(existsSync(completeDir)).toBe(true);

    const finalState = readRunState(completeDir);
    expect(finalState.status).toBe("complete");
    expect(finalState.completedStages).toHaveLength(3);

    // review-feedback.md should exist
    const feedbackFile = join(completeDir, "artifacts", "review-feedback.md");
    expect(existsSync(feedbackFile)).toBe(true);
    expect(readFileSync(feedbackFile, "utf-8")).toBe("Looks good, proceed!");
  });

  it("moves to failed on agent failure", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, research");
    const inboxPath = join(TEST_DIR, "00-inbox", "fail-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("fail"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // task should be in 11-failed
    const failedDir = join(TEST_DIR, "11-failed", "fail-task");
    expect(existsSync(failedDir)).toBe(true);

    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toBeDefined();
  });

  it("throws on approve of non-existent task", async () => {
    createRuntimeDirs(TEST_DIR);

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(pipeline.approveAndResume("nonexistent")).rejects.toThrow(/not found in hold/);
  });

  it("reports active runs", async () => {
    createRuntimeDirs(TEST_DIR);
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "active-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    const activeRuns = pipeline.getActiveRuns();
    expect(activeRuns).toHaveLength(1);
    expect(activeRuns[0].status).toBe("hold");
  });
});
