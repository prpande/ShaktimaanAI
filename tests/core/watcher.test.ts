import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { createWatcher, type Watcher, type WatcherOptions } from "../../src/core/watcher.js";
import { type Pipeline } from "../../src/core/pipeline.js";
import { type TaskLogger } from "../../src/core/logger.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let TEST_DIR: string;
let startedFiles: string[];

const mockLogger: TaskLogger = {
  info() {},
  warn() {},
  error() {},
};

const mockConfig = {
  ...DEFAULT_CONFIG,
  slack: { ...DEFAULT_CONFIG.slack, enabled: false },
};

function makeMockPipeline(): Pipeline {
  return {
    async startRun(path: string) { startedFiles.push(path); },
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
    async startQuickRun() {},
    addNotifier() {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-watcher-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(TEST_DIR);
  startedFiles = [];
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Watcher tests ───────────────────────────────────────────────────────────

describe("createWatcher", () => {
  it("starts and stops without error", async () => {
    const pipeline = makeMockPipeline();
    const watcher = createWatcher({ runtimeDir: TEST_DIR, pipeline, logger: mockLogger, config: mockConfig });

    expect(watcher.isRunning()).toBe(false);
    watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it("does not start twice (second start is no-op)", async () => {
    const pipeline = makeMockPipeline();
    const watcher = createWatcher({ runtimeDir: TEST_DIR, pipeline, logger: mockLogger, config: mockConfig });

    watcher.start();
    expect(watcher.isRunning()).toBe(true);

    // second start should be a no-op — should not throw
    watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
  });

  it("calls pipeline.startRun when a .task file appears in inbox", async () => {
    const pipeline = makeMockPipeline();
    const watcher = createWatcher({ runtimeDir: TEST_DIR, pipeline, logger: mockLogger, config: mockConfig });

    watcher.start();

    // Wait for watcher to be ready
    await delay(1000);

    // Write the .task file
    const taskPath = join(TEST_DIR, "00-inbox", "my-task.task");
    writeFileSync(taskPath, "# Task: Test\n\n## What I want done\nDo the thing.\n");

    // Wait for chokidar to detect (awaitWriteFinish: 500ms + buffer)
    await delay(2000);

    await watcher.stop();

    expect(startedFiles).toHaveLength(1);
    expect(startedFiles[0]).toBe(taskPath);
  }, 10000);

  it("ignores non-.task files in inbox", async () => {
    const pipeline = makeMockPipeline();
    const watcher = createWatcher({ runtimeDir: TEST_DIR, pipeline, logger: mockLogger, config: mockConfig });

    watcher.start();

    // Wait for watcher to be ready
    await delay(1000);

    // Write a non-.task file
    const notATask = join(TEST_DIR, "00-inbox", "some-file.txt");
    writeFileSync(notATask, "not a task file");

    // Wait for potential detection
    await delay(2000);

    await watcher.stop();

    expect(startedFiles).toHaveLength(0);
  }, 10000);
});
