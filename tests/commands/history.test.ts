import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listCompletedTasks } from "../../src/commands/history.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-history-" + Date.now());

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "10-complete"), { recursive: true });
  mkdirSync(join(TEST_DIR, "11-failed"), { recursive: true });
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

function writeRunState(dir: string, slug: string, state: Record<string, unknown>): void {
  const taskDir = join(TEST_DIR, dir, slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));
}

describe("listCompletedTasks", () => {
  it("returns empty array when no tasks exist", () => {
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"));
    expect(result).toEqual([]);
  });

  it("returns a completed task with correct fields", () => {
    writeRunState("10-complete", "my-task-20260401120000", {
      slug: "my-task-20260401120000",
      status: "complete",
      startedAt: "2026-04-01T12:00:00Z",
      updatedAt: "2026-04-01T12:05:00Z",
      currentStage: "pr",
      completedStages: [
        { stage: "questions", completedAt: "2026-04-01T12:01:00Z" },
        { stage: "pr", completedAt: "2026-04-01T12:05:00Z" },
      ],
    });
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"));
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("my-task-20260401120000");
    expect(result[0].status).toBe("complete");
    expect(result[0].startedAt).toBe("2026-04-01T12:00:00Z");
    expect(result[0].finalStage).toBe("pr");
  });

  it("includes failed tasks with error reason", () => {
    writeRunState("11-failed", "broken-task-20260401130000", {
      slug: "broken-task-20260401130000",
      status: "failed",
      startedAt: "2026-04-01T13:00:00Z",
      updatedAt: "2026-04-01T13:02:00Z",
      currentStage: "impl",
      error: "Agent timed out",
      completedStages: [],
    });
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"));
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("failed");
    expect(result[0].error).toBe("Agent timed out");
  });

  it("sorts by updatedAt descending (most recent first)", () => {
    writeRunState("10-complete", "old-task-20260401100000", {
      slug: "old-task-20260401100000",
      status: "complete",
      startedAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:05:00Z",
      currentStage: "pr",
      completedStages: [],
    });
    writeRunState("10-complete", "new-task-20260401120000", {
      slug: "new-task-20260401120000",
      status: "complete",
      startedAt: "2026-04-01T12:00:00Z",
      updatedAt: "2026-04-01T12:05:00Z",
      currentStage: "pr",
      completedStages: [],
    });
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"));
    expect(result[0].slug).toBe("new-task-20260401120000");
    expect(result[1].slug).toBe("old-task-20260401100000");
  });

  it("respects count limit", () => {
    for (let i = 0; i < 5; i++) {
      const h = String(10 + i).padStart(2, "0");
      writeRunState("10-complete", `task-${i}-202604011${h}0000`, {
        slug: `task-${i}-202604011${h}0000`,
        status: "complete",
        startedAt: `2026-04-01T1${h.charAt(1)}:00:00Z`,
        updatedAt: `2026-04-01T1${h.charAt(1)}:05:00Z`,
        currentStage: "pr",
        completedStages: [],
      });
    }
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"), 3);
    expect(result).toHaveLength(3);
  });

  it("skips directories without run-state.json", () => {
    mkdirSync(join(TEST_DIR, "10-complete", "orphan-dir"), { recursive: true });
    const result = listCompletedTasks(join(TEST_DIR, "10-complete"), join(TEST_DIR, "11-failed"));
    expect(result).toEqual([]);
  });
});
