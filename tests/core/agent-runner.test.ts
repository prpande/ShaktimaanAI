import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildSystemPrompt,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  filterMcpToolsByTaskNeeds,
  resolveToolPermissions,
  resolveMaxTurns,
  resolveTimeoutMinutes,
  resolveAdviserModel,
} from "../../src/core/agent-runner.js";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import type { AgentRunOptions } from "../../src/core/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-runner-" + Date.now());
const AGENTS_DIR = join(TEST_DIR, "agents");
const REPO_DIR = join(TEST_DIR, "repo");

beforeAll(() => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(REPO_DIR, { recursive: true });
});

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

function makeConfig(overrides?: {
  agentNames?: Record<string, string>;
  maxTurns?: Record<string, number>;
  timeoutsMinutes?: Record<string, number>;
  tools?: Record<string, { allowed?: string[]; disallowed?: string[] }>;
}) {
  const parsed = configSchema.parse({
    pipeline: {
      runtimeDir: "/tmp/rt",
      agentsDir: AGENTS_DIR,
    },
    agents: {
      ...(overrides?.agentNames ? { names: overrides.agentNames } : {}),
      ...(overrides?.maxTurns ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides?.timeoutsMinutes ? { timeoutsMinutes: overrides.timeoutsMinutes } : {}),
      ...(overrides?.tools ? { tools: overrides.tools } : {}),
    },
  });
  return resolveConfig(parsed);
}

function writeAgentMd(stage: string, content: string): void {
  writeFileSync(join(AGENTS_DIR, `${stage}.md`), content, "utf-8");
}

function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    stage: "questions",
    slug: "my-task",
    taskContent: "Build the feature",
    previousOutput: "",
    outputPath: "/tmp/output/questions.md",
    cwd: "/tmp/cwd",
    config: makeConfig(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };
}

// ─── buildSystemPrompt ───────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  beforeAll(() => {
    // Write agent MD files used across tests (plain instructions, no frontmatter)
    writeAgentMd("questions", "Ask good questions.");
    writeAgentMd("research", "Investigate the codebase thoroughly.");
    writeAgentMd("pr", "Open the pull request.");
    writeAgentMd("impl", "Implement the feature.");
  });

  it("includes identity block with agent name", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("You are Gargi, the questions agent");
  });

  it("includes pipeline context section", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("Pipeline: ShaktimaanAI | Task: my-task | Stage: questions");
  });

  it("includes task content for stages that should see it (questions)", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("## Task");
    expect(result).toContain("Build the feature");
  });

  it("omits task content for research stage (QRSPI blind)", () => {
    const result = buildSystemPrompt(
      makeOptions({ stage: "research", previousOutput: "some questions" }),
    );
    expect(result).not.toContain("## Task");
    // The task text should not appear in the prompt
    expect(result).not.toContain("Build the feature");
  });

  it("uses stage-specific label for previous output (research -> Questions to Investigate)", () => {
    const result = buildSystemPrompt(
      makeOptions({ stage: "research", previousOutput: "Q1: Why?" }),
    );
    expect(result).toContain("## Questions to Investigate");
    expect(result).toContain("Q1: Why?");
  });

  it("omits previous output section when label is null (questions — first stage)", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    // Should not have any previous output heading (Output Instructions is fine — that's the capture directive)
    expect(result).not.toMatch(/## .*(?:Previous|Questions to Investigate)/);
  });

  it("omits repo context for stages that don't need it (pr)", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "pr" }));
    expect(result).not.toContain("## Repo Context");
  });

  it("includes agent instructions from MD file", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("Ask good questions.");
  });

  it("includes output instructions at the end", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    // Read-only agents get text-capture instructions instead of file-write directives
    expect(result).toContain("## Output Instructions");
  });

  it("uses custom agent name from config override", () => {
    const config = makeConfig({ agentNames: { impl: "MyCustomAgent" } });
    const result = buildSystemPrompt(makeOptions({ stage: "impl", config }));
    expect(result).toContain("You are MyCustomAgent, the impl agent");
  });

  it("injects repo context when task has a repo path with CLAUDE.md", () => {
    writeFileSync(join(REPO_DIR, "CLAUDE.md"), "# Project Rules\nDo not break things.", "utf-8");

    const taskContent = `# Task: Test task\n\n## Repo\n${REPO_DIR}\n\n## What I want done\nDo something`;
    const result = buildSystemPrompt(
      makeOptions({ stage: "research", taskContent, previousOutput: "some q" }),
    );
    expect(result).toContain("CLAUDE.md");
    expect(result).toContain("Do not break things");
  });

  it("shows (none) for previous output when empty and section is included", () => {
    const result = buildSystemPrompt(
      makeOptions({ stage: "research", previousOutput: "" }),
    );
    expect(result).toContain("## Questions to Investigate");
    expect(result).toContain("(none)");
  });

  it("includes ## User Guidance section when task file has hints for current stage", () => {
    const taskContent = `# Task: Test task

## What I want done
Build something.

## Stage Hints
questions: focus on edge cases
`;
    const result = buildSystemPrompt(makeOptions({ stage: "questions", taskContent }));
    expect(result).toContain("## User Guidance");
    expect(result).toContain("- focus on edge cases");
  });

  it("includes ## User Guidance section with runtime hints from options.stageHints", () => {
    const result = buildSystemPrompt(
      makeOptions({
        stage: "questions",
        stageHints: { questions: ["prefer concise questions", "limit to 5 questions"] },
      }),
    );
    expect(result).toContain("## User Guidance");
    expect(result).toContain("- prefer concise questions");
    expect(result).toContain("- limit to 5 questions");
  });

  it("merges task file hints and runtime hints into User Guidance", () => {
    const taskContent = `# Task: Test task

## What I want done
Build something.

## Stage Hints
impl: use async/await
`;
    const result = buildSystemPrompt(
      makeOptions({
        stage: "impl",
        taskContent,
        stageHints: { impl: ["avoid global state"] },
      }),
    );
    expect(result).toContain("## User Guidance");
    expect(result).toContain("- use async/await");
    expect(result).toContain("- avoid global state");
  });

  it("omits ## User Guidance section when no hints exist for the stage", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).not.toContain("## User Guidance");
  });

  it("omits ## User Guidance when hints exist for a different stage only", () => {
    const taskContent = `# Task: Test task

## What I want done
Build something.

## Stage Hints
design: use modular patterns
`;
    const result = buildSystemPrompt(makeOptions({ stage: "questions", taskContent }));
    expect(result).not.toContain("## User Guidance");
  });
});

