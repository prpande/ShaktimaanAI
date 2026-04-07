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
      "watcher", "taskCreator", "approvalHandler", "quick",
      "slackIO",
    ];
    for (const role of roles) {
      expect(DEFAULT_AGENT_NAMES).toHaveProperty(role);
    }
  });

  it("does not include intentClassifier (replaced by Astra)", () => {
    expect(DEFAULT_AGENT_NAMES).not.toHaveProperty("intentClassifier");
  });

  it("maps questions to Gargi", () => {
    expect(DEFAULT_AGENT_NAMES.questions).toBe("Gargi");
  });

  it("maps slackIO to Narada", () => {
    expect(DEFAULT_AGENT_NAMES.slackIO).toBe("Narada");
  });

  it("maps watcher to Heimdall", () => {
    expect(DEFAULT_AGENT_NAMES.watcher).toBe("Heimdall");
  });

  it("maps quick to Astra", () => {
    expect(DEFAULT_AGENT_NAMES.quick).toBe("Astra");
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

  it("has agents.models with per-stage model assignments", () => {
    expect(DEFAULT_CONFIG.agents.models).toBeDefined();
    expect(DEFAULT_CONFIG.agents.models["slack-io"]).toBe("haiku");
    expect(DEFAULT_CONFIG.agents.models["quick-triage"]).toBe("haiku");
    expect(DEFAULT_CONFIG.agents.models["quick"]).toBe("haiku");
    expect(DEFAULT_CONFIG.agents.models["quick-execute"]).toBe("sonnet");
    expect(DEFAULT_CONFIG.agents.models.impl).toBe("opus");
    expect(DEFAULT_CONFIG.agents.models.questions).toBe("sonnet");
  });

  it("does not have classify in agents.models", () => {
    expect(DEFAULT_CONFIG.agents.models).not.toHaveProperty("classify");
  });

  it("has slack.dmUserIds defaulting to empty array", () => {
    expect(DEFAULT_CONFIG.slack.dmUserIds).toEqual([]);
  });

  it("has slack.pollIntervalActiveSec and pollIntervalIdleSec (adaptive polling)", () => {
    expect(DEFAULT_CONFIG.slack.pollIntervalActiveSec).toBe(300);
    expect(DEFAULT_CONFIG.slack.pollIntervalIdleSec).toBe(45);
  });

  it("does not have slack.pollIntervalSeconds (removed)", () => {
    expect(DEFAULT_CONFIG.slack).not.toHaveProperty("pollIntervalSeconds");
  });

  it("has quickTask.requireReview but no complexityThreshold", () => {
    expect(DEFAULT_CONFIG.quickTask.requireReview).toBe(true);
    expect(DEFAULT_CONFIG.quickTask).not.toHaveProperty("complexityThreshold");
  });

  it("has quick-triage and quick-execute maxTurns entries", () => {
    expect(DEFAULT_CONFIG.agents.maxTurns["quick-triage"]).toBe(5);
    expect(DEFAULT_CONFIG.agents.maxTurns["quick-execute"]).toBe(40);
    expect(DEFAULT_CONFIG.agents.maxTurns["quick"]).toBe(5);
  });

  it("has quick-triage and quick-execute timeoutsMinutes entries", () => {
    expect(DEFAULT_CONFIG.agents.timeoutsMinutes["quick-triage"]).toBe(2);
    expect(DEFAULT_CONFIG.agents.timeoutsMinutes["quick-execute"]).toBe(30);
    expect(DEFAULT_CONFIG.agents.timeoutsMinutes["quick"]).toBe(2);
  });
});

describe("DEFAULT_STAGE_TOOLS", () => {
  const ALL_STAGES = ["questions", "research", "design", "structure", "plan", "impl", "validate", "review", "pr", "quick", "quick-triage", "quick-execute", "slack-io"];

  it("has entries for all 13 stages", () => {
    for (const stage of ALL_STAGES) {
      expect(DEFAULT_STAGE_TOOLS).toHaveProperty(stage);
    }
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toHaveLength(13);
  });

  it("does not have a classify entry", () => {
    expect(DEFAULT_STAGE_TOOLS).not.toHaveProperty("classify");
  });

  it("impl has full write access", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS.impl;
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Bash");
    expect(disallowed).toHaveLength(0);
  });

  it("quick (triage) is read-only with MCP notion and Slack read patterns", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS.quick;
    expect(allowed).toContain("Read");
    expect(allowed).toContain("mcp__plugin_notion_notion__*");
    expect(allowed).toContain("mcp__claude_ai_Slack__slack_read_*");
    expect(disallowed).toContain("Write");
    expect(disallowed).toContain("Edit");
  });

  it("quick-execute has full write access with MCP tools", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS["quick-execute"];
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Bash");
    expect(allowed).toContain("mcp__claude_ai_Slack__*");
    expect(allowed).toContain("mcp__plugin_notion_notion__*");
    expect(disallowed).toHaveLength(0);
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

  it("slack-io has MCP Slack tools and Read/Write", () => {
    const { allowed, disallowed } = DEFAULT_STAGE_TOOLS["slack-io"];
    expect(allowed).toContain("mcp__claude_ai_Slack__*");
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Write");
    expect(disallowed).toContain("Bash");
  });
});

describe("STAGE_CONTEXT_RULES", () => {
  const ALL_STAGES = ["questions", "research", "design", "structure", "plan", "impl", "validate", "review", "pr", "quick", "quick-triage", "quick-execute", "slack-io"];

  it("has entries for all 13 stages", () => {
    for (const stage of ALL_STAGES) {
      expect(STAGE_CONTEXT_RULES).toHaveProperty(stage);
    }
    expect(Object.keys(STAGE_CONTEXT_RULES)).toHaveLength(13);
  });

  it("does not have a classify entry", () => {
    expect(STAGE_CONTEXT_RULES).not.toHaveProperty("classify");
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

  it("quick has no previous output and includes repo context", () => {
    expect(STAGE_CONTEXT_RULES.quick.previousOutputLabel).toBeNull();
    expect(STAGE_CONTEXT_RULES.quick.includeRepoContext).toBe(true);
    expect(STAGE_CONTEXT_RULES.quick.includeTaskContent).toBe(true);
  });

  it("quick-execute has no previous output and includes repo context", () => {
    expect(STAGE_CONTEXT_RULES["quick-execute"].previousOutputLabel).toBeNull();
    expect(STAGE_CONTEXT_RULES["quick-execute"].includeRepoContext).toBe(true);
    expect(STAGE_CONTEXT_RULES["quick-execute"].includeTaskContent).toBe(true);
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

  it("slack-io includes task content but no repo context", () => {
    expect(STAGE_CONTEXT_RULES["slack-io"].includeTaskContent).toBe(true);
    expect(STAGE_CONTEXT_RULES["slack-io"].includeRepoContext).toBe(false);
    expect(STAGE_CONTEXT_RULES["slack-io"].previousOutputLabel).toBeNull();
  });
});
