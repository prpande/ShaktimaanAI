import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "../../src/config/defaults.js";

describe("DEFAULT_AGENT_NAMES", () => {
  it("has all 14 agent name entries", () => {
    expect(Object.keys(DEFAULT_AGENT_NAMES)).toHaveLength(14);
  });

  it("includes all expected agent roles", () => {
    const roles = [
      "questions", "research", "design", "structure", "plan",
      "workTree", "impl", "validate", "review", "pr",
      "watcher", "taskCreator", "approvalHandler", "intentClassifier",
    ];
    for (const role of roles) {
      expect(DEFAULT_AGENT_NAMES).toHaveProperty(role);
    }
  });

  it("maps questions to Narada", () => {
    expect(DEFAULT_AGENT_NAMES.questions).toBe("Narada");
  });

  it("maps watcher to Heimdall", () => {
    expect(DEFAULT_AGENT_NAMES.watcher).toBe("Heimdall");
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has agents section with names and concurrency", () => {
    expect(DEFAULT_CONFIG.agents.names).toEqual(DEFAULT_AGENT_NAMES);
    expect(DEFAULT_CONFIG.agents.maxConcurrentTotal).toBe(3);
    expect(DEFAULT_CONFIG.agents.maxConcurrentValidate).toBe(1);
  });

  it("has schedule section with default times", () => {
    expect(DEFAULT_CONFIG.schedule.rollupTime).toBe("23:55");
    expect(DEFAULT_CONFIG.schedule.notionPushDay).toBe("Friday");
    expect(DEFAULT_CONFIG.schedule.notionPushTime).toBe("18:00");
    expect(DEFAULT_CONFIG.schedule.monthlyReportDay).toBe(1);
    expect(DEFAULT_CONFIG.schedule.monthlyReportTime).toBe("08:00");
  });

  it("has pipeline section with empty runtimeDir", () => {
    expect(DEFAULT_CONFIG.pipeline.runtimeDir).toBe("");
    expect(DEFAULT_CONFIG.pipeline.dashboardRepoLocal).toBe("");
    expect(DEFAULT_CONFIG.pipeline.dashboardRepoUrl).toBe("");
  });

  it("DEFAULT_CONFIG includes pipeline.agentsDir as empty string", () => {
    expect(DEFAULT_CONFIG.pipeline.agentsDir).toBe("");
  });

  it("has default stages for coding tasks", () => {
    expect(DEFAULT_CONFIG.agents.defaultStages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(DEFAULT_CONFIG.agents.defaultReviewAfter).toBe("design");
  });
});
