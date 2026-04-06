import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES, DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES } from "../../src/config/defaults.js";

describe("DEFAULT_AGENT_NAMES", () => {
  it("has all 15 agent name entries", () => {
    expect(Object.keys(DEFAULT_AGENT_NAMES)).toHaveLength(15);
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
      "impl", "review", "validate", "pr",
    ]);
    expect(DEFAULT_CONFIG.agents.defaultReviewAfter).toBe("design");
  });
});

describe("DEFAULT_STAGE_TOOLS", () => {
  const ALL_STAGES = ["questions", "research", "design", "structure", "plan", "impl", "validate", "review", "pr", "classify", "quick"];

  it("has entries for all 11 stages", () => {
    for (const stage of ALL_STAGES) {
      expect(DEFAULT_STAGE_TOOLS).toHaveProperty(stage);
    }
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toHaveLength(11);
  });

  it("impl has full write access", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS.impl;
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Bash");
    expect(disallowed).toHaveLength(0);
  });

  it("classify has no allowed tools", () => {
    expect(DEFAULT_STAGE_TOOLS.classify.allowed).toHaveLength(0);
  });

  it("research has MCP tool patterns", () => {
    const { allowed } = DEFAULT_STAGE_TOOLS.research;
    expect(allowed).toContain("mcp__claude_ai_Slack__*");
    expect(allowed).toContain("mcp__plugin_notion_notion__*");
  });

  it("review is read-only", () => {
    const { disallowed } = DEFAULT_STAGE_TOOLS.review;
    expect(disallowed).toContain("Write");
    expect(disallowed).toContain("Edit");
    expect(disallowed).toContain("Bash");
  });
});

describe("STAGE_CONTEXT_RULES", () => {
  const ALL_STAGES = ["questions", "research", "design", "structure", "plan", "impl", "validate", "review", "pr", "classify", "quick"];

  it("has entries for all 11 stages", () => {
    for (const stage of ALL_STAGES) {
      expect(STAGE_CONTEXT_RULES).toHaveProperty(stage);
    }
    expect(Object.keys(STAGE_CONTEXT_RULES)).toHaveLength(11);
  });

  it("research does NOT include task content (QRSPI blind)", () => {
    expect(STAGE_CONTEXT_RULES.research.includeTaskContent).toBe(false);
  });

  it("research labels previous output as 'Questions to Investigate'", () => {
    expect(STAGE_CONTEXT_RULES.research.previousOutputLabel).toBe("Questions to Investigate");
  });

  it("questions has no previous output label (first stage)", () => {
    expect(STAGE_CONTEXT_RULES.questions.previousOutputLabel).toBeNull();
  });

  it("classify has no previous output and no repo context", () => {
    expect(STAGE_CONTEXT_RULES.classify.previousOutputLabel).toBeNull();
    expect(STAGE_CONTEXT_RULES.classify.includeRepoContext).toBe(false);
  });

  it("impl includes task content, previous output as 'Implementation Plan', and repo context", () => {
    const rule = STAGE_CONTEXT_RULES.impl;
    expect(rule.includeTaskContent).toBe(true);
    expect(rule.previousOutputLabel).toBe("Implementation Plan");
    expect(rule.includeRepoContext).toBe(true);
  });

  it("structure excludes task content and repo context", () => {
    const rule = STAGE_CONTEXT_RULES.structure;
    expect(rule.includeTaskContent).toBe(false);
    expect(rule.includeRepoContext).toBe(false);
  });

  it("pr excludes repo context", () => {
    expect(STAGE_CONTEXT_RULES.pr.includeRepoContext).toBe(false);
  });
});
