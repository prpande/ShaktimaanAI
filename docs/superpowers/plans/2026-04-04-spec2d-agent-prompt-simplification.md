# Spec 2d: Agent Prompt Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip agent MD files to pure prompt instructions, move all operational metadata to TypeScript code, and have `buildSystemPrompt` compose prompts via code with stage-specific context rules.

**Architecture:** Agent MD files become pure prompt text (no frontmatter, no template variables). `defaults.ts` gains `DEFAULT_STAGE_TOOLS` and `STAGE_CONTEXT_RULES` data structures. `buildSystemPrompt` assembles prompts by concatenating standard sections (identity, pipeline context, task, previous output, repo context) with the agent's instructions, using per-stage rules to determine which sections to include.

**Tech Stack:** TypeScript, vitest, Node.js fs

---

### Task 1: Add `DEFAULT_STAGE_TOOLS` and `STAGE_CONTEXT_RULES` to defaults.ts

**Files:**
- Modify: `src/config/defaults.ts`
- Test: `tests/config/defaults.test.ts`

- [ ] **Step 1: Write failing tests for DEFAULT_STAGE_TOOLS**

In `tests/config/defaults.test.ts`, add:

```typescript
import { DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES } from "../../src/config/defaults.js";

describe("DEFAULT_STAGE_TOOLS", () => {
  it("has entries for all 10 stages", () => {
    const stages = ["questions","research","design","structure","plan","impl","validate","review","pr","classify"];
    for (const stage of stages) {
      expect(DEFAULT_STAGE_TOOLS[stage]).toBeDefined();
      expect(DEFAULT_STAGE_TOOLS[stage].allowed).toBeInstanceOf(Array);
      expect(DEFAULT_STAGE_TOOLS[stage].disallowed).toBeInstanceOf(Array);
    }
  });

  it("impl has full write access", () => {
    expect(DEFAULT_STAGE_TOOLS["impl"].allowed).toContain("Write");
    expect(DEFAULT_STAGE_TOOLS["impl"].allowed).toContain("Edit");
    expect(DEFAULT_STAGE_TOOLS["impl"].allowed).toContain("Bash");
    expect(DEFAULT_STAGE_TOOLS["impl"].disallowed).toEqual([]);
  });

  it("classify has no allowed tools", () => {
    expect(DEFAULT_STAGE_TOOLS["classify"].allowed).toEqual([]);
  });

  it("research has MCP tool patterns", () => {
    expect(DEFAULT_STAGE_TOOLS["research"].allowed).toContain("mcp__claude_ai_Slack__*");
    expect(DEFAULT_STAGE_TOOLS["research"].allowed).toContain("mcp__plugin_notion_notion__*");
  });

  it("review is read-only", () => {
    expect(DEFAULT_STAGE_TOOLS["review"].disallowed).toContain("Write");
    expect(DEFAULT_STAGE_TOOLS["review"].disallowed).toContain("Edit");
    expect(DEFAULT_STAGE_TOOLS["review"].disallowed).toContain("Bash");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — `DEFAULT_STAGE_TOOLS` is not exported

- [ ] **Step 3: Add DEFAULT_STAGE_TOOLS to defaults.ts**

In `src/config/defaults.ts`, add after `DEFAULT_AGENT_NAMES`:

```typescript
export const DEFAULT_STAGE_TOOLS: Record<string, { allowed: string[]; disallowed: string[] }> = {
  questions:  { allowed: ["Read","Glob","Grep","Bash","WebSearch","WebFetch"], disallowed: ["Write","Edit"] },
  research:   { allowed: ["Read","Glob","Grep","Bash","WebSearch","WebFetch","mcp__claude_ai_Slack__*","mcp__plugin_notion_notion__*"], disallowed: ["Write","Edit"] },
  design:     { allowed: ["Read","Glob","Grep","Bash"], disallowed: ["Write","Edit"] },
  structure:  { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  plan:       { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  impl:       { allowed: ["Read","Write","Edit","Bash","Glob","Grep"], disallowed: [] },
  validate:   { allowed: ["Read","Bash","Glob","Grep"], disallowed: ["Write","Edit"] },
  review:     { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  pr:         { allowed: ["Bash"], disallowed: ["Write","Edit","Read","Glob","Grep"] },
  classify:   { allowed: [], disallowed: ["Read","Write","Edit","Bash","Glob","Grep"] },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for STAGE_CONTEXT_RULES**

In `tests/config/defaults.test.ts`, add:

```typescript
describe("STAGE_CONTEXT_RULES", () => {
  it("has entries for all 10 stages", () => {
    const stages = ["questions","research","design","structure","plan","impl","validate","review","pr","classify"];
    for (const stage of stages) {
      expect(STAGE_CONTEXT_RULES[stage]).toBeDefined();
      expect(typeof STAGE_CONTEXT_RULES[stage].includeTaskContent).toBe("boolean");
      expect(typeof STAGE_CONTEXT_RULES[stage].includeRepoContext).toBe("boolean");
    }
  });

  it("research does NOT include task content (QRSPI blind)", () => {
    expect(STAGE_CONTEXT_RULES["research"].includeTaskContent).toBe(false);
  });

  it("research labels previous output as Questions to Investigate", () => {
    expect(STAGE_CONTEXT_RULES["research"].previousOutputLabel).toBe("Questions to Investigate");
  });

  it("questions has no previous output label (first stage)", () => {
    expect(STAGE_CONTEXT_RULES["questions"].previousOutputLabel).toBeNull();
  });

  it("classify has no previous output and no repo context", () => {
    expect(STAGE_CONTEXT_RULES["classify"].previousOutputLabel).toBeNull();
    expect(STAGE_CONTEXT_RULES["classify"].includeRepoContext).toBe(false);
  });

  it("impl includes task content, previous output as Implementation Plan, and repo context", () => {
    expect(STAGE_CONTEXT_RULES["impl"].includeTaskContent).toBe(true);
    expect(STAGE_CONTEXT_RULES["impl"].previousOutputLabel).toBe("Implementation Plan");
    expect(STAGE_CONTEXT_RULES["impl"].includeRepoContext).toBe(true);
  });

  it("structure excludes task content and repo context", () => {
    expect(STAGE_CONTEXT_RULES["structure"].includeTaskContent).toBe(false);
    expect(STAGE_CONTEXT_RULES["structure"].includeRepoContext).toBe(false);
  });

  it("pr excludes repo context", () => {
    expect(STAGE_CONTEXT_RULES["pr"].includeRepoContext).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: FAIL — `STAGE_CONTEXT_RULES` is not exported

- [ ] **Step 7: Add STAGE_CONTEXT_RULES to defaults.ts**

In `src/config/defaults.ts`, add after `DEFAULT_STAGE_TOOLS`:

```typescript
export const STAGE_CONTEXT_RULES: Record<string, {
  includeTaskContent: boolean;
  previousOutputLabel: string | null;
  includeRepoContext: boolean;
}> = {
  questions: { includeTaskContent: true,  previousOutputLabel: null,                     includeRepoContext: true },
  research:  { includeTaskContent: false, previousOutputLabel: "Questions to Investigate", includeRepoContext: true },
  design:    { includeTaskContent: true,  previousOutputLabel: "Research Findings",       includeRepoContext: true },
  structure: { includeTaskContent: false, previousOutputLabel: "Design Document",         includeRepoContext: false },
  plan:      { includeTaskContent: false, previousOutputLabel: "Implementation Slices",   includeRepoContext: true },
  impl:      { includeTaskContent: true,  previousOutputLabel: "Implementation Plan",     includeRepoContext: true },
  validate:  { includeTaskContent: false, previousOutputLabel: "Implementation Output",   includeRepoContext: true },
  review:    { includeTaskContent: true,  previousOutputLabel: "Validation Report",       includeRepoContext: true },
  pr:        { includeTaskContent: true,  previousOutputLabel: "Review Output",           includeRepoContext: false },
  classify:  { includeTaskContent: true,  previousOutputLabel: null,                     includeRepoContext: false },
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/config/defaults.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/config/defaults.ts tests/config/defaults.test.ts
git commit -m "feat(config): add DEFAULT_STAGE_TOOLS and STAGE_CONTEXT_RULES to defaults"
```

---

### Task 2: Replace `agent-config.ts` with simple `loadAgentPrompt`

**Files:**
- Modify: `src/core/agent-config.ts`
- Modify: `tests/core/agent-config.test.ts`

- [ ] **Step 1: Write failing tests for the new loadAgentPrompt**

Replace the entire contents of `tests/core/agent-config.test.ts` with:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAgentPrompt } from "../../src/core/agent-config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-config-" + Date.now());

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("loadAgentPrompt", () => {
  it("returns the full file content as a string", () => {
    const content = "## Instructions\n\nDo the thing.\n\n## Self-Validation\n\n- Check it.";
    writeFileSync(join(TEST_DIR, "questions.md"), content, "utf-8");

    const result = loadAgentPrompt(TEST_DIR, "questions");
    expect(result).toBe(content);
  });

  it("throws when agent file does not exist", () => {
    expect(() => loadAgentPrompt(TEST_DIR, "nonexistent")).toThrow(/Agent prompt not found/);
  });

  it("returns content with no frontmatter processing (raw file read)", () => {
    const content = "---\nstage: test\n---\nBody here";
    writeFileSync(join(TEST_DIR, "raw.md"), content, "utf-8");

    // loadAgentPrompt does NOT parse frontmatter — returns raw content
    const result = loadAgentPrompt(TEST_DIR, "raw");
    expect(result).toBe(content);
  });

  it("handles empty file gracefully", () => {
    writeFileSync(join(TEST_DIR, "empty.md"), "", "utf-8");
    const result = loadAgentPrompt(TEST_DIR, "empty");
    expect(result).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: FAIL — `loadAgentPrompt` is not exported

- [ ] **Step 3: Replace agent-config.ts with loadAgentPrompt**

Replace the entire contents of `src/core/agent-config.ts` with:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the agent prompt body from {agentDir}/{stage}.md.
 * Returns the raw file content — no frontmatter parsing, no variable substitution.
 * Agent MD files are pure prompt instructions.
 */
export function loadAgentPrompt(agentDir: string, stage: string): string {
  const filePath = join(agentDir, `${stage}.md`);

  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Agent prompt not found for stage "${stage}" at "${filePath}". ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/agent-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-config.ts tests/core/agent-config.test.ts
git commit -m "refactor(agent-config): replace frontmatter parser with simple loadAgentPrompt"
```

---

### Task 3: Rewrite `buildSystemPrompt` and `resolveToolPermissions` in agent-runner.ts

**Files:**
- Modify: `src/core/agent-runner.ts`
- Modify: `tests/core/agent-runner.test.ts`

- [ ] **Step 1: Write failing tests for the new buildSystemPrompt**

Replace the entire contents of `tests/core/agent-runner.test.ts` with:

```typescript
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
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("includes identity block with agent name and role", () => {
    writeAgentMd("questions", "Ask good questions.");
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("You are Narada, the questions agent");
  });

  it("includes pipeline context section", () => {
    writeAgentMd("questions", "Ask good questions.");
    const result = buildSystemPrompt(makeOptions({ stage: "questions", slug: "test-slug" }));
    expect(result).toContain("Pipeline: ShaktimaanAI | Task: test-slug | Stage: questions");
  });

  it("includes task content for stages that should see it", () => {
    writeAgentMd("questions", "Ask good questions.");
    const result = buildSystemPrompt(makeOptions({ stage: "questions", taskContent: "Build a widget" }));
    expect(result).toContain("## Task");
    expect(result).toContain("Build a widget");
  });

  it("omits task content for research stage (QRSPI blind)", () => {
    writeAgentMd("research", "Investigate the questions.");
    const result = buildSystemPrompt(makeOptions({ stage: "research", taskContent: "Build a widget" }));
    expect(result).not.toContain("## Task");
    expect(result).not.toContain("Build a widget");
  });

  it("uses stage-specific label for previous output", () => {
    writeAgentMd("research", "Investigate the questions.");
    const result = buildSystemPrompt(makeOptions({
      stage: "research",
      previousOutput: "Q1: How does auth work?",
    }));
    expect(result).toContain("## Questions to Investigate");
    expect(result).toContain("Q1: How does auth work?");
  });

  it("omits previous output section when label is null (first stage)", () => {
    writeAgentMd("questions", "Ask good questions.");
    const result = buildSystemPrompt(makeOptions({
      stage: "questions",
      previousOutput: "should not appear",
    }));
    expect(result).not.toContain("should not appear");
  });

  it("omits repo context for stages that do not need it", () => {
    writeAgentMd("classify", "Classify this.");
    const result = buildSystemPrompt(makeOptions({ stage: "classify" }));
    expect(result).not.toContain("## Repo Context");
  });

  it("includes agent instructions from MD file", () => {
    writeAgentMd("questions", "## Instructions\n\nAsk targeted questions about the codebase.");
    const result = buildSystemPrompt(makeOptions({ stage: "questions" }));
    expect(result).toContain("Ask targeted questions about the codebase.");
  });

  it("includes output path directive at the end", () => {
    writeAgentMd("questions", "Ask good questions.");
    const result = buildSystemPrompt(makeOptions({
      stage: "questions",
      outputPath: "/tmp/artifacts/questions-output.md",
    }));
    expect(result).toContain("Write your output to: /tmp/artifacts/questions-output.md");
  });

  it("uses custom agent name from config override", () => {
    writeAgentMd("impl", "Write the code.");
    const config = makeConfig({ agentNames: { impl: "MyCustomAgent" } });
    const result = buildSystemPrompt(makeOptions({ stage: "impl", config }));
    expect(result).toContain("You are MyCustomAgent, the impl agent");
  });

  it("injects repo context when task has a repo path with CLAUDE.md", () => {
    writeFileSync(join(REPO_DIR, "CLAUDE.md"), "# Project Rules\nDo not break things.", "utf-8");
    writeAgentMd("design", "Design the architecture.");

    const taskContent = `# Task: Test task\n\n## Repo\n${REPO_DIR}\n\n## What I want done\nDo something`;
    const result = buildSystemPrompt(makeOptions({ stage: "design", taskContent }));

    expect(result).toContain("## Repo Context");
    expect(result).toContain("Do not break things");
  });

  it("shows (none) for previous output when empty and section is included", () => {
    writeAgentMd("research", "Investigate.");
    const result = buildSystemPrompt(makeOptions({ stage: "research", previousOutput: "" }));
    expect(result).toContain("## Questions to Investigate");
    expect(result).toContain("(none)");
  });
});

describe("resolveToolPermissions", () => {
  it("uses DEFAULT_STAGE_TOOLS when no config override", () => {
    const config = makeConfig();
    const result = resolveToolPermissions("questions", config);
    expect(result.allowed).toContain("Read");
    expect(result.allowed).toContain("WebSearch");
    expect(result.disallowed).toContain("Write");
  });

  it("config-level tool override wins over DEFAULT_STAGE_TOOLS", () => {
    const parsed = configSchema.parse({
      pipeline: { runtimeDir: "/tmp/rt", agentsDir: AGENTS_DIR },
      agents: {
        tools: {
          questions: { allowed: ["Read", "Bash"], disallowed: [] },
        },
      },
    });
    const config = resolveConfig(parsed);
    const result = resolveToolPermissions("questions", config);
    expect(result.allowed).toEqual(["Read", "Bash"]);
    expect(result.disallowed).toEqual([]);
  });

  it("falls back to read-only default for unknown stages", () => {
    const config = makeConfig();
    const result = resolveToolPermissions("unknown-stage", config);
    expect(result.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(result.disallowed).toEqual([]);
  });
});

describe("resolveMaxTurns", () => {
  it("prefers config value over default", () => {
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

describe("resolveTimeoutMinutes", () => {
  it("prefers config value over default", () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: FAIL — `resolveToolPermissions` signature changed, `buildSystemPrompt` behavior changed

- [ ] **Step 3: Rewrite agent-runner.ts**

Replace the entire contents of `src/core/agent-runner.ts` with:

```typescript
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentPrompt } from "./agent-config.js";
import { gatherRepoContext } from "./repo-context.js";
import { parseTaskFile } from "../task/parser.js";
import { DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES } from "../config/defaults.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";

// ─── findShippedAgentsDir ────────────────────────────────────────────────────

function findShippedAgentsDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(thisDir, "..", "..");
    return join(projectRoot, "agents");
  } catch {
    return join(process.cwd(), "agents");
  }
}

/** Resolves the agents directory: config override or shipped agents. */
export function resolveAgentsDir(config: ResolvedConfig): string {
  return config.pipeline.agentsDir || findShippedAgentsDir();
}

// ─── Tool permission resolver ────────────────────────────────────────────────

const DEFAULT_READ_ONLY_TOOLS = { allowed: ["Read", "Glob", "Grep"], disallowed: [] as string[] };

/**
 * Resolves tool permissions for a pipeline stage.
 * Priority: config.agents.tools[stage] → DEFAULT_STAGE_TOOLS[stage] → read-only fallback.
 */
export function resolveToolPermissions(
  stage: string,
  config: ResolvedConfig,
): { allowed: string[]; disallowed: string[] } {
  // Config-level override wins
  const configTools = config.agents.tools[stage];
  if (configTools) {
    const stageDefaults = DEFAULT_STAGE_TOOLS[stage] ?? DEFAULT_READ_ONLY_TOOLS;
    return {
      allowed: configTools.allowed ?? stageDefaults.allowed,
      disallowed: configTools.disallowed ?? stageDefaults.disallowed,
    };
  }

  // Code-level defaults
  return DEFAULT_STAGE_TOOLS[stage] ?? { ...DEFAULT_READ_ONLY_TOOLS };
}

// ─── Max turns resolver ───────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30;

/**
 * Resolves the max turns for a pipeline stage.
 * Priority: config.agents.maxTurns[stage] ?? DEFAULT_CONFIG default ?? 30
 */
export function resolveMaxTurns(stage: string, config: ResolvedConfig): number {
  return config.agents.maxTurns[stage] ?? DEFAULT_MAX_TURNS;
}

// ─── Timeout resolver ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Resolves the timeout in minutes for a pipeline stage.
 * Priority: config.agents.timeoutsMinutes[stage] ?? 30
 */
export function resolveTimeoutMinutes(stage: string, config: ResolvedConfig): number {
  return config.agents.timeoutsMinutes[stage] ?? DEFAULT_TIMEOUT_MINUTES;
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Composes the full system prompt for an agent by assembling standard sections
 * (identity, pipeline context, task, previous output, repo context) around
 * the agent-specific instructions from the MD file. Stage-specific context
 * rules determine which sections are included.
 */
export function buildSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, previousOutput, outputPath, config } = options;

  // Load the agent's instruction body
  const agentsDir = resolveAgentsDir(config);
  const agentInstructions = loadAgentPrompt(agentsDir, stage);

  // Resolve context rules for this stage
  const rules = STAGE_CONTEXT_RULES[stage] ?? {
    includeTaskContent: true,
    previousOutputLabel: "Previous Output",
    includeRepoContext: true,
  };

  // Resolve agent display name
  const agentName = config.agents.names[stage] ?? stage;

  // Parse task for repo path and stage list
  const taskMeta = parseTaskFile(taskContent);
  const stageList = (taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages).join(", ");

  // Build prompt sections
  const sections: string[] = [];

  // Identity
  sections.push(`# Identity\n\nYou are ${agentName}, the ${stage} agent in the ShaktimaanAI pipeline.`);

  // Pipeline context
  sections.push(`## Pipeline Context\n\nPipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}\nStage sequence for this task: ${stageList}`);

  // Task content (conditional)
  if (rules.includeTaskContent) {
    sections.push(`## Task\n\n${taskContent}`);
  }

  // Previous output (conditional)
  if (rules.previousOutputLabel !== null) {
    const content = previousOutput || "(none)";
    sections.push(`## ${rules.previousOutputLabel}\n\n${content}`);
  }

  // Repo context (conditional)
  if (rules.includeRepoContext) {
    const repoContext = gatherRepoContext(taskMeta.repo);
    sections.push(`## Repo Context\n\n${repoContext}`);
  }

  // Agent instructions
  sections.push(`---\n\n${agentInstructions}`);

  // Output path directive
  sections.push(`---\n\nWrite your output to: ${outputPath}`);

  return sections.join("\n\n");
}

// ─── Agent runner ────────────────────────────────────────────────────────────

/**
 * Runs the Claude agent SDK for the given stage and options.
 * Uses per-stage tool permissions from DEFAULT_STAGE_TOOLS (with config overrides),
 * a composed system prompt, and enforces a configurable timeout via AbortController.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const { allowed: allowedTools, disallowed: disallowedTools } = resolveToolPermissions(stage, config);
  const systemPrompt = buildSystemPrompt(options);

  const maxTurns = resolveMaxTurns(stage, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, config);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const abortController = externalAbort ?? new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  timeoutHandle = setTimeout(() => {
    logger.warn(`[agent-runner] Stage "${stage}" timed out after ${timeoutMinutes}m — aborting`);
    abortController.abort();
  }, timeoutMs);

  try {
    let output = "";
    let costUsd = 0;
    let turns = 0;
    let receivedResult = false;

    const messages = query({
      prompt: systemPrompt,
      allowedTools,
      disallowedTools,
      maxTurns,
      cwd,
      abortController,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    });

    for await (const message of messages) {
      if (message.type === "result") {
        receivedResult = true;
        if (message.subtype === "success") {
          const msg = message as Record<string, unknown>;
          output = typeof msg.result === "string" ? msg.result : "";
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
        } else {
          const msg = message as Record<string, unknown>;
          const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : [];
          return {
            success: false,
            output: "",
            costUsd: 0,
            turns: 0,
            durationMs: Date.now() - startMs,
            error: errors.join("; ") || "Agent returned error result",
          };
        }
      }
    }

    if (!receivedResult) {
      return {
        success: false,
        output: "",
        costUsd: 0,
        turns: 0,
        durationMs: Date.now() - startMs,
        error: "No result message received from agent — stream completed without a result",
      };
    }

    return {
      success: true,
      output,
      costUsd,
      turns,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-runner] Stage "${stage}" threw: ${message}`);
    return {
      success: false,
      output: "",
      costUsd: 0,
      turns: 0,
      durationMs: Date.now() - startMs,
      error: message,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Update resolveToolPermissions call sites**

`resolveToolPermissions` changed from 3 params `(stage, agentTools, config)` to 2 params `(stage, config)`. Update any remaining callers:

- `tests/core/config-additions.test.ts` — if it has `resolveToolPermissions` tests with the old signature, remove them (covered by the new tests in this task).
- `src/core/agent-runner.ts` — already updated in Step 3.

Also update `resolveMaxTurns` and `resolveTimeoutMinutes` — they changed from 3 params `(stage, agentValue, config)` to 2 params `(stage, config)`. No other files call these directly.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-runner.ts tests/core/agent-runner.test.ts tests/core/config-additions.test.ts
git commit -m "refactor(agent-runner): compose prompts from sections, use DEFAULT_STAGE_TOOLS"
```

---

### Task 4: Delete template.ts and its tests

**Files:**
- Delete: `src/core/template.ts`
- Delete: `tests/core/template.test.ts`

- [ ] **Step 1: Remove import of hydrateTemplate from any remaining files**

Check that no file imports from `template.ts`. After Task 3, agent-runner.ts no longer imports it.

Run: `grep -r "template" src/ --include="*.ts" -l`

If any file still imports from `./template.js`, update it. (After Task 3 there should be none.)

- [ ] **Step 2: Delete the files**

```bash
rm src/core/template.ts tests/core/template.test.ts
```

- [ ] **Step 3: Verify no broken imports**

Run: `npx vitest run`
Expected: All tests pass (template.test.ts no longer exists, so it won't run)

- [ ] **Step 4: Commit**

```bash
git add -u src/core/template.ts tests/core/template.test.ts
git commit -m "refactor: remove template.ts — prompts now composed in code"
```

---

### Task 5: Rewrite all agent MD files as pure prompt instructions

**Files:**
- Modify: `agents/questions.md`
- Modify: `agents/research.md`
- Modify: `agents/design.md`
- Modify: `agents/structure.md`
- Modify: `agents/plan.md`
- Modify: `agents/impl.md`
- Modify: `agents/validate.md`
- Modify: `agents/review.md`
- Modify: `agents/pr.md`
- Modify: `agents/classify.md`
- Modify: `agents/agent-template.md`

Each file is rewritten to contain ONLY the agent-specific instructions — no YAML frontmatter, no `{{VARIABLE}}` placeholders, no identity/context/task/output boilerplate sections. The exact content for each file is specified in the Spec 2d design document Section 2.1 and was extracted during brainstorming.

- [ ] **Step 1: Rewrite agents/questions.md**

Remove frontmatter and all boilerplate sections. Keep only: the intro paragraph about questions being handed to the research agent, the Instructions section (Phase 1 and Phase 2), the Self-Validation section, and the Output Format section. Remove the `# Identity`, `## Pipeline Context`, `## Repo Context`, `## Task` sections, and the `Write your output to: {{OUTPUT_PATH}}` line.

- [ ] **Step 2: Rewrite agents/research.md**

Remove frontmatter and boilerplate. Keep only: the Instructions section (investigation protocol, evidence standards, what NOT to do), Self-Validation, and Output Format.

- [ ] **Step 3: Rewrite agents/design.md**

Remove frontmatter and boilerplate. Keep only: Instructions (Phase 1-4), Self-Validation, and Output Format.

- [ ] **Step 4: Rewrite agents/structure.md**

Remove frontmatter and boilerplate. Keep only: Instructions (input handling, decomposition rules, per-slice fields), Self-Validation, and Output Format.

- [ ] **Step 5: Rewrite agents/plan.md**

Remove frontmatter and boilerplate. Keep only: Instructions (plan structure, TDD requirements, precision requirements, what NOT to do), Self-Validation, and Output Format.

- [ ] **Step 6: Rewrite agents/impl.md**

Remove frontmatter and boilerplate. Keep only: Step 0 (retry check), Step 1 (discover environment), Step 2 (TDD implementation), Step 3 (verify completeness), and Output Summary. Remove the `## Implementation Plan` / `{{PREVIOUS_OUTPUT}}` section and `Write your output to: {{OUTPUT_PATH}}`.

- [ ] **Step 7: Rewrite agents/validate.md**

Remove frontmatter and boilerplate. Keep only: Steps 1-5 (discover, build, test, analyse, verdict).

- [ ] **Step 8: Rewrite agents/review.md**

Remove frontmatter and boilerplate. Keep only: Review Process (Steps 1-3), Findings Format, Retry Iteration Guidance, and Verdict sections.

- [ ] **Step 9: Rewrite agents/pr.md**

Remove frontmatter and boilerplate. Keep only: Steps 1-6 (verify, push, discover template, extract ADO, create PR, output URL).

- [ ] **Step 10: Rewrite agents/classify.md**

Remove frontmatter and boilerplate. Keep only: the Instructions block with JSON output format and example.

- [ ] **Step 11: Rewrite agents/agent-template.md**

Replace with a minimal guide for creating new agents:

```markdown
# Agent Template

This file is a starting point for creating new pipeline agents.

Write the agent's purpose, behavioral rules, and output format below.
Do NOT add YAML frontmatter or {{VARIABLE}} placeholders — the pipeline
engine composes the full prompt automatically (identity, context sections,
and output path are injected by code).

To register a new agent stage, also add entries in:
- `src/config/defaults.ts` → DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES, maxTurns, timeoutsMinutes
- `src/core/stage-map.ts` → PIPELINE_STAGES, STAGE_DIR_MAP

---

## Instructions

[Describe the agent's purpose and responsibilities here.]

[Describe the inputs the agent receives and what it should do with them.]

[Describe the expected output format.]

## Self-Validation

Before finishing, verify:
- [List verification checks here]
```

- [ ] **Step 12: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 13: Commit**

```bash
git add agents/
git commit -m "refactor(agents): strip MD files to pure prompt instructions — no frontmatter, no variables"
```

---

### Task 6: Update existing spec documents

**Files:**
- Modify: `docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md`
- Modify: `docs/superpowers/specs/2026-04-04-spec2b-alignment-agents-design.md`
- Modify: `docs/superpowers/specs/2026-04-04-spec2c-execution-agents-design.md`

- [ ] **Step 1: Update system design doc Section 13.2**

In `docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md`, update Section 13.2 (npm Package) to replace `src/templates/prompt-*.md` with `agents/*.md` and note they contain pure prompt instructions (no frontmatter).

- [ ] **Step 2: Update system design doc Section 17**

Replace the template format description and `{{VARIABLE}}` pattern explanation with a description of code-composed prompts. Update the "Adding a new agent" steps to reflect the new process (MD file + `defaults.ts` entries + stage map).

- [ ] **Step 3: Update spec 2b design doc**

Add a note at the top of the Agent Config via Markdown section and Template Variable Enhancement section indicating these were superseded by Spec 2d (agent prompt simplification). Agent config frontmatter was replaced with code-level defaults; template variables were replaced with code-composed prompts.

- [ ] **Step 4: Update spec 2c design doc**

Add a note to any sections referencing `{{VARIABLE}}` template patterns or agent MD frontmatter, indicating superseded by Spec 2d.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/
git commit -m "docs: update specs 1, 2b, 2c to reflect Spec 2d agent prompt simplification"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass with no regressions

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 3: Verify agents/ directory is in dist/**

Run: `ls dist/agents/`
Expected: All 11 `.md` files present (questions, research, design, structure, plan, impl, validate, review, pr, classify, agent-template)

- [ ] **Step 4: Spot-check a composed prompt**

Manually verify that `buildSystemPrompt` for the `research` stage produces a prompt that:
- Has identity block with the agent name
- Has pipeline context
- Does NOT have a `## Task` section (QRSPI blind)
- Has `## Questions to Investigate` with previous output
- Has `## Repo Context`
- Has the agent instructions from `agents/research.md`
- Ends with output path directive

This is already covered by tests but a manual sanity check is valuable.
