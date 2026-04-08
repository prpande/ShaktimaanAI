import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { STAGE_DIR_MAP } from "../../src/core/pipeline.js";
import { scanForRecovery, runRecovery, type RecoveryItem, type RecoveryResult } from "../../src/core/recovery.js";
import { type Pipeline } from "../../src/core/pipeline.js";
import { type TaskLogger } from "../../src/core/logger.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let TEST_DIR: string;

const mockLogger: TaskLogger = {
  info() {},
  warn() {},
  error() {},
};

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-recovery-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── scanForRecovery ──────────────────────────────────────────────────────────

describe("scanForRecovery", () => {
  it("finds a task in a pending dir", () => {
    // Place a task directory in questions/pending
    const pendingDir = join(TEST_DIR, STAGE_DIR_MAP["questions"], "pending");
    mkdirSync(join(pendingDir, "my-task"), { recursive: true });

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe("my-task");
    expect(items[0].stage).toBe("questions");
    expect(items[0].dir).toBe(join(pendingDir, "my-task"));
  });

  it("finds tasks across multiple stages", () => {
    const stages = ["questions", "research", "impl"];
    for (const stage of stages) {
      const pendingDir = join(TEST_DIR, STAGE_DIR_MAP[stage], "pending");
      mkdirSync(join(pendingDir, `task-${stage}`), { recursive: true });
    }

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(3);

    const slugs = items.map((i) => i.slug).sort();
    expect(slugs).toEqual(["task-impl", "task-questions", "task-research"]);
  });

  it("scans done dirs for tasks needing advancement", () => {
    const doneDir = join(TEST_DIR, STAGE_DIR_MAP["design"], "done");
    mkdirSync(join(doneDir, "done-task"), { recursive: true });

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe("done-task");
    expect(items[0].location).toBe("done");
  });

  it("returns empty array when nothing is pending", () => {
    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(0);
  });

  it("ignores files in pending dirs (only directories)", () => {
    const pendingDir = join(TEST_DIR, STAGE_DIR_MAP["plan"], "pending");
    // Create a file (not a directory) in pending
    writeFileSync(join(pendingDir, "some-file.json"), "{}");
    // Create a real task dir too
    mkdirSync(join(pendingDir, "real-task"), { recursive: true });

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe("real-task");
  });
});

// ─── runRecovery ──────────────────────────────────────────────────────────────

function createMockPipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    async startRun() {},
    async resumeRun() {},
    async approveAndResume() {},
    getActiveRuns() { return []; },
    async cancel() {},
    async skip() {},
    async pause() {},
    async resume() {},
    async modifyStages() {},
    async restartStage() {},
    async retry() {},
    addNotifier() {},
    ...overrides,
  };
}

describe("runRecovery", () => {
  it("resumes all found tasks and reports them", async () => {
    const resumed: string[] = [];
    const mockPipeline = createMockPipeline({
      async resumeRun(slug) { resumed.push(slug); },
    });

    const pendingDir = join(TEST_DIR, STAGE_DIR_MAP["questions"], "pending");
    mkdirSync(join(pendingDir, "task-alpha"), { recursive: true });
    mkdirSync(join(pendingDir, "task-beta"), { recursive: true });

    const result: RecoveryResult = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed.sort()).toEqual(["task-alpha", "task-beta"]);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(resumed.sort()).toEqual(["task-alpha", "task-beta"]);
  });

  it("captures errors per item without crashing", async () => {
    const mockPipeline = createMockPipeline({
      async resumeRun(slug) {
        throw new Error(`Failed to resume ${slug}`);
      },
    });

    const pendingDir = join(TEST_DIR, STAGE_DIR_MAP["research"], "pending");
    mkdirSync(join(pendingDir, "broken-task"), { recursive: true });

    const result: RecoveryResult = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].slug).toBe("broken-task");
    expect(result.errors[0].error).toContain("Failed to resume broken-task");
  });

  it("returns empty result when nothing pending", async () => {
    const mockPipeline = createMockPipeline();

    const result: RecoveryResult = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── F-5.3: concurrent recovery with timer cleanup ──────────────────────────

describe("F-5.3: concurrent recovery", () => {
  it("recovers multiple pending tasks concurrently", async () => {
    const callOrder: string[] = [];
    const resolvers: Array<() => void> = [];

    const mockPipeline = createMockPipeline({
      async resumeRun(slug) {
        callOrder.push(`start:${slug}`);
        await new Promise<void>((resolve) => {
          resolvers.push(() => {
            callOrder.push(`end:${slug}`);
            resolve();
          });
        });
      },
    });

    // Create two pending tasks
    const pDir1 = join(TEST_DIR, STAGE_DIR_MAP["questions"], "pending", "task-1");
    const pDir2 = join(TEST_DIR, STAGE_DIR_MAP["research"], "pending", "task-2");
    mkdirSync(pDir1, { recursive: true });
    mkdirSync(pDir2, { recursive: true });

    const recoveryPromise = runRecovery(TEST_DIR, mockPipeline, mockLogger);

    // Give the concurrent promises time to start
    await new Promise(r => setTimeout(r, 50));

    // Both tasks should have started before either has finished
    expect(callOrder.filter(c => c.startsWith("start:"))).toHaveLength(2);
    expect(callOrder.filter(c => c.startsWith("end:"))).toHaveLength(0);

    // Now resolve both
    for (const resolve of resolvers) resolve();

    const result = await recoveryPromise;
    expect(result.resumed).toHaveLength(2);
    expect(result.resumed).toContain("task-1");
    expect(result.resumed).toContain("task-2");
    expect(result.errors).toHaveLength(0);
  });

  it("hold items are skipped without async work", async () => {
    const holdDir = join(TEST_DIR, "12-hold", "held-task");
    mkdirSync(holdDir, { recursive: true });

    const mockPipeline = createMockPipeline({
      async resumeRun() { throw new Error("Should not be called for hold items"); },
    });

    const result = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.skipped).toContain("held-task");
    expect(result.resumed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("clears timeout handles after pipeline settles", async () => {
    const taskDir = join(TEST_DIR, STAGE_DIR_MAP["questions"], "pending", "timeout-task");
    mkdirSync(taskDir, { recursive: true });

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const mockPipeline = createMockPipeline({
      async resumeRun() { /* resolve immediately */ },
    });

    await runRecovery(TEST_DIR, mockPipeline, mockLogger);

    // clearTimeout should have been called at least once (for the task's timeout)
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("captures errors from individual tasks without blocking others", async () => {
    const task1Dir = join(TEST_DIR, STAGE_DIR_MAP["questions"], "pending", "ok-task");
    const task2Dir = join(TEST_DIR, STAGE_DIR_MAP["research"], "pending", "fail-task");
    mkdirSync(task1Dir, { recursive: true });
    mkdirSync(task2Dir, { recursive: true });

    const mockPipeline = createMockPipeline({
      async resumeRun(slug) {
        if (slug === "fail-task") throw new Error("Simulated failure");
      },
    });

    const result = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed).toContain("ok-task");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].slug).toBe("fail-task");
    expect(result.errors[0].error).toContain("Simulated failure");
  });
});
