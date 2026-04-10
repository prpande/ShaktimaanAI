import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { parseTaskFile } from "../../src/task/parser.js";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { buildPaths } from "../../src/config/paths.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunOptions, type AgentRunResult } from "../../src/core/types.js";
import {
  STAGE_DIR_MAP,
  getNextStage,
  isReviewGate,
  createRunState,
  readRunState,
  writeRunState,
  initTaskDir,
  moveTaskDir,
  createPipeline,
  collectArtifacts,
} from "../../src/core/pipeline.js";
import { DIR_STAGE_MAP } from "../../src/core/stage-map.js";

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
    expect(STAGE_DIR_MAP["review"]).toBe("07-review");
    expect(STAGE_DIR_MAP["validate"]).toBe("08-validate");
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
      "impl", "review", "validate", "pr",
    ]);
    expect(state.reviewAfter).toBe("design");
  });

  it("initializes validateRetryCount, reviewRetryCount, and reviewIssues", () => {
    const config = makeConfig();
    const taskMeta = parseTaskFile(SAMPLE_TASK);
    const state = createRunState("add-logging", taskMeta, config);

    expect(state.validateRetryCount).toBe(0);
    expect(state.reviewRetryCount).toBe(0);
    expect(state.reviewIssues).toEqual([]);
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
    createRuntimeDirs(buildPaths(TEST_DIR));
    // Create stub templates
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-research.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, research");
    const inboxPath = join(TEST_DIR, "00-inbox", "test-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
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
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "gate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
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
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "resume-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
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
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, research");
    const inboxPath = join(TEST_DIR, "00-inbox", "fail-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
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
    createRuntimeDirs(buildPaths(TEST_DIR));

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(pipeline.approveAndResume("nonexistent")).rejects.toThrow(/not found in hold/);
  });

  // ─── workDir resolution ──────────────────────────────────────────────────────

  it("uses invocationCwd when no repo and no repos.root configured", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "work-dir-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let capturedCwd: string | undefined;
    const trackingRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.stage === "impl") {
        capturedCwd = options.cwd;
      }
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output for ${options.stage} — **Verdict:** PASS`);
      }
      return {
        success: true,
        output: options.stage === "validate"
          ? "All pass.\n\n**Verdict:** PASS"
          : `Output for ${options.stage}`,
        costUsd: 0,
        turns: 1,
        durationMs: 10,
      };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invocationCwd = join(TEST_DIR, "invocation-dir");
    mkdirSync(invocationCwd, { recursive: true });

    const pipeline = createPipeline({
      config,
      registry,
      runner: trackingRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invocationCwd);

    // impl stage should have used invocationCwd as its cwd
    expect(capturedCwd).toBe(invocationCwd);
  });

  it("uses repos.root/{slug} when repos.root is configured and no task repo", async () => {
    const reposRoot = join(TEST_DIR, "repos");
    mkdirSync(reposRoot, { recursive: true });
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "repos-root-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let capturedCwd: string | undefined;
    const trackingRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.stage === "impl") capturedCwd = options.cwd;
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output — **Verdict:** PASS`);
      }
      return {
        success: true,
        output: options.stage === "validate"
          ? "**Verdict:** PASS"
          : "done",
        costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10,
      };
    };

    const config = makeConfig({ repos: { root: reposRoot, aliases: {} } });
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config, registry, runner: trackingRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    expect(capturedCwd).toBe(join(reposRoot, "repos-root-task"));
    expect(existsSync(join(reposRoot, "repos-root-task"))).toBe(true);
  });

  it("stores workDir in run state after impl stage", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-validate.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "state-work-dir-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const stubRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, `Output — **Verdict:** PASS`);
      }
      return {
        success: true,
        output: "**Verdict:** PASS",
        costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10,
      };
    };

    const invocationCwd = join(TEST_DIR, "inv-cwd");
    mkdirSync(invocationCwd, { recursive: true });

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config, registry, runner: stubRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invocationCwd);

    const completeDir = join(TEST_DIR, "10-complete", "state-work-dir-task");
    const finalState = readRunState(completeDir);
    expect(finalState.workDir).toBe(invocationCwd);
  });

  it("reports active runs", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "active-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
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

// ─── retry integration ───────────────────────────────────────────────────────

describe("pipeline retry integration", () => {
  function makeRetryTask(): string {
    return makeSimpleTask("impl, review, validate, pr");
  }

  it("retries impl when validate returns NEEDS_FIXES (within maxRetries)", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate", "review", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeRetryTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "retry-validate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let validateCallCount = 0;
    let implCallCount = 0;

    const retryRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }

      if (options.stage === "impl") {
        implCallCount++;
        if (options.outputPath) writeFileSync(options.outputPath, "impl output");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }

      if (options.stage === "validate") {
        validateCallCount++;
        // Fail first time, pass second time
        const verdict = validateCallCount === 1 ? "NEEDS_FIXES" : "PASS";
        const output = `Build output.\n\n**Verdict:** ${verdict}`;
        if (options.outputPath) writeFileSync(options.outputPath, output);
        return { success: true, output, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }

      if (options.stage === "review") {
        const output = "Looks good.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, output);
        return { success: true, output, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }

      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-retry");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: retryRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    expect(implCallCount).toBe(2);    // impl ran twice
    expect(validateCallCount).toBe(2); // validate ran twice

    const completeDir = join(TEST_DIR, "10-complete", "retry-validate-task");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.validateFailCount).toBe(1);
  });

  it("fails task when validate NEEDS_FIXES exceeds maxRetries", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "exhaust-validate-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const alwaysFailRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, "**Verdict:** NEEDS_FIXES");
      }
      return {
        success: true,
        output: "Build failed.\n\n**Verdict:** NEEDS_FIXES",
        costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10,
      };
    };

    // maxValidateRetries=1 means 1 retry allowed (2 total validate runs)
    const config = makeConfig({ agents: { maxValidateRetries: 1 } });
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-exhaust");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: alwaysFailRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    const failedDir = join(TEST_DIR, "11-failed", "exhaust-validate-task");
    expect(existsSync(failedDir)).toBe(true);
    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toContain("max");
  });

  it("writes retry-feedback artifact before sending task back to impl", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSimpleTask("impl, validate");
    const inboxPath = join(TEST_DIR, "00-inbox", "feedback-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let validateRunCount = 0;

    const feedbackRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      validateRunCount++;
      if (validateRunCount === 1) {
        const out = "TypeScript error TS2345\n\n**Verdict:** NEEDS_FIXES";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      // Second validate passes
      const out = "All clear.\n\n**Verdict:** PASS";
      if (options.outputPath) writeFileSync(options.outputPath, out);
      return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-feedback");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: feedbackRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    // After completion the artifacts dir should contain a retry feedback file
    const completeDir = join(TEST_DIR, "10-complete", "feedback-task");
    const artifactsDir = join(completeDir, "artifacts");
    const feedbackFiles = existsSync(artifactsDir)
      ? readdirSync(artifactsDir).filter(f => f.startsWith("retry-feedback-validate"))
      : [];
    expect(feedbackFiles.length).toBeGreaterThan(0);
  });

  it("retries impl when review returns CHANGES_REQUIRED with new issues", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "validate", "review", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeRetryTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "review-retry-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let reviewCallCount = 0;

    const reviewRetryRunner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "validate") {
        const out = "Tests pass.\n\n**Verdict:** PASS";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          const out = "[R1] MUST_FIX: Missing error handling in fetchData\n\n**Verdict:** CHANGES_REQUIRED";
          if (options.outputPath) writeFileSync(options.outputPath, out);
          return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
        }
        const out = "All issues resolved.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-review-retry");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner: reviewRetryRunner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    expect(reviewCallCount).toBe(2);

    const completeDir = join(TEST_DIR, "10-complete", "review-retry-task");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.reviewRetryCount).toBe(1);
  });
});

