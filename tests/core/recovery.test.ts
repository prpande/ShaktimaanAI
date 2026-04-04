import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("ignores done dirs (only looks in pending)", () => {
    const doneDir = join(TEST_DIR, STAGE_DIR_MAP["design"], "done");
    mkdirSync(join(doneDir, "done-task"), { recursive: true });

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(0);
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

describe("runRecovery", () => {
  it("resumes all found tasks and reports them", async () => {
    const resumed: string[] = [];
    const mockPipeline: Pipeline = {
      async startRun() {},
      async resumeRun(slug) { resumed.push(slug); },
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

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
    const mockPipeline: Pipeline = {
      async startRun() {},
      async resumeRun(slug) {
        throw new Error(`Failed to resume ${slug}`);
      },
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const pendingDir = join(TEST_DIR, STAGE_DIR_MAP["research"], "pending");
    mkdirSync(join(pendingDir, "broken-task"), { recursive: true });

    const result: RecoveryResult = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].slug).toBe("broken-task");
    expect(result.errors[0].error).toContain("Failed to resume broken-task");
  });

  it("returns empty result when nothing pending", async () => {
    const mockPipeline: Pipeline = {
      async startRun() {},
      async resumeRun() {},
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const result: RecoveryResult = await runRecovery(TEST_DIR, mockPipeline, mockLogger);
    expect(result.resumed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
