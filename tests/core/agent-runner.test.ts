import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getStageTools, buildSystemPrompt } from "../../src/core/agent-runner.js";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import type { AgentRunOptions } from "../../src/core/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeConfig(agentNames?: Record<string, string>) {
  const parsed = configSchema.parse({
    pipeline: { runtimeDir: "/tmp/rt" },
    agents: agentNames ? { names: agentNames } : undefined,
  });
  return resolveConfig(parsed);
}

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-runner-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// ─── getStageTools ───────────────────────────────────────────────────────────

describe("getStageTools", () => {
  it("questions: allows Read/Glob/Grep, disallows Write/Edit/Bash", () => {
    const tools = getStageTools("questions");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(tools.allowed).not.toContain("Write");
    expect(tools.allowed).not.toContain("Edit");
    expect(tools.allowed).not.toContain("Bash");
  });

  it("research: allows Read/Glob/Grep/Bash, disallows Write/Edit", () => {
    const tools = getStageTools("research");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(tools.allowed).not.toContain("Write");
    expect(tools.allowed).not.toContain("Edit");
  });

  it("design: allows Read/Glob/Grep, disallows Write/Edit/Bash", () => {
    const tools = getStageTools("design");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("structure: allows Read/Glob/Grep, disallows Write/Edit/Bash", () => {
    const tools = getStageTools("structure");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("plan: allows Read/Glob/Grep, disallows Write/Edit/Bash", () => {
    const tools = getStageTools("plan");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("impl: allows all tools (Read/Write/Edit/Bash/Glob/Grep), nothing disallowed", () => {
    const tools = getStageTools("impl");
    expect(tools.allowed).toEqual(
      expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Glob", "Grep"])
    );
    expect(tools.disallowed).toHaveLength(0);
  });

  it("validate: allows Read/Bash/Glob/Grep, disallows Write/Edit", () => {
    const tools = getStageTools("validate");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Bash", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(tools.allowed).not.toContain("Write");
    expect(tools.allowed).not.toContain("Edit");
  });

  it("review: allows Read/Glob/Grep, disallows Write/Edit/Bash", () => {
    const tools = getStageTools("review");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("pr: allows Bash, disallows Write/Edit", () => {
    const tools = getStageTools("pr");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Bash"]));
    expect(tools.disallowed).toEqual(expect.arrayContaining(["Write", "Edit"]));
  });

  it("classify: nothing allowed, all tools disallowed", () => {
    const tools = getStageTools("classify");
    expect(tools.allowed).toHaveLength(0);
    expect(tools.disallowed).toEqual(
      expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Glob", "Grep"])
    );
  });

  it("unknown stage: defaults to Read/Glob/Grep allowed, nothing disallowed", () => {
    const tools = getStageTools("some-unknown-stage");
    expect(tools.allowed).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(tools.disallowed).toHaveLength(0);
  });
});

// ─── buildSystemPrompt ───────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
    return {
      stage: "questions",
      slug: "my-task",
      taskContent: "Build the feature",
      previousOutput: "",
      outputPath: "/tmp/output/questions.md",
      cwd: "/tmp/cwd",
      config: makeConfig(),
      templateDir: TEST_DIR,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      ...overrides,
    };
  }

  it("hydrates agent name from config.agents.names for known stage", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Agent: {{AGENT_NAME}} | Role: {{AGENT_ROLE}}",
      "utf-8"
    );

    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    // DEFAULT_AGENT_NAMES.questions === "Narada"
    expect(result).toContain("Agent: Narada");
    expect(result).toContain("Role: questions");
  });

  it("falls back to stage name when agent name not in config", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-custom.md"),
      "Agent: {{AGENT_NAME}}",
      "utf-8"
    );

    // makeConfig() with no overrides uses DEFAULT_AGENT_NAMES which has no "custom" key
    const result = buildSystemPrompt(makeOptions({ stage: "custom" }));
    // No entry for "custom" → falls back to stage name
    expect(result).toContain("Agent: custom");
  });

  it("injects task content into {{TASK_CONTENT}}", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Task: {{TASK_CONTENT}}",
      "utf-8"
    );

    const result = buildSystemPrompt(makeOptions({ taskContent: "Implement login flow" }));
    expect(result).toContain("Task: Implement login flow");
  });

  it("injects output path into {{OUTPUT_PATH}}", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Out: {{OUTPUT_PATH}}",
      "utf-8"
    );

    const result = buildSystemPrompt(
      makeOptions({ outputPath: "/repo/output/questions.md" })
    );
    expect(result).toContain("Out: /repo/output/questions.md");
  });

  it("uses '(none)' for previousOutput when empty string", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Prev: {{PREVIOUS_OUTPUT}}",
      "utf-8"
    );

    const result = buildSystemPrompt(makeOptions({ previousOutput: "" }));
    expect(result).toContain("Prev: (none)");
  });

  it("injects real previousOutput when provided", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Prev: {{PREVIOUS_OUTPUT}}",
      "utf-8"
    );

    const result = buildSystemPrompt(makeOptions({ previousOutput: "previous stage output" }));
    expect(result).toContain("Prev: previous stage output");
  });

  it("includes pipeline context with correct format", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "Ctx: {{PIPELINE_CONTEXT}}",
      "utf-8"
    );

    const result = buildSystemPrompt(makeOptions({ slug: "auth-feature", stage: "questions" }));
    expect(result).toContain("Pipeline: ShaktimaanAI | Task: auth-feature | Stage: questions");
  });

  it("uses custom agent name from config override", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-impl.md"),
      "Agent: {{AGENT_NAME}}",
      "utf-8"
    );

    const config = makeConfig({ impl: "MyCustomAgent" });
    const result = buildSystemPrompt(makeOptions({ stage: "impl", config }));
    expect(result).toContain("Agent: MyCustomAgent");
  });
});
