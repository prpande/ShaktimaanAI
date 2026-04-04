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
    writeAgentMd("classify", "Classify the intent.");
    writeAgentMd("impl", "Implement the feature.");
  });

  it("includes identity block with agent name", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("You are Narada, the questions agent");
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
    // Should not have any previous output heading
    expect(result).not.toMatch(/## .*(?:Previous|Output|Questions)/);
  });

  it("omits repo context for stages that don't need it (classify)", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "classify" }));
    expect(result).not.toContain("## Repo Context");
  });

  it("includes agent instructions from MD file", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("Ask good questions.");
  });

  it("includes output path directive at the end", () => {
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("Write your output to: /tmp/output/questions.md");
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
  it("prefers config value over default (questions -> 15)", () => {
    const config = makeConfig();
    const result = resolveMaxTurns("questions", config);
    expect(result).toBe(15);
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