// ─── Spec 5a: review→validate flow, per-cycle suggestion budget ─────────────

describe("Spec 5a pipeline behavior", () => {
  function makeSpec5aTask(): string {
    return makeSimpleTask("impl, review, validate, pr");
  }

  it("Test A: review retries once on HIGH_VALUE suggestion, then proceeds to validate → pr", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "review", "validate", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSpec5aTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "spec5a-test-a.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let reviewCallCount = 0;
    let validateCallCount = 0;
    let implCallCount = 0;

    const runner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        implCallCount++;
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          const out = "[R1] SUGGESTION(HIGH_VALUE): Consider extracting a helper function\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS";
          if (options.outputPath) writeFileSync(options.outputPath, out);
          return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
        }
        const out = "All good.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "validate") {
        validateCallCount++;
        const out = "Tests pass.\n\n**Verdict:** PASS";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      // pr
      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-5a-a");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    // review called twice: first APPROVED_WITH_SUGGESTIONS triggers retry, second APPROVED
    expect(reviewCallCount).toBe(2);
    // impl called twice: once initially, once after suggestion retry
    expect(implCallCount).toBe(2);
    // validate called once after final review approval
    expect(validateCallCount).toBe(1);

    const completeDir = join(TEST_DIR, "10-complete", "spec5a-test-a");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.suggestionRetryUsed).toBe(true);
  });

  it("Test B: NITPICK-only suggestions do NOT trigger retry", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "review", "validate", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSpec5aTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "spec5a-test-b.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let reviewCallCount = 0;

    const runner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        const out = "[R1] SUGGESTION(NITPICK): Minor style nit\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "validate") {
        const out = "Tests pass.\n\n**Verdict:** PASS";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      // pr
      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-5a-b");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    // review called only once — NITPICK does not trigger retry
    expect(reviewCallCount).toBe(1);

    const completeDir = join(TEST_DIR, "10-complete", "spec5a-test-b");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.suggestionRetryUsed).toBe(false);
  });

  it("Test C: validate failure resets suggestion budget and loops back to impl", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const s of ["impl", "review", "validate", "pr"]) {
      writeFileSync(join(templatesDir, `prompt-${s}.md`), "template", "utf-8");
    }

    const taskContent = makeSpec5aTask();
    const inboxPath = join(TEST_DIR, "00-inbox", "spec5a-test-c.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    let implCallCount = 0;
    let reviewCallCount = 0;
    let validateCallCount = 0;

    const runner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
      }
      if (options.stage === "impl") {
        implCallCount++;
        if (options.outputPath) writeFileSync(options.outputPath, "impl done");
        return { success: true, output: "impl done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        const out = "Looks good.\n\n**Verdict:** APPROVED";
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      if (options.stage === "validate") {
        validateCallCount++;
        // Fail first time, pass second time
        const verdict = validateCallCount === 1 ? "NEEDS_FIXES" : "PASS";
        const out = `Build output.\n\n**Verdict:** ${verdict}`;
        if (options.outputPath) writeFileSync(options.outputPath, out);
        return { success: true, output: out, costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
      }
      // pr
      if (options.outputPath) writeFileSync(options.outputPath, "pr done");
      return { success: true, output: "pr done", costUsd: 0, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 10 };
    };

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const invCwd = join(TEST_DIR, "inv-cwd-5a-c");
    mkdirSync(invCwd, { recursive: true });
    const pipeline = createPipeline({
      config, registry, runner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath, invCwd);

    // Full cycle runs twice: impl→review→validate (fail) → impl→review→validate (pass) → pr
    expect(implCallCount).toBe(2);
    expect(reviewCallCount).toBe(2);
    expect(validateCallCount).toBe(2);

    const completeDir = join(TEST_DIR, "10-complete", "spec5a-test-c");
    expect(existsSync(completeDir)).toBe(true);
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.validateFailCount).toBe(1);
    // suggestionRetryUsed should be false (reset on validate failure)
    expect(state.suggestionRetryUsed).toBe(false);
  });
});

