import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { buildPaths } from "../../src/config/paths.js";
import { createWatcher, resolveSlackRepoCwd, type Watcher, type WatcherOptions } from "../../src/core/watcher.js";
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
    addNotifier() {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-watcher-test-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  createRuntimeDirs(buildPaths(TEST_DIR));
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

  it("queues an immediate follow-up slack send when triggered during an active poll", async () => {
    let slackPollCalls = 0;
    let releaseFirstPoll: (() => void) | null = null;

    const runner: WatcherOptions["runner"] = async (opts) => {
      if (opts.stage === "slack-io") {
        slackPollCalls += 1;
        if (slackPollCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstPoll = resolve;
          });
        }
      }

      return {
        success: true,
        output: "{}",
        costUsd: 0,
        turns: 1,
        durationMs: 10,
        inputTokens: 0,
        outputTokens: 0,
      };
    };

    const slackEnabledConfig = {
      ...DEFAULT_CONFIG,
      slack: {
        ...DEFAULT_CONFIG.slack,
        enabled: true,
        channelId: "C12345",
        pollIntervalActiveSec: 3600,
        pollIntervalIdleSec: 3600,
      },
    };

    const watcher = createWatcher({
      runtimeDir: TEST_DIR,
      pipeline: makeMockPipeline(),
      logger: mockLogger,
      config: slackEnabledConfig,
      runner,
    });

    watcher.triggerSlackSend();

    // Wait until the first poll has actually started (releaseFirstPoll is set)
    const firstPollDeadline = Date.now() + 2000;
    while (releaseFirstPoll === null && Date.now() < firstPollDeadline) {
      await delay(20);
    }

    expect(slackPollCalls).toBe(1);
    expect(releaseFirstPoll).not.toBeNull();

    watcher.triggerSlackSend(); // should queue a second immediate poll
    releaseFirstPoll?.();

    const deadline = Date.now() + 2000;
    while (slackPollCalls < 2 && Date.now() < deadline) {
      await delay(20);
    }

    expect(slackPollCalls).toBe(2);
  });
});

// ─── resolveSlackRepoCwd tests ────────────────────────────────────────────────

describe("resolveSlackRepoCwd", () => {
  it("returns config.repos.root when no repo hint", () => {
    const result = resolveSlackRepoCwd(undefined, {
      repos: { root: "/home/user/code", aliases: {} },
    } as any);
    expect(result).toBe("/home/user/code");
  });

  it("resolves a repo alias to its path", () => {
    const result = resolveSlackRepoCwd("myapp", {
      repos: { root: "/home/user/code", aliases: { myapp: { path: "/home/user/myapp" } } },
    } as any);
    expect(result).toBe("/home/user/myapp");
  });

  it("returns the repo name as-is if it looks like an absolute path", () => {
    const result = resolveSlackRepoCwd("/explicit/repo/path", {
      repos: { root: "/home/user/code", aliases: {} },
    } as any);
    expect(result).toBe("/explicit/repo/path");
  });

  it("falls back to process.cwd() when no config root and no repo hint", () => {
    const result = resolveSlackRepoCwd(undefined, {
      repos: { root: "", aliases: {} },
    } as any);
    expect(result).toBe(process.cwd());
  });

  it("resolves non-alias non-path repo hint under repos.root", () => {
    const result = resolveSlackRepoCwd("some-repo", {
      repos: { root: "/home/user/code", aliases: {} },
    } as any);
    expect(result).toBe("/home/user/code/some-repo");
  });
});
