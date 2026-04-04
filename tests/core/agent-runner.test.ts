import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildSystemPrompt,
  resolveToolPermissions,
  resolveMaxTurns,
  resolveTimeoutMinutes,
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

function makeConfig(overrides?: { agentNames?: Record<string, string>; maxTurns?: Record<string, number>; timeoutsMinutes?: Record<string, number> }) {
  const parsed = configSchema.parse({
    pipeline: {
      runtimeDir: "/tmp/rt",
      agentsDir: AGENTS_DIR,
    },
    agents: {
      ...(overrides?.agentNames ? { names: overrides.agentNames } : {}),
      ...(overrides?.maxTurns ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides?.timeoutsMinutes ? { timeoutsMinutes: overrides.timeoutsMinutes } : {}),
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
    templateDir: AGENTS_DIR,
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
  it("loads prompt from agent config file and hydrates all variables", () => {
    writeAgentMd(
      "questions",
      `---
stage: questions
description: Ask clarifying questions
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
---
Agent: {{AGENT_NAME}} | Role: {{AGENT_ROLE}} | Task: {{TASK_CONTENT}} | Prev: {{PREVIOUS_OUTPUT}} | Out: {{OUTPUT_PATH}} | Ctx: {{PIPELINE_CONTEXT}} | Repo: {{REPO_CONTEXT}} | RepoPath: {{REPO_PATH}} | Stages: {{STAGE_LIST}}`,
    );

    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));

    // AGENT_NAME — Narada from default config
    expect(result).toContain("Agent: Narada");
    // AGENT_ROLE
    expect(result).toContain("Role: questions");
    // TASK_CONTENT
    expect(result).toContain("Task: Build the feature");
    // PREVIOUS_OUTPUT — empty string becomes "(none)"
    expect(result).toContain("Prev: (none)");
    // OUTPUT_PATH
    expect(result).toContain("Out: /tmp/output/questions.md");
    // PIPELINE_CONTEXT
    expect(result).toContain("Pipeline: ShaktimaanAI | Task: my-task | Stage: questions");
    // REPO_CONTEXT — no repo in task content, so fallback message
    expect(result).toContain("Repo:");
    // REPO_PATH
    expect(result).toContain("RepoPath:");
    // STAGE_LIST
    expect(result).toContain("Stages:");
  });

  it("injects repo context when task has a repo path with CLAUDE.md", () => {
    writeFileSync(join(REPO_DIR, "CLAUDE.md"), "# Project Rules\nDo not break things.", "utf-8");

    writeAgentMd(
      "research",
      `---
stage: research
description: Research the codebase
---
{{REPO_CONTEXT}}`,
    );

    const taskContent = `# Task: Test task\n\n## Repo\n${REPO_DIR}\n\n## What I want done\nDo something`;

    const result = buildSystemPrompt(
      makeOptions({ stage: "research", taskContent }),
    );

    expect(result).toContain("CLAUDE.md");
    expect(result).toContain("Do not break things");
  });

  it("uses custom agent name from config override", () => {
    writeAgentMd(
      "impl",
      `---
stage: impl
description: Implement the feature
---
Agent: {{AGENT_NAME}}`,
    );

    const config = makeConfig({ agentNames: { impl: "MyCustomAgent" } });
    const result = buildSystemPrompt(makeOptions({ stage: "impl", config }));
    expect(result).toContain("Agent: MyCustomAgent");
  });
});

// ─── resolveToolPermissions ───────────────────────────────────────────────────

describe("resolveToolPermissions", () => {
  it("returns tools from agent config when agent config has allowed tools", () => {
    const agentTools = { allowed: ["Read", "Bash", "Glob"], disallowed: ["Write", "Edit"] };
    const config = makeConfig();
    const result = resolveToolPermissions("research", agentTools, config);
    expect(result.allowed).toEqual(["Read", "Bash", "Glob"]);
    expect(result.disallowed).toEqual(["Write", "Edit"]);
  });

  it("returns default read-only tools when agent config has no tools (empty allowed)", () => {
    const agentTools = { allowed: [], disallowed: [] };
    const config = makeConfig();
    const result = resolveToolPermissions("questions", agentTools, config);
    expect(result.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(result.disallowed).toEqual([]);
  });
});

// ─── resolveMaxTurns ─────────────────────────────────────────────────────────

describe("resolveMaxTurns", () => {
  it("prefers config value over agent config value", () => {
    // config.agents.maxTurns.questions defaults to 15; agent says 25 → should return 15
    const config = makeConfig();
    const result = resolveMaxTurns("questions", 25, config);
    expect(result).toBe(15);
  });

  it("uses agent config value when no config override for that stage", () => {
    // "unknown-stage" won't be in config.agents.maxTurns → falls through to agentMaxTurns
    const config = makeConfig();
    const result = resolveMaxTurns("unknown-stage", 25, config);
    expect(result).toBe(25);
  });

  it("falls back to 30 when neither source has a value", () => {
    const config = makeConfig();
    const result = resolveMaxTurns("unknown-stage", undefined, config);
    expect(result).toBe(30);
  });
});

// ─── resolveTimeoutMinutes ───────────────────────────────────────────────────

describe("resolveTimeoutMinutes", () => {
  it("prefers config value over agent config value", () => {
    // config.agents.timeoutsMinutes.questions defaults to 15; agent says 60 → 15
    const config = makeConfig();
    const result = resolveTimeoutMinutes("questions", 60, config);
    expect(result).toBe(15);
  });

  it("falls back to 30 when neither source has a value", () => {
    const config = makeConfig();
    const result = resolveTimeoutMinutes("unknown-stage", undefined, config);
    expect(result).toBe(30);
  });
});