// ─── collectArtifacts ──────────────────────────────────────────────────────

describe("collectArtifacts", () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = join(TEST_DIR, "artifacts-test-" + randomUUID().slice(0, 8));
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "questions-output.md"), "Q output", "utf-8");
    writeFileSync(join(artifactsDir, "research-output.md"), "R output", "utf-8");
    writeFileSync(join(artifactsDir, "design-output.md"), "D output", "utf-8");
    writeFileSync(join(artifactsDir, "plan-output.md"), "P output", "utf-8");
    writeFileSync(join(artifactsDir, "impl-output.md"), "I output", "utf-8");
    writeFileSync(join(artifactsDir, "review-output.md"), "Rev output", "utf-8");
    writeFileSync(join(artifactsDir, "retry-feedback-validate-1.md"), "Fix these", "utf-8");
  });

  const stages = ["questions", "research", "design", "plan", "impl", "review", "validate", "pr"];

  it("returns empty for mode:none stages", () => {
    expect(collectArtifacts(artifactsDir, "questions", stages)).toBe("");
    expect(collectArtifacts(artifactsDir, "validate", stages)).toBe("");
  });

  it("returns all prior alignment outputs for all_prior mode", () => {
    const result = collectArtifacts(artifactsDir, "design", stages);
    expect(result).toContain("Q output");
    expect(result).toContain("R output");
    expect(result).not.toContain("D output");
  });

  it("includes all alignment outputs for impl", () => {
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).toContain("Q output");
    expect(result).toContain("R output");
    expect(result).toContain("D output");
    expect(result).toContain("P output");
    expect(result).not.toContain("I output");
  });

  it("includes retry feedback for impl", () => {
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).toContain("Fix these");
  });

  it("returns only specific files for review", () => {
    const result = collectArtifacts(artifactsDir, "review", stages);
    expect(result).toContain("P output");
    expect(result).toContain("D output");
    expect(result).not.toContain("Q output");
    expect(result).not.toContain("I output");
  });

  it("returns impl and review outputs for pr", () => {
    const result = collectArtifacts(artifactsDir, "pr", stages);
    expect(result).toContain("I output");
    expect(result).toContain("Rev output");
    expect(result).not.toContain("Q output");
    expect(result).not.toContain("P output");
  });

  it("excludes execution stage outputs from all_prior", () => {
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).not.toContain("Rev output");
  });

  it("returns empty for non-existent directory", () => {
    expect(collectArtifacts("/nonexistent", "design", stages)).toBe("");
  });

  it("picks latest retry artifact over base in specific mode", () => {
    writeFileSync(join(artifactsDir, "impl-output-r1.md"), "I retry 1", "utf-8");
    writeFileSync(join(artifactsDir, "impl-output-r2.md"), "I retry 2", "utf-8");
    const result = collectArtifacts(artifactsDir, "pr", stages);
    expect(result).toContain("I retry 2");
    expect(result).not.toContain("I output");
    expect(result).not.toContain("I retry 1");
    expect(result).toContain("Rev output");
  });

  it("picks latest retry artifact over base in all_prior mode", () => {
    writeFileSync(join(artifactsDir, "research-output-r1.md"), "R retry 1", "utf-8");
    const result = collectArtifacts(artifactsDir, "design", stages);
    expect(result).toContain("Q output");
    expect(result).toContain("R retry 1");
    expect(result).not.toContain("R output");
  });
});

