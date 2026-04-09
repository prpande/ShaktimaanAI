import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listHeldRecoveryTasks,
  getRecoveryTaskDetail,
} from "../../src/commands/recover.js";

function makeHoldState(overrides: Record<string, unknown> = {}) {
  return {
    slug: "test-task",
    taskFile: "test.task",
    stages: ["questions", "research", "design", "structure", "plan", "impl", "review", "validate", "pr"],
    reviewAfter: "design",
    currentStage: "impl",
    status: "hold",
    startedAt: "2026-04-09T08:00:00Z",
    updatedAt: "2026-04-09T09:00:00Z",
    completedStages: [],
    holdReason: "awaiting_fix",
    holdDetail: "Recovery: Tool permission missing",
    recoveryDiagnosis: "Tool permission missing in impl stage",
    recoveryReEntryStage: "impl",
    recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
    recoveryIssueNumber: 42,
    reviewRetryCount: 0,
    reviewIssues: [],
    suggestionRetryUsed: false,
    validateFailCount: 0,
    stageHints: {},
    retryAttempts: {},
    ...overrides,
  };
}

describe("listHeldRecoveryTasks", () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = join(tmpdir(), `shkmn-recover-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(runtimeDir, "12-hold"), { recursive: true });
  });

  it("returns empty array when no held tasks exist", () => {
    const result = listHeldRecoveryTasks(runtimeDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when 12-hold does not exist", () => {
    const result = listHeldRecoveryTasks(join(runtimeDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("lists tasks with holdReason awaiting_fix", () => {
    const slug = "my-task-20260409120000";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(makeHoldState({ slug })));

    const result = listHeldRecoveryTasks(runtimeDir);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe(slug);
    expect(result[0].diagnosis).toBe("Tool permission missing in impl stage");
    expect(result[0].reEntryStage).toBe("impl");
    expect(result[0].issueUrl).toBe("https://github.com/prpande/ShaktimaanAI/issues/42");
    expect(result[0].issueNumber).toBe(42);
  });

  it("skips tasks with different holdReason", () => {
    const slug = "paused-task";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "run-state.json"),
      JSON.stringify(makeHoldState({ slug, holdReason: "user_paused" })),
    );

    const result = listHeldRecoveryTasks(runtimeDir);
    expect(result).toHaveLength(0);
  });

  it("handles tasks without issue fields", () => {
    const slug = "no-issue-task";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "run-state.json"),
      JSON.stringify(
        makeHoldState({
          slug,
          recoveryIssueUrl: undefined,
          recoveryIssueNumber: undefined,
        }),
      ),
    );

    const result = listHeldRecoveryTasks(runtimeDir);
    expect(result).toHaveLength(1);
    expect(result[0].issueUrl).toBeUndefined();
    expect(result[0].issueNumber).toBeUndefined();
  });
});

describe("getRecoveryTaskDetail", () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = join(tmpdir(), `shkmn-recover-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(runtimeDir, "12-hold"), { recursive: true });
  });

  it("returns full run-state for existing task", () => {
    const slug = "detail-task";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    const state = makeHoldState({ slug });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state));

    const result = getRecoveryTaskDetail(runtimeDir, slug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe(slug);
    expect(result!.holdReason).toBe("awaiting_fix");
  });

  it("returns null for non-existent task", () => {
    const result = getRecoveryTaskDetail(runtimeDir, "nonexistent");
    expect(result).toBeNull();
  });
});
