import { describe, it, expect } from "vitest";
import type { RunState } from "../../src/core/types.js";

describe("RunState recovery fields", () => {
  it("accepts recovery-related fields", () => {
    const state: RunState = {
      slug: "test-slug",
      taskFile: "task.md",
      stages: ["impl"],
      reviewAfter: "design",
      currentStage: "impl",
      status: "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedStages: [],
      reviewRetryCount: 0,
      reviewIssues: [],
      suggestionRetryUsed: false,
      validateFailCount: 0,
      stageHints: {},
      retryAttempts: {},
      // Recovery fields
      terminalFailure: true,
      recoveryDiagnosis: "Tool permission missing for review stage",
      recoveryReEntryStage: "review",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      recoveryIssueNumber: 42,
    };
    expect(state.terminalFailure).toBe(true);
    expect(state.recoveryDiagnosis).toBe("Tool permission missing for review stage");
    expect(state.recoveryReEntryStage).toBe("review");
    expect(state.recoveryIssueUrl).toBe("https://github.com/prpande/ShaktimaanAI/issues/42");
    expect(state.recoveryIssueNumber).toBe(42);
  });

  it("accepts awaiting_fix holdReason", () => {
    const state: RunState = {
      slug: "test-slug",
      taskFile: "task.md",
      stages: ["impl"],
      reviewAfter: "design",
      currentStage: "impl",
      status: "hold",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedStages: [],
      reviewRetryCount: 0,
      reviewIssues: [],
      suggestionRetryUsed: false,
      validateFailCount: 0,
      stageHints: {},
      retryAttempts: {},
      holdReason: "awaiting_fix",
    };
    expect(state.holdReason).toBe("awaiting_fix");
  });
});