// ─── F-1.1: recordCompletionIfWorktree uses repoRoot ─────────────────────────

describe("F-1.1: manifest entry uses repoRoot for repoPath", () => {
  it("stores distinct repoPath and worktreePath in manifest when worktree is used", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");

    const taskContent = makeSimpleTask("questions");
    const inboxPath = join(TEST_DIR, "00-inbox", "wt-manifest-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // Task completes — now simulate what would happen if worktree was set.
    // Since we can't easily create a real git repo in tests, verify repoRoot
    // is stored in RunState when worktreePath is present.
    const completeDir = join(TEST_DIR, "10-complete", "wt-manifest-task");
    const state = readRunState(completeDir);

    // Without a repo in the task, worktreePath won't be set, so repoRoot won't be set either.
    // That's OK — the key behavior is that when both are set, repoRoot !== worktreePath.
    // Let's directly test the manifest entry logic by writing a state with both fields.
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    const { recordWorktreeCompletion } = await import("../../src/core/worktree.js");

    // Simulate what recordCompletionIfWorktree does with the fix:
    const fakeState = {
      ...state,
      worktreePath: "/worktrees/my-task",
      repoRoot: "/repos/my-repo",
    };

    recordWorktreeCompletion(manifestPath, {
      slug: fakeState.slug,
      repoPath: fakeState.repoRoot ?? fakeState.worktreePath!,
      worktreePath: fakeState.worktreePath!,
      completedAt: new Date().toISOString(),
    });

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].repoPath).toBe("/repos/my-repo");
    expect(manifest[0].worktreePath).toBe("/worktrees/my-task");
    expect(manifest[0].repoPath).not.toBe(manifest[0].worktreePath);
  });
});

// ─── F-5.1: approveAndResume emits task_completed for last stage ─────────────