// ─── resolveToolPermissions (2 params) ───────────────────────────────────────

describe("resolveToolPermissions", () => {
  it("uses DEFAULT_STAGE_TOOLS when no config override (questions gets WebSearch etc)", () => {
    const config = makeConfig();
    const result = resolveToolPermissions("questions", config);
    expect(result.allowed).toContain("WebSearch");
    expect(result.allowed).toContain("Read");
    expect(result.disallowed).toEqual(["Write", "Edit"]);
  });

  it("config-level tool override wins over DEFAULT_STAGE_TOOLS", () => {
    const config = makeConfig({
      tools: {
        questions: { allowed: ["Read", "Bash", "Write"], disallowed: [] },
      },
    });
    const result = resolveToolPermissions("questions", config);
    expect(result.allowed).toEqual(["Read", "Bash", "Write"]);
    expect(result.disallowed).toEqual([]);
  });

  it("falls back to read-only default for unknown stages", () => {
    const config = makeConfig();
    const result = resolveToolPermissions("unknown-stage", config);
    expect(result.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(result.disallowed).toEqual([]);
  });
});

// ─── resolveMaxTurns (2 params) ──────────────────────────────────────────────

describe("resolveMaxTurns", () => {
  it("prefers config value over default (questions -> 30)", () => {
    const config = makeConfig();
    const result = resolveMaxTurns("questions", config);
    expect(result).toBe(30);
  });

  it("falls back to 30 for unknown stage", () => {
    const config = makeConfig();
    const result = resolveMaxTurns("unknown-stage", config);
    expect(result).toBe(30);
  });
});

// ─── resolveTimeoutMinutes (2 params) ────────────────────────────────────────

describe("resolveTimeoutMinutes", () => {
  it("prefers config value over default (questions -> 15)", () => {
    const config = makeConfig();
    const result = resolveTimeoutMinutes("questions", config);
    expect(result).toBe(15);
  });

  it("falls back to 30 for unknown stage", () => {
    const config = makeConfig();
    const result = resolveTimeoutMinutes("unknown-stage", config);
    expect(result).toBe(30);
  });
});

// ─── buildAgentSystemPrompt ──────────────────────────────────────────────────

describe("buildAgentSystemPrompt", () => {
  beforeAll(() => {
    writeAgentMd("questions", "# Ask good questions\nGather information.");
    writeAgentMd("validate", "# Validate\nRun tests.");
  });

  it("includes identity and agent instructions", () => {
    const result = buildAgentSystemPrompt(makeOptions());
    expect(result).toContain("questions agent");
    expect(result).toContain("Ask good questions");
  });

  it("does NOT include task content or previous output", () => {
    const result = buildAgentSystemPrompt(makeOptions({
      taskContent: "Build a feature",
      previousOutput: "Research findings here",
    }));
    expect(result).not.toContain("Build a feature");
    expect(result).not.toContain("Research findings here");
  });

  it("includes pipeline context with stage list", () => {
    const result = buildAgentSystemPrompt(makeOptions());
    expect(result).toContain("Stage: questions");
    expect(result).toContain("my-task");
  });
});

// ─── buildAgentUserPrompt ────────────────────────────────────────────────────

describe("buildAgentUserPrompt", () => {
  beforeAll(() => {
    writeAgentMd("questions", "# Ask questions");
    writeAgentMd("design", "# Design");
    writeAgentMd("validate", "# Validate");
  });

  it("includes task content when includeTaskContent is true", () => {
    const result = buildAgentUserPrompt(makeOptions({
      stage: "questions",
      taskContent: "Build a feature",
    }));
    expect(result).toContain("Build a feature");
  });

  it("excludes task content when includeTaskContent is false", () => {
    // research has includeTaskContent: false
    writeAgentMd("research", "# Research");
    const result = buildAgentUserPrompt(makeOptions({
      stage: "research",
      taskContent: "Build a feature",
    }));
    expect(result).not.toContain("Build a feature");
  });

  it("excludes previous output when previousOutputLabel is null", () => {
    // questions has previousOutputLabel: null
    const result = buildAgentUserPrompt(makeOptions({
      stage: "questions",
      previousOutput: "Should not appear",
    }));
    expect(result).not.toContain("Should not appear");
  });

  it("includes previous output when previousOutputLabel is set", () => {
    const result = buildAgentUserPrompt(makeOptions({
      stage: "design",
      previousOutput: "Research findings",
    }));
    expect(result).toContain("Research findings");
    expect(result).toContain("Research Findings"); // the label
  });

  it("uses repoSummary when useRepoSummary is set and summary exists", () => {
    const result = buildAgentUserPrompt(makeOptions({
      stage: "validate",
      repoSummary: "npm test runs vitest",
    }));
    expect(result).toContain("npm test runs vitest");
  });

  it("falls back to gatherRepoContext when useRepoSummary is set but no summary", () => {
    // validate has useRepoSummary: true, includeRepoContext: false
    // with no repoSummary, should still get repo context via fallback
    mkdirSync(REPO_DIR, { recursive: true });
    writeFileSync(join(REPO_DIR, "package.json"), '{"name":"test"}', "utf-8");
    const taskContent = `# Task: test\n\n## What I want done\ntest\n\n## Repo\n${REPO_DIR}\n\n## Pipeline Config\nstages: validate\nreview_after: design\n`;
    const result = buildAgentUserPrompt(makeOptions({
      stage: "validate",
      taskContent,
      repoSummary: undefined,
    }));
    expect(result).toContain("Repo Context");
  });
});

// ─── filterMcpToolsByTaskNeeds ───────────────────────────────────────────────

describe("filterMcpToolsByTaskNeeds", () => {
  const allTools = [
    "Read", "Glob", "Grep", "Bash",
    "mcp__claude_ai_Slack__slack_read_channel",
    "mcp__claude_ai_Slack__slack_send_message",
    "mcp__plugin_notion_notion__notion-search",
    "mcp__plugin_figma_figma__get_design_context",
  ];

  it("passes all tools through when requiredMcpServers is empty", () => {
    expect(filterMcpToolsByTaskNeeds(allTools, [])).toEqual(allTools);
  });

  it("passes all tools through when requiredMcpServers is undefined", () => {
    expect(filterMcpToolsByTaskNeeds(allTools, undefined)).toEqual(allTools);
  });

  it("keeps only Slack MCP tools when task needs only slack", () => {
    const result = filterMcpToolsByTaskNeeds(allTools, ["slack"]);
    expect(result).toContain("Read");
    expect(result).toContain("mcp__claude_ai_Slack__slack_read_channel");
    expect(result).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(result).not.toContain("mcp__plugin_notion_notion__notion-search");
    expect(result).not.toContain("mcp__plugin_figma_figma__get_design_context");
  });

  it("keeps Slack and Notion when task needs both", () => {
    const result = filterMcpToolsByTaskNeeds(allTools, ["slack", "notion"]);
    expect(result).toContain("mcp__claude_ai_Slack__slack_read_channel");
    expect(result).toContain("mcp__plugin_notion_notion__notion-search");
    expect(result).not.toContain("mcp__plugin_figma_figma__get_design_context");
  });

  it("handles wildcard tool patterns", () => {
    const tools = ["Read", "mcp__claude_ai_Slack__*", "mcp__plugin_notion_notion__*"];
    const result = filterMcpToolsByTaskNeeds(tools, ["slack"]);
    expect(result).toEqual(["Read", "mcp__claude_ai_Slack__*"]);
  });

  it("always keeps non-MCP tools", () => {
    const result = filterMcpToolsByTaskNeeds(allTools, ["figma"]);
    expect(result).toContain("Read");
    expect(result).toContain("Glob");
    expect(result).toContain("Grep");
    expect(result).toContain("Bash");
  });

  it("adds MCP tools for required servers not in original allowedTools", () => {
    // impl stage has no MCP tools by default
    const implTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
    const result = filterMcpToolsByTaskNeeds(implTools, ["notion", "figma"]);
    expect(result).toContain("Read");
    expect(result).toContain("Write");
    expect(result).toContain("mcp__plugin_notion_notion__*");
    expect(result).toContain("mcp__plugin_figma_figma__*");
    expect(result).not.toContain("mcp__claude_ai_Slack__*");
  });

  it("does not duplicate MCP patterns already present", () => {
    const tools = ["Read", "mcp__claude_ai_Slack__slack_read_channel"];
    const result = filterMcpToolsByTaskNeeds(tools, ["slack"]);
    expect(result).toEqual(["Read", "mcp__claude_ai_Slack__slack_read_channel"]);
    // Should NOT add mcp__claude_ai_Slack__* since a Slack tool is already present
  });
});

// ─── resolveAdviserModel ─────────────────────────────────────────────────────

describe("resolveAdviserModel", () => {
  function makeAdviserConfig(overrides: {
    enabled?: boolean;
    model?: string;
    stages?: string[];
  } = {}) {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/rt" },
      agents: {
        adviser: {
          enabled: overrides.enabled ?? false,
          model: overrides.model,
          stages: overrides.stages,
        },
      },
    });
    return resolveConfig(parsed);
  }

  it("returns undefined when adviser is disabled (default)", () => {
    const config = makeAdviserConfig({ enabled: false });
    expect(resolveAdviserModel("questions", config)).toBeUndefined();
  });

  it("returns undefined for a stage not in adviser.stages even when enabled", () => {
    const config = makeAdviserConfig({ enabled: true, stages: ["impl"] });
    expect(resolveAdviserModel("questions", config)).toBeUndefined();
  });

  it("returns the adviser model for a stage in adviser.stages when enabled", () => {
    const config = makeAdviserConfig({ enabled: true, stages: ["questions"] });
    expect(resolveAdviserModel("questions", config)).toBe("claude-opus-4-6");
  });

  it("returns a custom adviser model when configured", () => {
    const config = makeAdviserConfig({
      enabled: true,
      model: "claude-opus-4-6",
      stages: ["validate"],
    });
    expect(resolveAdviserModel("validate", config)).toBe("claude-opus-4-6");
  });

  it("defaults to DEFAULT_ADVISER_STAGES (non-opus stages) when stages not specified", () => {
    const config = makeAdviserConfig({ enabled: true });
    // Stages that should get adviser by default
    expect(resolveAdviserModel("questions", config)).toBe("claude-opus-4-6");
    expect(resolveAdviserModel("research", config)).toBe("claude-opus-4-6");
    expect(resolveAdviserModel("validate", config)).toBe("claude-opus-4-6");
    expect(resolveAdviserModel("review", config)).toBe("claude-opus-4-6");
    expect(resolveAdviserModel("quick", config)).toBe("claude-opus-4-6");
    // Opus stages should not get adviser by default
    expect(resolveAdviserModel("impl", config)).toBeUndefined();
    expect(resolveAdviserModel("design", config)).toBeUndefined();
    expect(resolveAdviserModel("plan", config)).toBeUndefined();
    expect(resolveAdviserModel("recovery", config)).toBeUndefined();
  });

  it("handles unknown stage gracefully (returns undefined)", () => {
    const config = makeAdviserConfig({ enabled: true });
    expect(resolveAdviserModel("unknown-stage", config)).toBeUndefined();
  });
});
