import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { type AgentRunOptions, type AgentRunResult } from "../../src/core/types.js";
import { createPipeline, readRunState } from "../../src/core/pipeline.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let TEST_DIR: string;

function makeConfig(quickTaskOverrides: Record<string, unknown> = {}) {
  return resolveConfig(
    configSchema.parse({
      pipeline: { runtimeDir: TEST_DIR },
      quickTask: quickTaskOverrides,
    }),
  );
}

const SAMPLE_QUICK_TASK = `# Task: Rewrite paragraph

## What I want done
Rewrite this paragraph in formal tone: "hey we got a bug fix done"
`;

function makeMockRunner(writesOutput = true) {
  return async (options: AgentRunOptions): Promise<AgentRunResult> => {
    if (writesOutput && options.outputPath) {
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, `Mock quick output for ${options.slug}`, "utf-8");
    }
    return {
      success: true,
      output: `Mock quick output for ${options.slug}`,
      costUsd: 0.001,
      turns: 3,
      durationMs: 50,
    };
  };
}

function makeFailRunner() {
  return async (_options: AgentRunOptions): Promise<AgentRunResult> => {
    return {
      success: false,
      output: "",
      costUsd: 0,
      turns: 1,
      durationMs: 10,
      error: "Quick agent failed",
    };
  };
}

function setupInbox(): string {
  const inboxDir = join(TEST_DIR, "00-inbox");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(join(TEST_DIR, "10-complete"), { recursive: true });
  mkdirSync(join(TEST_DIR, "11-failed"), { recursive: true });
  mkdirSync(join(TEST_DIR, "12-hold"), { recursive: true });
  mkdirSync(join(TEST_DIR, "logs"), { recursive: true });
  return inboxDir;
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-quick-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Quick task path ─────────────────────────────────────────────────────────

describe("startQuickRun", () => {
  it("routes to 10-complete when requireReview=false", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "rewrite-paragraph.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: false });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: makeMockRunner(),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    // Inbox file should be removed
    expect(existsSync(taskFilePath)).toBe(false);

    // Task should land in 10-complete
    const completeDir = join(TEST_DIR, "10-complete", "rewrite-paragraph");
    expect(existsSync(completeDir)).toBe(true);

    // Should NOT be in 12-hold
    const holdDir = join(TEST_DIR, "12-hold", "rewrite-paragraph");
    expect(existsSync(holdDir)).toBe(false);

    // Run state should be complete
    const state = readRunState(completeDir);
    expect(state.status).toBe("complete");
    expect(state.slug).toBe("rewrite-paragraph");

    // Output artifact should exist
    const outputPath = join(completeDir, "artifacts", "quick-output.md");
    expect(existsSync(outputPath)).toBe(true);
  });

  it("routes to 12-hold when requireReview=true", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "rewrite-paragraph.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: true });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: makeMockRunner(),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    // Inbox file should be removed
    expect(existsSync(taskFilePath)).toBe(false);

    // Task should land in 12-hold
    const holdDir = join(TEST_DIR, "12-hold", "rewrite-paragraph");
    expect(existsSync(holdDir)).toBe(true);

    // Should NOT be in 10-complete
    const completeDir = join(TEST_DIR, "10-complete", "rewrite-paragraph");
    expect(existsSync(completeDir)).toBe(false);

    // Run state should be "hold"
    const state = readRunState(holdDir);
    expect(state.status).toBe("hold");
    expect(state.slug).toBe("rewrite-paragraph");

    // Output artifact should exist
    const outputPath = join(holdDir, "artifacts", "quick-output.md");
    expect(existsSync(outputPath)).toBe(true);
  });

  it("moves to 11-failed when agent returns failure", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "rewrite-paragraph.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: false });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: makeFailRunner(),
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    // Should end up in 11-failed
    const failedDir = join(TEST_DIR, "11-failed", "rewrite-paragraph");
    expect(existsSync(failedDir)).toBe(true);

    // Should not be in 10-complete or 12-hold
    expect(existsSync(join(TEST_DIR, "10-complete", "rewrite-paragraph"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "12-hold", "rewrite-paragraph"))).toBe(false);

    const state = readRunState(failedDir);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("Quick agent failed");
  });

  it("emits task_created and task_completed events when requireReview=false", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "compose-email.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: false });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: makeMockRunner(),
      logger: { info() {}, warn() {}, error() {} },
    });

    const events: string[] = [];
    pipeline.addNotifier({
      async notify(event) { events.push(event.type); },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    expect(events).toContain("task_created");
    expect(events).toContain("task_completed");
    expect(events).not.toContain("task_held");
  });

  it("emits task_created and task_held events when requireReview=true", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "compose-email.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: true });
    const registry = createAgentRegistry(3, 1);
    const pipeline = createPipeline({
      config,
      registry,
      runner: makeMockRunner(),
      logger: { info() {}, warn() {}, error() {} },
    });

    const events: string[] = [];
    pipeline.addNotifier({
      async notify(event) { events.push(event.type); },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    expect(events).toContain("task_created");
    expect(events).toContain("task_held");
    expect(events).not.toContain("task_completed");
  });

  it("uses stage=quick when calling the runner", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "some-task.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: false });
    const registry = createAgentRegistry(3, 1);

    const observedStages: string[] = [];
    const runner = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      observedStages.push(options.stage);
      if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, "output", "utf-8");
      }
      return { success: true, output: "output", costUsd: 0, turns: 1, durationMs: 10 };
    };

    const pipeline = createPipeline({
      config,
      registry,
      runner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    expect(observedStages).toEqual(["quick"]);
  });

  it("writes output file if agent did not", async () => {
    setupInbox();
    const taskFilePath = join(TEST_DIR, "00-inbox", "some-task.task");
    writeFileSync(taskFilePath, SAMPLE_QUICK_TASK, "utf-8");

    const config = makeConfig({ requireReview: false });
    const registry = createAgentRegistry(3, 1);

    // Runner that does NOT write outputPath
    const runner = async (_options: AgentRunOptions): Promise<AgentRunResult> => {
      return { success: true, output: "runner produced output", costUsd: 0, turns: 1, durationMs: 10 };
    };

    const pipeline = createPipeline({
      config,
      registry,
      runner,
      logger: { info() {}, warn() {}, error() {} },
    });

    await pipeline.startQuickRun(taskFilePath, SAMPLE_QUICK_TASK);

    const completeDir = join(TEST_DIR, "10-complete", "some-task");
    const outputPath = join(completeDir, "artifacts", "quick-output.md");
    expect(existsSync(outputPath)).toBe(true);
    // Should contain runner output since agent didn't write it
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(outputPath, "utf-8");
    expect(content).toBe("runner produced output");
  });
});