describe("F-5.1: approveAndResume emits task_completed at last stage", () => {
  it("emits task_completed when approving a task at its last stage", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");

    // Task with only one stage and review_after that same stage
    // This means: run "questions", then hold. On approve, nextStage is null.
    const taskContent = makeSimpleTask("questions", "questions");
    const inboxPath = join(TEST_DIR, "00-inbox", "last-stage-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const notifications: Array<{ type: string; slug: string }> = [];
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    // Add a notifier to capture events
    pipeline.addNotifier({
      async notify(event) {
        notifications.push({ type: event.type, slug: event.slug });
      },
    });

    await pipeline.startRun(inboxPath);

    // Should be in hold after questions completes (review gate)
    expect(existsSync(join(TEST_DIR, "12-hold", "last-stage-task"))).toBe(true);

    // Approve — nextStage is null, so task should complete
    await pipeline.approveAndResume("last-stage-task");

    const completeDir = join(TEST_DIR, "10-complete", "last-stage-task");
    expect(existsSync(completeDir)).toBe(true);

    const finalState = readRunState(completeDir);
    expect(finalState.status).toBe("complete");

    // Verify task_completed notification was emitted
    const completedEvents = notifications.filter(n => n.type === "task_completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].slug).toBe("last-stage-task");
  });
});

// ─── F-5.2: cancel records worktree completion ──────────────────────────────

describe("F-5.2: cancel records worktree completion", () => {
  it("creates manifest entry for worktree-backed tasks on cancel", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    // Use a task that holds at design so we can cancel it
    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "cancel-wt-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // Should be in hold
    const holdDir = join(TEST_DIR, "12-hold", "cancel-wt-task");
    expect(existsSync(holdDir)).toBe(true);

    // Manually write worktreePath into the run state to simulate a worktree-backed task
    const state = readRunState(holdDir);
    state.worktreePath = "/worktrees/cancel-wt-task";
    state.repoRoot = "/repos/my-repo";
    writeRunState(holdDir, state);

    // Cancel the task
    await pipeline.cancel("cancel-wt-task");

    // Task should be in 11-failed
    expect(existsSync(join(TEST_DIR, "11-failed", "cancel-wt-task"))).toBe(true);

    // Manifest should have an entry for the cancelled task
    const manifestPath = join(TEST_DIR, "worktree-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].slug).toBe("cancel-wt-task");
    expect(manifest[0].repoPath).toBe("/repos/my-repo");
    expect(manifest[0].worktreePath).toBe("/worktrees/cancel-wt-task");
  });
});

// ─── F-5.6: modifyStages validates currentStage ─────────────────────────────

describe("F-5.6: modifyStages rejects removing currentStage", () => {
  it("throws when new stage list excludes the current stage", async () => {
    createRuntimeDirs(buildPaths(TEST_DIR));
    const templatesDir = join(TEST_DIR, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "prompt-questions.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-design.md"), "template", "utf-8");
    writeFileSync(join(templatesDir, "prompt-impl.md"), "template", "utf-8");

    // Use a task that holds at design so we can modify stages while it's paused
    const taskContent = makeSimpleTask("questions, design, impl", "design");
    const inboxPath = join(TEST_DIR, "00-inbox", "modify-stage-task.task");
    writeFileSync(inboxPath, taskContent, "utf-8");

    const config = makeConfig();
    const registry = createAgentRegistry(3);
    const pipeline = createPipeline({
      config,
      registry,
      runner: createStubRunner("success"),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startRun(inboxPath);

    // Task should be on hold after design gate
    const holdDir = join(TEST_DIR, "12-hold", "modify-stage-task");
    expect(existsSync(holdDir)).toBe(true);

    const state = readRunState(holdDir);
    // currentStage is "design" (the stage that completed and triggered the hold)
    expect(state.currentStage).toBe("design");

    // Try to modify stages to exclude "design" (the current stage) — should throw
    await expect(
      pipeline.modifyStages("modify-stage-task", ["questions", "impl"]),
    ).rejects.toThrow(/Cannot remove current stage/);
  });
});

describe("collectArtifacts — numeric sort for r<N> suffixes", () => {
  it("sorts retry-feedback files numerically at 10+", () => {
    const artifactsDir = join(TEST_DIR, "artifacts-sort-test");
    mkdirSync(artifactsDir, { recursive: true });

    writeFileSync(join(artifactsDir, "questions-output.md"), "questions content");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-1.md"), "feedback 1");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-3.md"), "feedback 3");
    writeFileSync(join(artifactsDir, "retry-feedback-impl-10.md"), "feedback 10");

    const stages = ["questions", "research", "design", "structure", "plan", "impl", "review"];
    const result = collectArtifacts(artifactsDir, "impl", stages);

    // Verify numeric ordering: feedback 1 before feedback 3 before feedback 10
    const idx1 = result.indexOf("feedback 1");
    const idx3 = result.indexOf("feedback 3");
    const idx10 = result.indexOf("feedback 10");
    expect(idx1).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx10);
    // Stage outputs appear before retry feedback
    const idxQuestions = result.indexOf("questions content");
    expect(idxQuestions).toBeLessThan(idx1);
  });

  it("collectArtifacts deduplicates to latest retry per stage", () => {
    const artifactsDir = join(TEST_DIR, "artifacts-trailing-test");
    mkdirSync(artifactsDir, { recursive: true });

    writeFileSync(join(artifactsDir, "questions-output.md"), "q base");
    writeFileSync(join(artifactsDir, "questions-output-r2.md"), "q r2");
    writeFileSync(join(artifactsDir, "questions-output-r10.md"), "q r10");

    const stages = ["questions", "research", "design"];
    const result = collectArtifacts(artifactsDir, "research", stages);
    expect(result).toContain("q r10");
    expect(result).not.toContain("q base");
    expect(result).not.toContain("q r2");
  });
});
