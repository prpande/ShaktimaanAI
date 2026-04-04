import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findHeldTask,
  listHeldTasks,
  approveTask,
  type ApproveInput,
} from "../../src/core/approval-handler.js";
import { type Pipeline } from "../../src/core/pipeline.js";
import { type TaskLogger } from "../../src/core/logger.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-approval-" + Date.now());

beforeEach(() => mkdirSync(join(TEST_DIR, "12-hold"), { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// ─── Stub helpers ────────────────────────────────────────────────────────────

function makeStubLogger(): TaskLogger {
  return { info() {}, warn() {}, error() {} };
}

function makeStubPipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    startRun: async () => {},
    resumeRun: async () => {},
    approveAndResume: async () => {},
    getActiveRuns: () => [],
    ...overrides,
  };
}

// ─── findHeldTask ────────────────────────────────────────────────────────────

describe("findHeldTask", () => {
  it("returns the full path when the slug directory exists in 12-hold", () => {
    const slug = "my-feature-task";
    mkdirSync(join(TEST_DIR, "12-hold", slug), { recursive: true });

    const result = findHeldTask(TEST_DIR, slug);

    expect(result).toBe(join(TEST_DIR, "12-hold", slug));
  });

  it("returns null when the slug directory does not exist", () => {
    const result = findHeldTask(TEST_DIR, "nonexistent-slug");
    expect(result).toBeNull();
  });

  it("returns null when slug refers to a file, not a directory", () => {
    const slug = "file-not-dir";
    writeFileSync(join(TEST_DIR, "12-hold", slug), "not a directory", "utf-8");

    const result = findHeldTask(TEST_DIR, slug);
    expect(result).toBeNull();
  });
});

// ─── listHeldTasks ───────────────────────────────────────────────────────────

describe("listHeldTasks", () => {
  it("lists directory names (slugs) present in 12-hold", () => {
    mkdirSync(join(TEST_DIR, "12-hold", "task-alpha"), { recursive: true });
    mkdirSync(join(TEST_DIR, "12-hold", "task-beta"), { recursive: true });

    const result = listHeldTasks(TEST_DIR);

    expect(result).toHaveLength(2);
    expect(result).toContain("task-alpha");
    expect(result).toContain("task-beta");
  });

  it("returns empty array when 12-hold is empty", () => {
    const result = listHeldTasks(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("returns empty array when 12-hold directory does not exist", () => {
    rmSync(join(TEST_DIR, "12-hold"), { recursive: true, force: true });
    const result = listHeldTasks(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("ignores files — only returns directory entries", () => {
    mkdirSync(join(TEST_DIR, "12-hold", "dir-task"), { recursive: true });
    writeFileSync(join(TEST_DIR, "12-hold", "some-file.json"), "{}", "utf-8");

    const result = listHeldTasks(TEST_DIR);

    expect(result).toEqual(["dir-task"]);
  });
});

// ─── approveTask ─────────────────────────────────────────────────────────────

describe("approveTask", () => {
  it("throws when the task slug is not in 12-hold", async () => {
    const input: ApproveInput = { source: "cli", taskSlug: "ghost-task" };
    const pipeline = makeStubPipeline();
    const logger = makeStubLogger();

    await expect(
      approveTask(input, TEST_DIR, pipeline, logger),
    ).rejects.toThrow(/ghost-task/);
  });

  it("calls pipeline.approveAndResume with slug and feedback", async () => {
    const slug = "real-task";
    mkdirSync(join(TEST_DIR, "12-hold", slug), { recursive: true });

    const calls: Array<{ slug: string; feedback?: string }> = [];
    const pipeline = makeStubPipeline({
      approveAndResume: async (s, f) => { calls.push({ slug: s, feedback: f }); },
    });
    const logger = makeStubLogger();

    const input: ApproveInput = { source: "slack", taskSlug: slug, feedback: "Looks great!" };
    await approveTask(input, TEST_DIR, pipeline, logger);

    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe(slug);
    expect(calls[0].feedback).toBe("Looks great!");
  });

  it("calls pipeline.approveAndResume without feedback when none provided", async () => {
    const slug = "no-feedback-task";
    mkdirSync(join(TEST_DIR, "12-hold", slug), { recursive: true });

    const calls: Array<{ slug: string; feedback?: string }> = [];
    const pipeline = makeStubPipeline({
      approveAndResume: async (s, f) => { calls.push({ slug: s, feedback: f }); },
    });
    const logger = makeStubLogger();

    const input: ApproveInput = { source: "dashboard", taskSlug: slug };
    await approveTask(input, TEST_DIR, pipeline, logger);

    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe(slug);
    expect(calls[0].feedback).toBeUndefined();
  });

  it("logs the approval before calling pipeline", async () => {
    const slug = "logged-task";
    mkdirSync(join(TEST_DIR, "12-hold", slug), { recursive: true });

    const logs: string[] = [];
    const logger: TaskLogger = {
      info: (msg) => logs.push(msg),
      warn() {},
      error() {},
    };
    const pipeline = makeStubPipeline();

    const input: ApproveInput = { source: "cli", taskSlug: slug };
    await approveTask(input, TEST_DIR, pipeline, logger);

    expect(logs.some((l) => l.includes(slug))).toBe(true);
  });
});
