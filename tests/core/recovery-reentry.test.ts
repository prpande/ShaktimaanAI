import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reenterTask } from "../../src/core/recovery-reentry.js";
import { STAGE_DIR_MAP } from "../../src/core/stage-map.js";

function makeRunState(overrides: Record<string, unknown> = {}) {
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
    reviewRetryCount: 2,
    reviewIssues: [{ id: "1", description: "test", severity: "high", firstSeen: 1, lastSeen: 2 }],
    suggestionRetryUsed: true,
    validateFailCount: 3,
    validateRetryCount: 1,
    stageHints: {},
    retryAttempts: { impl: 2, review: 1 },
    recoveryDiagnosis: "Tool permission missing",
    recoveryReEntryStage: "review",
    recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
    recoveryIssueNumber: 42,
    ...overrides,
  };
}

describe("reenterTask", () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = join(tmpdir(), `shkmn-reentry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Create the hold directory and the target stage pending directory
    mkdirSync(join(runtimeDir, "12-hold"), { recursive: true });
    for (const stageDir of Object.values(STAGE_DIR_MAP)) {
      mkdirSync(join(runtimeDir, stageDir, "pending"), { recursive: true });
    }
  });

  it("moves task from hold to correct stage pending dir", () => {
    const slug = "test-task";
    const holdDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(join(holdDir, "artifacts"), { recursive: true });
    writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(makeRunState()));

    const result = reenterTask(runtimeDir, slug);

    expect(result.success).toBe(true);
    expect(result.reEntryStage).toBe("review");

    // Task should be in review/pending now
    const newDir = join(runtimeDir, STAGE_DIR_MAP["review"], "pending", slug);
    expect(existsSync(newDir)).toBe(true);

    // Task should NOT be in hold anymore
    expect(existsSync(holdDir)).toBe(false);
  });

  it("resets run-state properly", () => {
    const slug = "test-task";
    const holdDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(join(holdDir, "artifacts"), { recursive: true });
    writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(makeRunState()));

    reenterTask(runtimeDir, slug);

    // Read state from new location
    const newDir = join(runtimeDir, STAGE_DIR_MAP["review"], "pending", slug);
    const state = JSON.parse(readFileSync(join(newDir, "run-state.json"), "utf-8"));

    expect(state.status).toBe("running");
    expect(state.currentStage).toBe("review");
    expect(state.error).toBeUndefined();
    expect(state.holdReason).toBeUndefined();
    expect(state.holdDetail).toBeUndefined();
    expect(state.terminalFailure).toBeUndefined();
    expect(state.recoveryDiagnosis).toBeUndefined();
    expect(state.recoveryReEntryStage).toBeUndefined();
    expect(state.recoveryIssueUrl).toBeUndefined();
    expect(state.recoveryIssueNumber).toBeUndefined();
    // Review retry counts should be reset since review is downstream
    expect(state.reviewRetryCount).toBe(0);
    expect(state.reviewIssues).toEqual([]);
    expect(state.suggestionRetryUsed).toBe(false);
    // Validate counts should be reset since validate is downstream of review
    expect(state.validateFailCount).toBe(0);
    expect(state.validateRetryCount).toBe(0);
  });

  it("archives downstream artifacts and preserves upstream", () => {
    const slug = "test-task";
    const holdDir = join(runtimeDir, "12-hold", slug);
    const artifactsDir = join(holdDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Upstream artifacts (before review)
    writeFileSync(join(artifactsDir, "questions-output.md"), "upstream questions");
    writeFileSync(join(artifactsDir, "plan-output.md"), "upstream plan");

    // Downstream artifacts (review and later)
    writeFileSync(join(artifactsDir, "review-output.md"), "downstream review");
    writeFileSync(join(artifactsDir, "validate-output.md"), "downstream validate");
    writeFileSync(join(artifactsDir, "impl-output.md"), "upstream impl");

    writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(makeRunState()));

    reenterTask(runtimeDir, slug);

    const newDir = join(runtimeDir, STAGE_DIR_MAP["review"], "pending", slug);
    const newArtifactsDir = join(newDir, "artifacts");

    // Upstream artifacts should still be in place
    expect(existsSync(join(newArtifactsDir, "questions-output.md"))).toBe(true);
    expect(existsSync(join(newArtifactsDir, "plan-output.md"))).toBe(true);
    expect(existsSync(join(newArtifactsDir, "impl-output.md"))).toBe(true);

    // Downstream artifacts should be in pre-recovery/
    expect(existsSync(join(newArtifactsDir, "pre-recovery", "review-output.md"))).toBe(true);
    expect(existsSync(join(newArtifactsDir, "pre-recovery", "validate-output.md"))).toBe(true);

    // Downstream artifacts should NOT be in main artifacts dir
    expect(existsSync(join(newArtifactsDir, "review-output.md"))).toBe(false);
    expect(existsSync(join(newArtifactsDir, "validate-output.md"))).toBe(false);
  });

  it("returns error if task not in hold", () => {
    const result = reenterTask(runtimeDir, "nonexistent-task");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in 12-hold");
  });

  it("returns error if holdReason is not awaiting_fix", () => {
    const slug = "wrong-reason";
    const holdDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(join(holdDir, "artifacts"), { recursive: true });
    writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(
      makeRunState({ slug, holdReason: "approval_required" }),
    ));

    const result = reenterTask(runtimeDir, slug);
    expect(result.success).toBe(false);
    expect(result.error).toContain("approval_required");
  });

  it("uses currentStage when recoveryReEntryStage is not set", () => {
    const slug = "no-reentry-stage";
    const holdDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(join(holdDir, "artifacts"), { recursive: true });
    writeFileSync(join(holdDir, "run-state.json"), JSON.stringify(
      makeRunState({
        slug,
        currentStage: "impl",
        recoveryReEntryStage: undefined,
      }),
    ));

    const result = reenterTask(runtimeDir, slug);
    expect(result.success).toBe(true);
    expect(result.reEntryStage).toBe("impl");

    const newDir = join(runtimeDir, STAGE_DIR_MAP["impl"], "pending", slug);
    expect(existsSync(newDir)).toBe(true);
  });
});
