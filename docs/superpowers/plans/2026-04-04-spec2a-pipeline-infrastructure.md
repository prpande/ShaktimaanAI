# Spec 2a: Pipeline Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pipeline engine, file watcher (Heimdall), task creator (Brahma), intent classifier (Sutradhaar), approval handler (Indra), agent runner, agent registry, crash recovery, and start/stop CLI commands — the runtime backbone that all agents execute within.

**Architecture:** Factory-function design (no classes) for all stateful components. Dependency injection for testability — the pipeline accepts an agent runner function, enabling stub injection in tests. Move-then-act pattern for crash safety: task directories relocate atomically via `renameSync` before agents start. Run state stored as JSON alongside task files. Chokidar watches inbox for new `.task` files. Claude Agent SDK (`query()`) wraps all LLM agent calls.

**Tech Stack:** TypeScript, Node.js 20+, chokidar (file watching), @anthropic-ai/claude-agent-sdk (agent runtime), vitest (testing). Builds on Spec 1 foundation (config, task parser, runtime dirs).

**Reference:** [System Design Document](../specs/2026-04-04-shaktimaanai-system-design.md) | [Spec 1 Plan](./2026-04-04-spec1-core-foundation-cli.md)

---

## File Structure

```
src/
├── core/
│   ├── types.ts               ← Shared pipeline types (RunState, stages, etc.)
│   ├── logger.ts              ← Per-task + system file logging
│   ├── template.ts            ← {{VAR}} template hydrator + loader
│   ├── agent-runner.ts        ← Claude Agent SDK wrapper
│   ├── registry.ts            ← Agent concurrency registry
│   ├── pipeline.ts            ← Stage machine, transitions, run orchestration
│   ├── brahma.ts              ← Canonical task creator
│   ├── sutradhaar.ts          ← Intent classifier (keywords + LLM fallback)
│   ├── indra.ts               ← Approval handler
│   ├── heimdall.ts            ← Chokidar file watcher on inbox
│   └── recovery.ts            ← Crash recovery (startup dir scan)
├── config/
│   └── resolve-path.ts        ← Extract resolveConfigPath from cli.ts (shared)
├── commands/
│   ├── start.ts               ← Modify: real implementation
│   └── stop.ts                ← Modify: real implementation
├── templates/
│   ├── prompt-questions.md    ← Stub template (Spec 2b replaces)
│   ├── prompt-research.md     ← Stub template
│   ├── prompt-design.md       ← Stub template
│   ├── prompt-structure.md    ← Stub template
│   ├── prompt-plan.md         ← Stub template
│   ├── prompt-impl.md         ← Stub template (Spec 2c replaces)
│   ├── prompt-validate.md     ← Stub template
│   ├── prompt-review.md       ← Stub template
│   ├── prompt-classify.md     ← Sutradhaar intent classification prompt
│   └── agent-template.md      ← Blank template for new agents
tests/
├── core/
│   ├── logger.test.ts
│   ├── template.test.ts
│   ├── agent-runner.test.ts
│   ├── registry.test.ts
│   ├── pipeline.test.ts
│   ├── brahma.test.ts
│   ├── sutradhaar.test.ts
│   ├── indra.test.ts
│   ├── heimdall.test.ts
│   └── recovery.test.ts
├── config/
│   └── resolve-path.test.ts
```

---

## Dependencies

New npm packages required:

| Package | Version | Purpose |
|---|---|---|
| `chokidar` | `^5.0.0` | File watching for Heimdall |
| `@anthropic-ai/claude-agent-sdk` | `^0.2.92` | Agent runtime for LLM-powered stages |

---

### Task 1: Dependencies & Core Types

**Files:**
- Modify: `package.json`
- Create: `src/core/types.ts`
- Create: `src/config/resolve-path.ts`
- Create: `tests/config/resolve-path.test.ts`
- Modify: `src/cli.ts` (remove inline `resolveConfigPath`, import from new location)

- [ ] **Step 1: Install new dependencies**

```bash
cd C:/src/ShaktimaanAI && npm install chokidar@^5.0.0 @anthropic-ai/claude-agent-sdk@^0.2.92
```

- [ ] **Step 2: Create shared pipeline types**

Create `src/core/types.ts`:

```typescript
import type { TaskMeta } from "../task/parser.js";

/**
 * Pipeline stage names (logical). Maps to directory names via STAGE_DIR_MAP.
 */
export type PipelineStage =
  | "questions"
  | "research"
  | "design"
  | "structure"
  | "plan"
  | "impl"
  | "validate"
  | "review"
  | "pr";

/** Valid values for RunState.status */
export type RunStatus = "running" | "hold" | "complete" | "failed";

/** Record of a completed pipeline stage */
export interface CompletedStage {
  stage: string;
  completedAt: string;
  outputFile?: string;
  costUsd?: number;
  turns?: number;
}

/**
 * Persistent state for a single pipeline run.
 * Stored as run-state.json alongside the task file.
 */
export interface RunState {
  slug: string;
  taskFile: string;
  stages: string[];
  reviewAfter: string;
  currentStage: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedStages: CompletedStage[];
  error?: string;
}

/** Options passed to the agent runner for a single stage execution */
export interface AgentRunOptions {
  stage: string;
  slug: string;
  taskContent: string;
  previousOutput: string;
  outputPath: string;
  cwd: string;
  config: import("../config/loader.js").ResolvedConfig;
  templateDir: string;
  abortController?: AbortController;
  logger: import("./logger.js").TaskLogger;
}

/** Result returned from a single agent run */
export interface AgentRunResult {
  success: boolean;
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
}

/** Injectable agent runner function type — stub in tests, real SDK in production */
export type AgentRunnerFn = (options: AgentRunOptions) => Promise<AgentRunResult>;
```

- [ ] **Step 3: Extract resolveConfigPath to shared module**

Create `src/config/resolve-path.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the path to shkmn.config.json.
 * Priority: SHKMN_CONFIG env → ./shkmn.config.json → ~/.shkmn/runtime/shkmn.config.json
 */
export function resolveConfigPath(): string {
  // 1. Environment variable
  const envPath = process.env.SHKMN_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  // 2. Current directory
  const localPath = join(process.cwd(), "shkmn.config.json");
  if (existsSync(localPath)) return localPath;

  // 3. Home directory default
  const homePath = join(homedir(), ".shkmn", "runtime", "shkmn.config.json");
  if (existsSync(homePath)) return homePath;

  console.error(
    "Config not found. Searched:\n" +
    `  $SHKMN_CONFIG=${envPath ?? "(not set)"}\n` +
    `  ${localPath}\n` +
    `  ${homePath}\n` +
    "Run 'shkmn init' to create a config."
  );
  process.exit(1);
}
```

- [ ] **Step 4: Write test for resolveConfigPath**

Create `tests/config/resolve-path.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "shkmn-test-resolve-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.SHKMN_CONFIG;
});

describe("resolveConfigPath", () => {
  it("returns SHKMN_CONFIG env path when file exists", async () => {
    const configFile = join(TEST_DIR, "custom.config.json");
    writeFileSync(configFile, "{}");
    process.env.SHKMN_CONFIG = configFile;

    // Dynamic import to pick up env change
    const { resolveConfigPath } = await import("../../src/config/resolve-path.js");
    expect(resolveConfigPath()).toBe(configFile);
  });
});
```

- [ ] **Step 5: Run test, verify it passes**

```bash
npx vitest run tests/config/resolve-path.test.ts --reporter=verbose
```

Expected: PASS

- [ ] **Step 6: Update cli.ts to import from shared module**

In `src/cli.ts`, replace the inline `resolveConfigPath` function with:

```typescript
import { resolveConfigPath } from "./config/resolve-path.js";
```

Remove the entire `function resolveConfigPath()` body from cli.ts. Keep all other code unchanged.

- [ ] **Step 7: Verify existing tests still pass**

```bash
npx vitest run --reporter=verbose
```

Expected: All existing tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/config/resolve-path.ts tests/config/resolve-path.test.ts src/cli.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat: add pipeline core types, extract resolveConfigPath, install chokidar + agent SDK

Foundation for Spec 2a: shared RunState/AgentRunOptions types,
extracted config path resolution to shared module, added chokidar
and @anthropic-ai/claude-agent-sdk dependencies.
EOF
)"
```

---

### Task 2: Logger

**Files:**
- Create: `src/core/logger.ts`
- Create: `tests/core/logger.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/core/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatLogLine, createTaskLogger, createSystemLogger } from "../../src/core/logger.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-logger-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("formatLogLine", () => {
  it("formats with ISO timestamp, uppercased level, and message", () => {
    const line = formatLogLine("info", "hello world");
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] hello world\n$/);
  });

  it("uppercases any level string", () => {
    expect(formatLogLine("error", "x")).toContain("[ERROR]");
    expect(formatLogLine("warn", "x")).toContain("[WARN]");
  });
});

describe("createTaskLogger", () => {
  it("writes info, warn, error lines to {slug}.log", () => {
    const logger = createTaskLogger(TEST_DIR, "my-task");
    logger.info("step one");
    logger.warn("heads up");
    logger.error("broke");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf-8");
    expect(content).toContain("[INFO] step one");
    expect(content).toContain("[WARN] heads up");
    expect(content).toContain("[ERROR] broke");
  });

  it("creates the log directory if it does not exist", () => {
    const nested = join(TEST_DIR, "deep", "logs");
    const logger = createTaskLogger(nested, "deep-task");
    logger.info("works");
    expect(existsSync(join(nested, "deep-task.log"))).toBe(true);
  });

  it("appends to existing log file", () => {
    const logger = createTaskLogger(TEST_DIR, "append-task");
    logger.info("line 1");
    logger.info("line 2");

    const lines = readFileSync(join(TEST_DIR, "append-task.log"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("createSystemLogger", () => {
  it("writes to heimdall.log", () => {
    const logger = createSystemLogger(TEST_DIR);
    logger.info("system boot");

    const content = readFileSync(join(TEST_DIR, "heimdall.log"), "utf-8");
    expect(content).toContain("[INFO] system boot");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/logger.test.ts --reporter=verbose
```

Expected: FAIL — module `../../src/core/logger.js` does not exist

- [ ] **Step 3: Write implementation**

Create `src/core/logger.ts`:

```typescript
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TaskLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function formatLogLine(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
}

export function createTaskLogger(logDir: string, slug: string): TaskLogger {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${slug}.log`);

  const write = (level: string, message: string) => {
    appendFileSync(logFile, formatLogLine(level, message));
  };

  return {
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}

export function createSystemLogger(logDir: string): TaskLogger {
  return createTaskLogger(logDir, "heimdall");
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/logger.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/logger.ts tests/core/logger.test.ts
git commit -m "$(cat <<'EOF'
feat: add per-task and system logger with file-based output
EOF
)"
```

---

### Task 3: Template Hydrator & Stub Templates

**Files:**
- Create: `src/core/template.ts`
- Create: `tests/core/template.test.ts`
- Create: `src/templates/prompt-questions.md` (and 9 other template files)

- [ ] **Step 1: Write tests**

Create `tests/core/template.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hydrateTemplate, loadTemplate } from "../../src/core/template.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-template-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("hydrateTemplate", () => {
  it("replaces all {{VAR}} placeholders with values", () => {
    const result = hydrateTemplate(
      "Hello {{NAME}}, your role is {{ROLE}}.",
      { NAME: "Narada", ROLE: "questions" },
    );
    expect(result).toBe("Hello Narada, your role is questions.");
  });

  it("leaves unmatched placeholders unchanged", () => {
    const result = hydrateTemplate("{{KNOWN}} and {{UNKNOWN}}", { KNOWN: "yes" });
    expect(result).toBe("yes and {{UNKNOWN}}");
  });

  it("handles template with no placeholders", () => {
    expect(hydrateTemplate("plain text", { FOO: "bar" })).toBe("plain text");
  });

  it("handles empty vars object", () => {
    expect(hydrateTemplate("{{A}}", {})).toBe("{{A}}");
  });

  it("replaces multiple occurrences of same var", () => {
    expect(hydrateTemplate("{{X}} and {{X}}", { X: "y" })).toBe("y and y");
  });
});

describe("loadTemplate", () => {
  it("loads prompt-{name}.md from the template directory", () => {
    writeFileSync(join(TEST_DIR, "prompt-questions.md"), "You are {{AGENT_NAME}}");
    const content = loadTemplate(TEST_DIR, "questions");
    expect(content).toBe("You are {{AGENT_NAME}}");
  });

  it("throws if template file does not exist", () => {
    expect(() => loadTemplate(TEST_DIR, "nonexistent")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/template.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/template.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function hydrateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

export function loadTemplate(templateDir: string, templateName: string): string {
  const filePath = join(templateDir, `prompt-${templateName}.md`);
  return readFileSync(filePath, "utf-8");
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/template.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Create stub prompt templates**

Create `src/templates/prompt-questions.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ PREVIOUS STAGE OUTPUT ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Generate targeted technical questions about this task that will help the Research agent
investigate the codebase effectively. Focus on architecture, dependencies, existing patterns,
and potential risks.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown with numbered questions grouped by category.
```

Create `src/templates/prompt-research.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

IMPORTANT: You do NOT see the original task description. You only see the questions
from the Questions agent. Answer them factually based on what you find in the codebase.

═══ QUESTIONS TO INVESTIGATE ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Investigate the codebase to answer each question factually. Do not speculate.
Read files, search for patterns, and document what you find.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown with each question followed by your factual findings.
```

Create `src/templates/prompt-design.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ RESEARCH FINDINGS ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Create an architectural design document for this task. Consider the research findings,
existing patterns, and the task requirements. Propose a design that fits the codebase.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown design document with sections for approach, file changes, interfaces, and risks.
```

Create `src/templates/prompt-structure.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ DESIGN DOCUMENT ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Decompose the design into vertical slices — each slice is an independently testable unit
of work. Order slices so earlier ones don't depend on later ones.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown with numbered slices, each containing scope, files, and acceptance criteria.
```

Create `src/templates/prompt-plan.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ VERTICAL SLICES ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Create a tactical implementation plan for each slice. Include exact file paths,
test-first approach (red-green-refactor), and specific code changes needed.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown with per-slice implementation steps.
```

Create `src/templates/prompt-impl.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ IMPLEMENTATION PLAN ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Implement the code changes specified in the plan. Follow TDD: write tests first,
verify they fail, write implementation, verify tests pass.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Summary of changes made, files modified, and test results.
```

Create `src/templates/prompt-validate.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ IMPLEMENTATION SUMMARY ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Discover and run the build and test commands for this repository. Verify that
all tests pass and the build succeeds. Report any failures.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Build/test command output with pass/fail summary.
```

Create `src/templates/prompt-review.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ IMPLEMENTATION + VALIDATION ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
Review the code changes for quality, correctness, security, and adherence to
project conventions. If issues are found, describe them clearly so the Impl agent
can fix them.

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
Format: Markdown review with PASS/FAIL verdict and list of issues (if any).
```

Create `src/templates/prompt-classify.md`:

```markdown
You are {{AGENT_NAME}}, the intent classifier for the ShaktimaanAI pipeline.

═══ USER INPUT ═══
{{TASK_CONTENT}}

═══ YOUR JOB ═══
Classify the user's intent into exactly one of these categories:
- create_task: User wants to create a new development task
- approve: User wants to approve a task at a review gate
- status: User wants to know the status of pipeline tasks
- cancel: User wants to cancel or abort a running task
- unknown: Intent is unclear — ask for clarification

Also extract any task slug mentioned (kebab-case identifiers like "fix-auth-bug-20260404-103000")
and the core content of the request.

═══ OUTPUT ═══
Respond with ONLY valid JSON, no markdown fences, no extra text:
{"intent":"create_task|approve|status|cancel|unknown","confidence":0.0,"extractedSlug":null,"extractedContent":""}
```

Create `src/templates/agent-template.md`:

```markdown
{{PIPELINE_CONTEXT}}

You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent in the ShaktimaanAI pipeline.

═══ TASK ═══
{{TASK_CONTENT}}

═══ PREVIOUS STAGE OUTPUT ═══
{{PREVIOUS_OUTPUT}}

═══ YOUR JOB ═══
[Describe what this agent does]

═══ OUTPUT ═══
Write your output to EXACTLY this path: {{OUTPUT_PATH}}
[Describe the expected output format]
```

- [ ] **Step 6: Commit**

```bash
git add src/core/template.ts tests/core/template.test.ts src/templates/
git commit -m "$(cat <<'EOF'
feat: add template hydrator and stub prompt templates for all pipeline stages
EOF
)"
```

---

### Task 4: Agent Runner

**Files:**
- Create: `src/core/agent-runner.ts`
- Create: `tests/core/agent-runner.test.ts`

- [ ] **Step 1: Write tests for pure functions (getStageTools, buildSystemPrompt)**

Create `tests/core/agent-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStageTools, buildSystemPrompt } from "../../src/core/agent-runner.js";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-runner-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("getStageTools", () => {
  it("returns read-only tools for questions stage", () => {
    const tools = getStageTools("questions");
    expect(tools.allowed).toContain("Read");
    expect(tools.allowed).toContain("Glob");
    expect(tools.allowed).toContain("Grep");
    expect(tools.disallowed).toContain("Write");
    expect(tools.disallowed).toContain("Edit");
    expect(tools.disallowed).toContain("Bash");
  });

  it("returns read-only tools for research stage (plus Bash for exploration)", () => {
    const tools = getStageTools("research");
    expect(tools.allowed).toContain("Bash");
    expect(tools.disallowed).toContain("Write");
  });

  it("returns full write tools for impl stage", () => {
    const tools = getStageTools("impl");
    expect(tools.allowed).toContain("Write");
    expect(tools.allowed).toContain("Edit");
    expect(tools.allowed).toContain("Bash");
    expect(tools.disallowed).toHaveLength(0);
  });

  it("returns no tools for classify stage", () => {
    const tools = getStageTools("classify");
    expect(tools.allowed).toHaveLength(0);
  });

  it("returns safe defaults for unknown stage", () => {
    const tools = getStageTools("some-custom-stage");
    expect(tools.allowed).toContain("Read");
    expect(tools.disallowed).toHaveLength(0);
  });
});

describe("buildSystemPrompt", () => {
  it("hydrates template with agent name and task content", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-questions.md"),
      "You are {{AGENT_NAME}}, the {{AGENT_ROLE}} agent.\nTask: {{TASK_CONTENT}}\nOutput: {{OUTPUT_PATH}}",
    );

    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/rt" } });
    const config = resolveConfig(parsed);

    const prompt = buildSystemPrompt({
      stage: "questions",
      slug: "test-slug",
      taskContent: "Fix login bug",
      previousOutput: "",
      outputPath: "/tmp/out.md",
      cwd: "/tmp",
      config,
      templateDir: TEST_DIR,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(prompt).toContain("Narada");
    expect(prompt).toContain("questions");
    expect(prompt).toContain("Fix login bug");
    expect(prompt).toContain("/tmp/out.md");
  });

  it("includes previous output in hydrated prompt", () => {
    writeFileSync(
      join(TEST_DIR, "prompt-design.md"),
      "Previous: {{PREVIOUS_OUTPUT}}",
    );

    const parsed = configSchema.parse({ pipeline: { runtimeDir: "/tmp/rt" } });
    const config = resolveConfig(parsed);

    const prompt = buildSystemPrompt({
      stage: "design",
      slug: "s",
      taskContent: "",
      previousOutput: "Research findings here",
      outputPath: "/tmp/o.md",
      cwd: "/tmp",
      config,
      templateDir: TEST_DIR,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(prompt).toContain("Research findings here");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/agent-runner.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/agent-runner.ts`:

```typescript
import { hydrateTemplate, loadTemplate } from "./template.js";
import type { TaskLogger } from "./logger.js";
import type { ResolvedConfig } from "../config/loader.js";
import type { AgentRunOptions, AgentRunResult } from "./types.js";

/** Per-stage tool permissions. Scoped to principle of least privilege. */
const STAGE_TOOLS: Record<string, { allowed: string[]; disallowed: string[] }> = {
  questions:  { allowed: ["Read", "Glob", "Grep"], disallowed: ["Write", "Edit", "Bash"] },
  research:   { allowed: ["Read", "Glob", "Grep", "Bash"], disallowed: ["Write", "Edit"] },
  design:     { allowed: ["Read", "Glob", "Grep"], disallowed: ["Write", "Edit", "Bash"] },
  structure:  { allowed: ["Read", "Glob", "Grep"], disallowed: ["Write", "Edit", "Bash"] },
  plan:       { allowed: ["Read", "Glob", "Grep"], disallowed: ["Write", "Edit", "Bash"] },
  impl:       { allowed: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"], disallowed: [] },
  validate:   { allowed: ["Read", "Bash", "Glob", "Grep"], disallowed: ["Write", "Edit"] },
  review:     { allowed: ["Read", "Glob", "Grep"], disallowed: ["Write", "Edit", "Bash"] },
  pr:         { allowed: ["Bash"], disallowed: ["Write", "Edit"] },
  classify:   { allowed: [], disallowed: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] },
};

export function getStageTools(stage: string): { allowed: string[]; disallowed: string[] } {
  return STAGE_TOOLS[stage] ?? { allowed: ["Read", "Glob", "Grep"], disallowed: [] };
}

export function buildSystemPrompt(options: AgentRunOptions): string {
  const template = loadTemplate(options.templateDir, options.stage);
  const agentName = options.config.agents.names[options.stage] ?? options.stage;

  return hydrateTemplate(template, {
    AGENT_NAME: agentName,
    AGENT_ROLE: options.stage,
    TASK_CONTENT: options.taskContent,
    PREVIOUS_OUTPUT: options.previousOutput || "(none)",
    OUTPUT_PATH: options.outputPath,
    PIPELINE_CONTEXT: `Pipeline: ShaktimaanAI | Task: ${options.slug} | Stage: ${options.stage}`,
  });
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const tools = getStageTools(options.stage);
  const systemPrompt = buildSystemPrompt(options);
  const maxTurns = options.config.agents.maxTurns[options.stage] ?? 30;
  const timeoutMinutes = options.config.agents.timeoutsMinutes[options.stage] ?? 30;

  const abortController = options.abortController ?? new AbortController();
  const startTime = Date.now();

  // Enforce per-agent timeout
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
    options.logger.warn(`Agent ${options.stage} timed out after ${timeoutMinutes}m`);
  }, timeoutMinutes * 60 * 1000);

  options.logger.info(`Starting ${options.stage} agent for ${options.slug} (max ${maxTurns} turns, ${timeoutMinutes}m timeout)`);

  try {
    let resultOutput = "";
    let costUsd = 0;
    let turns = 0;

    for await (const message of query({
      prompt: systemPrompt,
      options: {
        allowedTools: tools.allowed,
        disallowedTools: tools.disallowed,
        maxTurns,
        cwd: options.cwd,
        abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          resultOutput = message.result;
          costUsd = message.total_cost_usd;
          turns = message.num_turns;
        } else {
          const error = (message as any).errors?.join("; ") ?? message.subtype;
          options.logger.error(`Agent ${options.stage} failed: ${error}`);
          return {
            success: false,
            output: "",
            costUsd: (message as any).total_cost_usd ?? 0,
            turns: (message as any).num_turns ?? 0,
            durationMs: Date.now() - startTime,
            error,
          };
        }
      }
    }

    options.logger.info(`Agent ${options.stage} completed (${turns} turns, $${costUsd.toFixed(4)})`);
    return { success: true, output: resultOutput, costUsd, turns, durationMs: Date.now() - startTime };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    options.logger.error(`Agent ${options.stage} threw: ${error}`);
    return { success: false, output: "", costUsd: 0, turns: 0, durationMs: Date.now() - startTime, error };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/agent-runner.test.ts --reporter=verbose
```

Expected: All PASS (only pure functions tested; `runAgent` itself is integration-tested)

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runner.ts tests/core/agent-runner.test.ts
git commit -m "$(cat <<'EOF'
feat: add agent runner with per-stage tool permissions and timeout enforcement
EOF
)"
```

---

### Task 5: Agent Registry

**Files:**
- Create: `src/core/registry.ts`
- Create: `tests/core/registry.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/core/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createAgentRegistry } from "../../src/core/registry.js";

describe("createAgentRegistry", () => {
  it("registers an agent and returns an id", () => {
    const reg = createAgentRegistry(3, 1);
    const id = reg.register("task-1", "questions", "Narada", new AbortController());

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(reg.getActiveCount()).toBe(1);
  });

  it("tracks agent details", () => {
    const reg = createAgentRegistry(3, 1);
    reg.register("task-1", "questions", "Narada", new AbortController());

    const agents = reg.getActive();
    expect(agents).toHaveLength(1);
    expect(agents[0].slug).toBe("task-1");
    expect(agents[0].stage).toBe("questions");
    expect(agents[0].agentName).toBe("Narada");
    expect(agents[0].startedAt).toBeTruthy();
  });

  it("unregisters an agent by id", () => {
    const reg = createAgentRegistry(3, 1);
    const id = reg.register("task-1", "questions", "Narada", new AbortController());

    reg.unregister(id);
    expect(reg.getActiveCount()).toBe(0);
  });

  it("enforces maxConcurrentTotal", () => {
    const reg = createAgentRegistry(2, 1);
    reg.register("t1", "questions", "Narada", new AbortController());
    reg.register("t2", "research", "Chitragupta", new AbortController());

    expect(reg.canStartAgent("design")).toBe(false);
  });

  it("allows new agent when under total limit", () => {
    const reg = createAgentRegistry(3, 1);
    reg.register("t1", "questions", "Narada", new AbortController());

    expect(reg.canStartAgent("research")).toBe(true);
  });

  it("enforces maxConcurrentValidate separately", () => {
    const reg = createAgentRegistry(5, 1);
    reg.register("t1", "validate", "Dharma", new AbortController());

    expect(reg.canStartAgent("validate")).toBe(false);
    expect(reg.canStartAgent("questions")).toBe(true);
  });

  it("counts validate agents correctly", () => {
    const reg = createAgentRegistry(5, 2);
    reg.register("t1", "validate", "Dharma", new AbortController());

    expect(reg.getActiveValidateCount()).toBe(1);
    expect(reg.canStartAgent("validate")).toBe(true);

    reg.register("t2", "validate", "Dharma", new AbortController());
    expect(reg.canStartAgent("validate")).toBe(false);
  });

  it("abortAll aborts all controllers and clears registry", () => {
    const reg = createAgentRegistry(3, 1);
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    reg.register("t1", "questions", "Narada", ac1);
    reg.register("t2", "research", "Chitragupta", ac2);

    reg.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(reg.getActiveCount()).toBe(0);
  });

  it("unregistering unknown id is a no-op", () => {
    const reg = createAgentRegistry(3, 1);
    reg.unregister("nonexistent-id");
    expect(reg.getActiveCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/registry.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/registry.ts`:

```typescript
import { randomUUID } from "node:crypto";

export interface AgentEntry {
  id: string;
  slug: string;
  stage: string;
  agentName: string;
  startedAt: string;
  abortController: AbortController;
}

export interface AgentRegistry {
  register(slug: string, stage: string, agentName: string, abortController: AbortController): string;
  unregister(id: string): void;
  getActive(): AgentEntry[];
  getActiveCount(): number;
  getActiveValidateCount(): number;
  canStartAgent(stage: string): boolean;
  abortAll(): void;
}

export function createAgentRegistry(
  maxConcurrentTotal: number,
  maxConcurrentValidate: number,
): AgentRegistry {
  const agents = new Map<string, AgentEntry>();

  return {
    register(slug, stage, agentName, abortController) {
      const id = randomUUID();
      agents.set(id, {
        id,
        slug,
        stage,
        agentName,
        startedAt: new Date().toISOString(),
        abortController,
      });
      return id;
    },

    unregister(id) {
      agents.delete(id);
    },

    getActive() {
      return Array.from(agents.values());
    },

    getActiveCount() {
      return agents.size;
    },

    getActiveValidateCount() {
      let count = 0;
      for (const a of agents.values()) {
        if (a.stage === "validate") count++;
      }
      return count;
    },

    canStartAgent(stage) {
      if (agents.size >= maxConcurrentTotal) return false;
      if (stage === "validate" && this.getActiveValidateCount() >= maxConcurrentValidate) return false;
      return true;
    },

    abortAll() {
      for (const agent of agents.values()) {
        agent.abortController.abort();
      }
      agents.clear();
    },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/registry.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts tests/core/registry.test.ts
git commit -m "$(cat <<'EOF'
feat: add agent registry with concurrency enforcement
EOF
)"
```

---

### Task 6: Pipeline Stage Utilities

**Files:**
- Create: `src/core/pipeline.ts`
- Create: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write tests for pure utility functions**

Create `tests/core/pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import { parseTaskFile } from "../../src/task/parser.js";
import {
  STAGE_DIR_MAP,
  DIR_STAGE_MAP,
  getNextStage,
  isReviewGate,
  createRunState,
  moveTaskDir,
  initTaskDir,
  readRunState,
  writeRunState,
} from "../../src/core/pipeline.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-pipeline-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("STAGE_DIR_MAP", () => {
  it("maps all 9 pipeline stages to directory names", () => {
    expect(Object.keys(STAGE_DIR_MAP)).toHaveLength(9);
    expect(STAGE_DIR_MAP.questions).toBe("01-questions");
    expect(STAGE_DIR_MAP.research).toBe("02-research");
    expect(STAGE_DIR_MAP.design).toBe("03-design");
    expect(STAGE_DIR_MAP.structure).toBe("04-structure");
    expect(STAGE_DIR_MAP.plan).toBe("05-plan");
    expect(STAGE_DIR_MAP.impl).toBe("06-impl");
    expect(STAGE_DIR_MAP.validate).toBe("07-validate");
    expect(STAGE_DIR_MAP.review).toBe("08-review");
    expect(STAGE_DIR_MAP.pr).toBe("09-pr");
  });
});

describe("DIR_STAGE_MAP", () => {
  it("is the inverse of STAGE_DIR_MAP", () => {
    expect(DIR_STAGE_MAP["01-questions"]).toBe("questions");
    expect(DIR_STAGE_MAP["09-pr"]).toBe("pr");
  });
});

describe("getNextStage", () => {
  const stages = ["questions", "research", "design", "plan", "impl", "pr"];

  it("returns next stage in sequence", () => {
    expect(getNextStage("questions", stages)).toBe("research");
    expect(getNextStage("design", stages)).toBe("plan");
  });

  it("returns null for the last stage", () => {
    expect(getNextStage("pr", stages)).toBeNull();
  });

  it("returns null if stage is not in the list", () => {
    expect(getNextStage("validate", stages)).toBeNull();
  });
});

describe("isReviewGate", () => {
  it("returns true when completed stage matches reviewAfter", () => {
    expect(isReviewGate("design", "design")).toBe(true);
  });

  it("returns false when stages don't match", () => {
    expect(isReviewGate("questions", "design")).toBe(false);
  });
});

describe("createRunState", () => {
  it("creates initial run state from task meta and config", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
    const config = resolveConfig(parsed);

    const taskContent = [
      "# Task: Fix auth bug",
      "",
      "## What I want done",
      "Fix the login flow",
      "",
      "## Pipeline Config",
      "stages: questions, research, design, impl, pr",
      "review_after: design",
    ].join("\n");
    const meta = parseTaskFile(taskContent);

    const state = createRunState("fix-auth", meta, config);

    expect(state.slug).toBe("fix-auth");
    expect(state.stages).toEqual(["questions", "research", "design", "impl", "pr"]);
    expect(state.reviewAfter).toBe("design");
    expect(state.status).toBe("running");
    expect(state.completedStages).toEqual([]);
    expect(state.startedAt).toBeTruthy();
  });

  it("uses config defaults when task has no pipeline config", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
    const config = resolveConfig(parsed);

    const taskContent = "# Task: Simple\n\n## What I want done\nDo the thing";
    const meta = parseTaskFile(taskContent);

    const state = createRunState("simple", meta, config);

    expect(state.stages).toEqual(config.agents.defaultStages);
    expect(state.reviewAfter).toBe(config.agents.defaultReviewAfter);
  });
});

describe("readRunState / writeRunState", () => {
  it("round-trips run state through JSON", () => {
    const state = {
      slug: "test",
      taskFile: "test.task",
      stages: ["questions", "research"],
      reviewAfter: "questions",
      currentStage: "questions",
      status: "running" as const,
      startedAt: "2026-04-04T10:00:00Z",
      updatedAt: "2026-04-04T10:00:00Z",
      completedStages: [],
    };

    writeRunState(TEST_DIR, state);
    const loaded = readRunState(TEST_DIR);

    expect(loaded.slug).toBe("test");
    expect(loaded.stages).toEqual(["questions", "research"]);
    expect(loaded.updatedAt).toBeTruthy();
  });
});

describe("initTaskDir", () => {
  it("creates task directory with task.task and artifacts/", () => {
    const runtimeDir = TEST_DIR;
    mkdirSync(join(runtimeDir, "01-questions", "pending"), { recursive: true });

    const taskFile = join(runtimeDir, "test.task");
    writeFileSync(taskFile, "# Task: Test\n");

    const taskDir = initTaskDir(runtimeDir, "test-slug", "01-questions", taskFile);

    expect(existsSync(join(taskDir, "task.task"))).toBe(true);
    expect(readFileSync(join(taskDir, "task.task"), "utf-8")).toContain("# Task: Test");
    expect(existsSync(join(taskDir, "artifacts"))).toBe(true);
  });
});

describe("moveTaskDir", () => {
  it("moves a task directory from one stage subdir to another", () => {
    const src = join(TEST_DIR, "01-questions", "pending", "my-slug");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "task.task"), "content");

    const dest = moveTaskDir(TEST_DIR, "my-slug", "01-questions/pending", "01-questions/done");

    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dest, "task.task"))).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  it("creates destination parent directory if needed", () => {
    const src = join(TEST_DIR, "from", "my-slug");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "data.txt"), "hi");

    const dest = moveTaskDir(TEST_DIR, "my-slug", "from", "to");
    expect(existsSync(join(dest, "data.txt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/pipeline.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write pipeline utilities implementation**

Create `src/core/pipeline.ts`:

```typescript
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { parseTaskFile, type TaskMeta } from "../task/parser.js";
import type { ResolvedConfig } from "../config/loader.js";
import type { AgentRunnerFn, RunState, CompletedStage } from "./types.js";
import type { AgentRegistry } from "./registry.js";
import type { TaskLogger } from "./logger.js";
import { createTaskLogger } from "./logger.js";

// ─── Stage ↔ Directory mapping ───────────────────────────────────────────────

export const STAGE_DIR_MAP: Record<string, string> = {
  questions:  "01-questions",
  research:   "02-research",
  design:     "03-design",
  structure:  "04-structure",
  plan:       "05-plan",
  impl:       "06-impl",
  validate:   "07-validate",
  review:     "08-review",
  pr:         "09-pr",
};

export const DIR_STAGE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_DIR_MAP).map(([k, v]) => [v, k]),
);

// ─── Pure utility functions ──────────────────────────────────────────────────

export function getNextStage(currentStage: string, stages: string[]): string | null {
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx >= stages.length - 1) return null;
  return stages[idx + 1];
}

export function isReviewGate(completedStage: string, reviewAfter: string): boolean {
  return completedStage === reviewAfter;
}

export function createRunState(slug: string, taskMeta: TaskMeta, config: ResolvedConfig): RunState {
  const now = new Date().toISOString();
  return {
    slug,
    taskFile: `${slug}.task`,
    stages: taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages,
    reviewAfter: taskMeta.reviewAfter || config.agents.defaultReviewAfter,
    currentStage: "",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedStages: [],
  };
}

// ─── Filesystem operations ───────────────────────────────────────────────────

export function readRunState(taskDir: string): RunState {
  return JSON.parse(readFileSync(join(taskDir, "run-state.json"), "utf-8"));
}

export function writeRunState(taskDir: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  writeFileSync(join(taskDir, "run-state.json"), JSON.stringify(state, null, 2));
}

export function initTaskDir(
  runtimeDir: string,
  slug: string,
  stageDir: string,
  taskFilePath: string,
): string {
  const taskDir = join(runtimeDir, stageDir, "pending", slug);
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  cpSync(taskFilePath, join(taskDir, "task.task"));
  return taskDir;
}

export function moveTaskDir(
  runtimeDir: string,
  slug: string,
  fromSubdir: string,
  toSubdir: string,
): string {
  const src = join(runtimeDir, fromSubdir, slug);
  const destParent = join(runtimeDir, toSubdir);
  const dest = join(destParent, slug);
  mkdirSync(destParent, { recursive: true });
  renameSync(src, dest);
  return dest;
}

// ─── Pipeline factory (see Task 7) ──────────────────────────────────────────

export interface PipelineOptions {
  runtimeDir: string;
  config: ResolvedConfig;
  registry: AgentRegistry;
  systemLogger: TaskLogger;
  agentRunner: AgentRunnerFn;
  templateDir: string;
}

export interface Pipeline {
  startRun(taskFilePath: string): Promise<void>;
  resumeRun(slug: string, stageSubdir: string): Promise<void>;
  approveAndResume(slug: string, feedback?: string): Promise<void>;
  getActiveRuns(): RunState[];
}

/**
 * Placeholder — full implementation in Task 7.
 * This ensures the module compiles and tests for utilities pass.
 */
export function createPipeline(options: PipelineOptions): Pipeline {
  return {
    async startRun() { throw new Error("Not implemented — see Task 7"); },
    async resumeRun() { throw new Error("Not implemented — see Task 7"); },
    async approveAndResume() { throw new Error("Not implemented — see Task 7"); },
    getActiveRuns() { return []; },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/pipeline.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat: add pipeline stage utilities — dir mapping, transitions, review gates, run state I/O
EOF
)"
```

---

### Task 7: Pipeline Run Orchestration

**Files:**
- Modify: `src/core/pipeline.ts` (replace placeholder `createPipeline`)
- Modify: `tests/core/pipeline.test.ts` (add integration tests)

- [ ] **Step 1: Write integration tests for createPipeline**

Append to `tests/core/pipeline.test.ts`:

```typescript
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { createAgentRegistry } from "../../src/core/registry.js";
import { createPipeline } from "../../src/core/pipeline.js";
import type { AgentRunResult, AgentRunOptions } from "../../src/core/types.js";

// ─── Stub agent runner for testing ──────────────────────────────────────────

function createStubRunner(
  behavior: "success" | "fail" = "success",
): (options: AgentRunOptions) => Promise<AgentRunResult> {
  return async (options) => {
    // Write a stub output file so pipeline can find it
    if (behavior === "success" && options.outputPath) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, `Stub output for ${options.stage}`);
    }
    return {
      success: behavior === "success",
      output: behavior === "success" ? `Output for ${options.stage}` : "",
      costUsd: 0.001,
      turns: 2,
      durationMs: 50,
      error: behavior === "fail" ? "Stub failure" : undefined,
    };
  };
}

function makeTestConfig() {
  const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
  return resolveConfig(parsed);
}

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

describe("createPipeline", () => {
  beforeEach(() => {
    createRuntimeDirs(TEST_DIR);
  });

  it("runs a task through two stages to completion", async () => {
    const config = makeTestConfig();
    // Override to use only 2 stages for fast test
    config.agents.defaultStages = ["questions", "research"];
    config.agents.defaultReviewAfter = "";

    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "prompt-questions.md"), "Q: {{TASK_CONTENT}}");
    writeFileSync(join(templateDir, "prompt-research.md"), "R: {{PREVIOUS_OUTPUT}}");

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("success"),
      templateDir,
    });

    // Create a .task file in inbox
    const taskFile = join(TEST_DIR, "00-inbox", "test-run.task");
    writeFileSync(taskFile, "# Task: Test\n\n## What I want done\nTest the pipeline\n");

    await pipeline.startRun(taskFile);

    // Task should be in 10-complete
    expect(existsSync(join(TEST_DIR, "10-complete", "test-run"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "10-complete", "test-run", "run-state.json"))).toBe(true);

    const finalState = JSON.parse(
      readFileSync(join(TEST_DIR, "10-complete", "test-run", "run-state.json"), "utf-8"),
    );
    expect(finalState.status).toBe("complete");
    expect(finalState.completedStages).toHaveLength(2);

    // Inbox file should be removed
    expect(existsSync(taskFile)).toBe(false);

    // Registry should be empty (all agents done)
    expect(registry.getActiveCount()).toBe(0);
  });

  it("pauses at review gate and moves to hold", async () => {
    const config = makeTestConfig();
    config.agents.defaultStages = ["questions", "design", "impl"];
    config.agents.defaultReviewAfter = "design";

    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "prompt-questions.md"), "Q: {{TASK_CONTENT}}");
    writeFileSync(join(templateDir, "prompt-design.md"), "D: {{PREVIOUS_OUTPUT}}");
    writeFileSync(join(templateDir, "prompt-impl.md"), "I: {{PREVIOUS_OUTPUT}}");

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("success"),
      templateDir,
    });

    const taskFile = join(TEST_DIR, "00-inbox", "gate-test.task");
    writeFileSync(taskFile, "# Task: Gate\n\n## What I want done\nTest gate\n");

    await pipeline.startRun(taskFile);

    // Should be on hold after design (reviewAfter)
    expect(existsSync(join(TEST_DIR, "12-hold", "gate-test"))).toBe(true);
    const holdState = JSON.parse(
      readFileSync(join(TEST_DIR, "12-hold", "gate-test", "run-state.json"), "utf-8"),
    );
    expect(holdState.status).toBe("hold");
    expect(holdState.completedStages).toHaveLength(2); // questions + design
  });

  it("resumes from hold after approval and completes", async () => {
    const config = makeTestConfig();
    config.agents.defaultStages = ["questions", "design", "impl"];
    config.agents.defaultReviewAfter = "design";

    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "prompt-questions.md"), "Q: {{TASK_CONTENT}}");
    writeFileSync(join(templateDir, "prompt-design.md"), "D: {{PREVIOUS_OUTPUT}}");
    writeFileSync(join(templateDir, "prompt-impl.md"), "I: {{PREVIOUS_OUTPUT}}");

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("success"),
      templateDir,
    });

    const taskFile = join(TEST_DIR, "00-inbox", "approve-test.task");
    writeFileSync(taskFile, "# Task: Approve\n\n## What I want done\nTest approve\n");

    await pipeline.startRun(taskFile);

    // Now on hold — approve it
    await pipeline.approveAndResume("approve-test", "Looks good!");

    // Should be complete
    expect(existsSync(join(TEST_DIR, "10-complete", "approve-test"))).toBe(true);
    const finalState = JSON.parse(
      readFileSync(join(TEST_DIR, "10-complete", "approve-test", "run-state.json"), "utf-8"),
    );
    expect(finalState.status).toBe("complete");
    expect(finalState.completedStages).toHaveLength(3);

    // Feedback should be in artifacts
    expect(existsSync(join(TEST_DIR, "10-complete", "approve-test", "artifacts", "review-feedback.md"))).toBe(true);
  });

  it("moves task to failed on agent failure", async () => {
    const config = makeTestConfig();
    config.agents.defaultStages = ["questions"];
    config.agents.defaultReviewAfter = "";

    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "prompt-questions.md"), "Q: {{TASK_CONTENT}}");

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("fail"),
      templateDir,
    });

    const taskFile = join(TEST_DIR, "00-inbox", "fail-test.task");
    writeFileSync(taskFile, "# Task: Fail\n\n## What I want done\nThis will fail\n");

    await pipeline.startRun(taskFile);

    expect(existsSync(join(TEST_DIR, "11-failed", "fail-test"))).toBe(true);
    const failState = JSON.parse(
      readFileSync(join(TEST_DIR, "11-failed", "fail-test", "run-state.json"), "utf-8"),
    );
    expect(failState.status).toBe("failed");
    expect(failState.error).toBe("Stub failure");
  });

  it("throws when approving a task not in hold", async () => {
    const config = makeTestConfig();
    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("success"),
      templateDir,
    });

    await expect(pipeline.approveAndResume("nonexistent")).rejects.toThrow(/not found in hold/);
  });

  it("reports active runs", async () => {
    const config = makeTestConfig();
    config.agents.defaultStages = ["questions", "research"];
    config.agents.defaultReviewAfter = "questions";

    const registry = createAgentRegistry(3, 1);
    const templateDir = join(TEST_DIR, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "prompt-questions.md"), "Q: {{TASK_CONTENT}}");

    const pipeline = createPipeline({
      runtimeDir: TEST_DIR,
      config,
      registry,
      systemLogger: noopLogger(),
      agentRunner: createStubRunner("success"),
      templateDir,
    });

    const taskFile = join(TEST_DIR, "00-inbox", "active-test.task");
    writeFileSync(taskFile, "# Task: Active\n\n## What I want done\nTest active\n");

    await pipeline.startRun(taskFile);

    // Task should be in hold (review gate after questions)
    const runs = pipeline.getActiveRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].slug).toBe("active-test");
    expect(runs[0].status).toBe("hold");
  });
});
```

- [ ] **Step 2: Run tests, verify new tests fail (utilities still pass)**

```bash
npx vitest run tests/core/pipeline.test.ts --reporter=verbose
```

Expected: utility tests PASS, integration tests FAIL (createPipeline is placeholder)

- [ ] **Step 3: Replace createPipeline placeholder with full implementation**

In `src/core/pipeline.ts`, replace the placeholder `createPipeline` function with:

```typescript
export function createPipeline(options: PipelineOptions): Pipeline {
  const { runtimeDir, config, registry, systemLogger, agentRunner, templateDir } = options;
  const activeRuns = new Map<string, RunState>();

  async function processStage(slug: string, taskDir: string): Promise<void> {
    const state = readRunState(taskDir);
    const stage = state.currentStage;
    const logger = createTaskLogger(join(runtimeDir, "logs"), slug);

    // Concurrency check — if at capacity, queue for later
    if (!registry.canStartAgent(stage)) {
      logger.info(`Queued: concurrency limit for ${stage}`);
      return;
    }

    const abortController = new AbortController();
    const agentId = registry.register(
      slug,
      stage,
      config.agents.names[stage] ?? stage,
      abortController,
    );

    try {
      // Collect previous stage outputs
      const artifactsDir = join(taskDir, "artifacts");
      let previousOutput = "";
      for (const completed of state.completedStages) {
        const artifactPath = join(artifactsDir, `${completed.stage}.md`);
        if (existsSync(artifactPath)) {
          previousOutput += `\n\n═══ ${completed.stage.toUpperCase()} OUTPUT ═══\n${readFileSync(artifactPath, "utf-8")}`;
        }
      }

      const taskContent = readFileSync(join(taskDir, "task.task"), "utf-8");
      const outputPath = join(artifactsDir, `${stage}.md`);

      const result = await agentRunner({
        stage,
        slug,
        taskContent,
        previousOutput,
        outputPath,
        cwd: taskDir,
        config,
        templateDir,
        abortController,
        logger,
      });

      registry.unregister(agentId);

      // ─── Handle failure ─────────────────────────────────────────────
      if (!result.success) {
        state.status = "failed";
        state.error = result.error;
        writeRunState(taskDir, state);
        moveTaskDir(runtimeDir, slug, `${STAGE_DIR_MAP[stage]}/pending`, "11-failed");
        activeRuns.delete(slug);
        logger.error(`Stage ${stage} failed: ${result.error}`);
        return;
      }

      // ─── Handle success ─────────────────────────────────────────────

      // If agent didn't write output file, create it from result text
      if (!existsSync(outputPath) && result.output) {
        mkdirSync(join(taskDir, "artifacts"), { recursive: true });
        writeFileSync(outputPath, result.output);
      }

      state.completedStages.push({
        stage,
        completedAt: new Date().toISOString(),
        outputFile: `artifacts/${stage}.md`,
        costUsd: result.costUsd,
        turns: result.turns,
      });

      // Move pending → done for this stage
      const doneSubdir = `${STAGE_DIR_MAP[stage]}/done`;
      let currentDir = moveTaskDir(runtimeDir, slug, `${STAGE_DIR_MAP[stage]}/pending`, doneSubdir);
      writeRunState(currentDir, state);

      // ─── Review gate check ──────────────────────────────────────────
      if (isReviewGate(stage, state.reviewAfter)) {
        state.status = "hold";
        currentDir = moveTaskDir(runtimeDir, slug, doneSubdir, "12-hold");
        writeRunState(currentDir, state);
        activeRuns.set(slug, state);
        logger.info(`Review gate after ${stage} — task on hold`);
        return;
      }

      // ─── Advance to next stage ─────────────────────────────────────
      const nextStage = getNextStage(stage, state.stages);
      if (!nextStage) {
        state.status = "complete";
        currentDir = moveTaskDir(runtimeDir, slug, doneSubdir, "10-complete");
        writeRunState(currentDir, state);
        activeRuns.delete(slug);
        logger.info(`Pipeline complete for ${slug}`);
        return;
      }

      state.currentStage = nextStage;
      const nextPendingSubdir = `${STAGE_DIR_MAP[nextStage]}/pending`;
      currentDir = moveTaskDir(runtimeDir, slug, doneSubdir, nextPendingSubdir);
      writeRunState(currentDir, state);
      activeRuns.set(slug, state);

      await processStage(slug, currentDir);

    } catch (err) {
      registry.unregister(agentId);
      const error = err instanceof Error ? err.message : String(err);
      systemLogger.error(`Pipeline error for ${slug} at ${stage}: ${error}`);

      try {
        const errState = readRunState(taskDir);
        errState.status = "failed";
        errState.error = error;
        writeRunState(taskDir, errState);
        moveTaskDir(runtimeDir, slug, `${STAGE_DIR_MAP[stage]}/pending`, "11-failed");
      } catch {
        // Best-effort — if we can't update state, just log
        systemLogger.error(`Could not update failed state for ${slug}`);
      }
      activeRuns.delete(slug);
    }
  }

  return {
    async startRun(taskFilePath: string) {
      const slug = basename(taskFilePath, ".task");
      const taskContent = readFileSync(taskFilePath, "utf-8");
      const taskMeta = parseTaskFile(taskContent);

      const state = createRunState(slug, taskMeta, config);
      const firstStage = state.stages[0];
      state.currentStage = firstStage;

      // Move-then-act: set up task dir in first stage, then remove from inbox
      const taskDir = initTaskDir(runtimeDir, slug, STAGE_DIR_MAP[firstStage], taskFilePath);
      writeRunState(taskDir, state);
      unlinkSync(taskFilePath);

      activeRuns.set(slug, state);
      systemLogger.info(`Starting pipeline for ${slug} at ${firstStage}`);

      await processStage(slug, taskDir);
    },

    async resumeRun(slug: string, stageSubdir: string) {
      const taskDir = join(runtimeDir, stageSubdir, slug);
      const state = readRunState(taskDir);
      activeRuns.set(slug, state);
      systemLogger.info(`Resuming ${slug} at ${state.currentStage}`);
      await processStage(slug, taskDir);
    },

    async approveAndResume(slug: string, feedback?: string) {
      const holdDir = join(runtimeDir, "12-hold", slug);
      if (!existsSync(holdDir)) {
        throw new Error(`Task ${slug} not found in hold`);
      }

      const state = readRunState(holdDir);
      const nextStage = getNextStage(state.currentStage, state.stages);

      if (!nextStage) {
        state.status = "complete";
        const dir = moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
        writeRunState(dir, state);
        activeRuns.delete(slug);
        return;
      }

      state.status = "running";
      state.currentStage = nextStage;

      if (feedback) {
        writeFileSync(join(holdDir, "artifacts", "review-feedback.md"), feedback);
      }

      const nextSubdir = `${STAGE_DIR_MAP[nextStage]}/pending`;
      const nextDir = moveTaskDir(runtimeDir, slug, "12-hold", nextSubdir);
      writeRunState(nextDir, state);
      activeRuns.set(slug, state);

      systemLogger.info(`Approved ${slug}, resuming at ${nextStage}`);
      await processStage(slug, nextDir);
    },

    getActiveRuns() {
      return Array.from(activeRuns.values());
    },
  };
}
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
npx vitest run tests/core/pipeline.test.ts --reporter=verbose
```

Expected: All PASS (utilities + integration)

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat: add pipeline run orchestration with stage transitions, review gates, and approval
EOF
)"
```

---

### Task 8: Brahma (Task Creator)

**Files:**
- Create: `src/core/brahma.ts`
- Create: `tests/core/brahma.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/core/brahma.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import {
  generateSlug,
  extractTitle,
  buildTaskFileContent,
  createTask,
} from "../../src/core/brahma.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-brahma-" + Date.now());

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "00-inbox"), { recursive: true });
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("extractTitle", () => {
  it("returns the first line of content", () => {
    expect(extractTitle("Fix login bug\nMore details here")).toBe("Fix login bug");
  });

  it("trims whitespace", () => {
    expect(extractTitle("  spaced title  \nsecond line")).toBe("spaced title");
  });

  it("returns fallback for empty content", () => {
    expect(extractTitle("")).toBe("untitled-task");
    expect(extractTitle("   \n  ")).toBe("untitled-task");
  });

  it("truncates to 80 characters", () => {
    const long = "A".repeat(100);
    expect(extractTitle(long).length).toBe(80);
  });
});

describe("generateSlug", () => {
  it("kebab-cases the title", () => {
    const slug = generateSlug("Fix Login Bug");
    expect(slug).toMatch(/^fix-login-bug-\d{14}$/);
  });

  it("strips special characters", () => {
    const slug = generateSlug("Hello, World! (test) #1");
    expect(slug).toMatch(/^hello-world-test-1-\d{14}$/);
  });

  it("truncates long titles to 50 chars before timestamp", () => {
    const long = "word ".repeat(20).trim();
    const slug = generateSlug(long);
    const namepart = slug.replace(/-\d{14}$/, "");
    expect(namepart.length).toBeLessThanOrEqual(50);
  });

  it("appends a YYYYMMDDHHMMSS timestamp", () => {
    const slug = generateSlug("test");
    const ts = slug.split("-").pop()!;
    expect(ts).toMatch(/^\d{14}$/);
  });
});

describe("buildTaskFileContent", () => {
  it("builds valid .task file content with all fields", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
    const config = resolveConfig(parsed);

    const content = buildTaskFileContent(
      {
        source: "cli",
        content: "Fix the auth bug in login flow",
        repo: "my-app",
        adoItem: "AB#1234",
        slackThread: "C123/p456",
        stages: ["questions", "research", "impl"],
        reviewAfter: "research",
      },
      config,
    );

    expect(content).toContain("# Task: Fix the auth bug in login flow");
    expect(content).toContain("## What I want done");
    expect(content).toContain("## Repo\nmy-app");
    expect(content).toContain("## ADO Item\nAB#1234");
    expect(content).toContain("## Slack Thread\nC123/p456");
    expect(content).toContain("stages: questions, research, impl");
    expect(content).toContain("review_after: research");
  });

  it("uses config defaults when optional fields are omitted", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
    const config = resolveConfig(parsed);

    const content = buildTaskFileContent(
      { source: "dashboard", content: "Do the thing" },
      config,
    );

    expect(content).toContain("# Task: Do the thing");
    expect(content).not.toContain("## Repo");
    expect(content).not.toContain("## ADO Item");
    expect(content).toContain("stages: " + config.agents.defaultStages.join(", "));
    expect(content).toContain("review_after: " + config.agents.defaultReviewAfter);
  });
});

describe("createTask", () => {
  it("writes a .task file to inbox and returns the slug", () => {
    const parsed = configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } });
    const config = resolveConfig(parsed);

    const slug = createTask(
      { source: "cli", content: "Add user avatar feature" },
      TEST_DIR,
      config,
    );

    expect(slug).toMatch(/^add-user-avatar-feature-\d{14}$/);

    const taskFile = join(TEST_DIR, "00-inbox", `${slug}.task`);
    expect(existsSync(taskFile)).toBe(true);

    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("# Task: Add user avatar feature");
    expect(content).toContain("## What I want done");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/brahma.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/brahma.ts`:

```typescript
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/loader.js";

export interface CreateTaskInput {
  source: "slack" | "dashboard" | "cli";
  content: string;
  repo?: string;
  adoItem?: string;
  slackThread?: string;
  stages?: string[];
  reviewAfter?: string;
}

export function extractTitle(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (!firstLine) return "untitled-task";
  return firstLine.slice(0, 80);
}

export function generateSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);

  return `${slug}-${ts}`;
}

export function buildTaskFileContent(input: CreateTaskInput, config: ResolvedConfig): string {
  const title = extractTitle(input.content);
  const stages = input.stages ?? config.agents.defaultStages;
  const reviewAfter = input.reviewAfter ?? config.agents.defaultReviewAfter;

  let md = `# Task: ${title}\n\n`;
  md += `## What I want done\n${input.content}\n\n`;
  md += `## Context\nSource: ${input.source}\n\n`;

  if (input.repo) md += `## Repo\n${input.repo}\n\n`;
  if (input.adoItem) md += `## ADO Item\n${input.adoItem}\n\n`;
  if (input.slackThread) md += `## Slack Thread\n${input.slackThread}\n\n`;

  md += `## Pipeline Config\nstages: ${stages.join(", ")}\nreview_after: ${reviewAfter}\n`;

  return md;
}

export function createTask(
  input: CreateTaskInput,
  runtimeDir: string,
  config: ResolvedConfig,
): string {
  const title = extractTitle(input.content);
  const slug = generateSlug(title);
  const content = buildTaskFileContent(input, config);

  writeFileSync(join(runtimeDir, "00-inbox", `${slug}.task`), content);
  return slug;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/brahma.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/brahma.ts tests/core/brahma.test.ts
git commit -m "$(cat <<'EOF'
feat: add Brahma task creator — slug generation, .task file builder, inbox writer
EOF
)"
```

---

### Task 9: Sutradhaar (Intent Classifier)

**Files:**
- Create: `src/core/sutradhaar.ts`
- Create: `tests/core/sutradhaar.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/core/sutradhaar.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyByKeywords, classifyIntent } from "../../src/core/sutradhaar.js";
import type { AgentRunResult, AgentRunOptions } from "../../src/core/types.js";

describe("classifyByKeywords", () => {
  it("detects create_task intent from 'create task'", () => {
    const r = classifyByKeywords("create task fix the login bug");
    expect(r).not.toBeNull();
    expect(r!.intent).toBe("create_task");
    expect(r!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects create_task from 'new task'", () => {
    expect(classifyByKeywords("new task: add caching")?.intent).toBe("create_task");
  });

  it("detects create_task from 'add ticket'", () => {
    expect(classifyByKeywords("add ticket for refactoring")?.intent).toBe("create_task");
  });

  it("detects approve intent from 'approve'", () => {
    expect(classifyByKeywords("approve fix-auth-20260404")?.intent).toBe("approve");
  });

  it("detects approve from 'lgtm'", () => {
    expect(classifyByKeywords("lgtm")?.intent).toBe("approve");
  });

  it("detects approve from 'ship it'", () => {
    expect(classifyByKeywords("ship it")?.intent).toBe("approve");
  });

  it("detects status intent", () => {
    expect(classifyByKeywords("status")?.intent).toBe("status");
    expect(classifyByKeywords("what's running")?.intent).toBe("status");
    expect(classifyByKeywords("show tasks")?.intent).toBe("status");
  });

  it("detects cancel intent", () => {
    expect(classifyByKeywords("cancel fix-auth-20260404")?.intent).toBe("cancel");
    expect(classifyByKeywords("abort task-123")?.intent).toBe("cancel");
    expect(classifyByKeywords("stop running-task")?.intent).toBe("cancel");
  });

  it("extracts slug from input when present", () => {
    const r = classifyByKeywords("approve fix-auth-bug-20260404-103000");
    expect(r?.extractedSlug).toBe("fix-auth-bug-20260404-103000");
  });

  it("returns null for unrecognized input", () => {
    expect(classifyByKeywords("what is the weather like")).toBeNull();
    expect(classifyByKeywords("tell me about the project")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyByKeywords("CREATE TASK do something")?.intent).toBe("create_task");
    expect(classifyByKeywords("APPROVE task-1")?.intent).toBe("approve");
  });
});

describe("classifyIntent", () => {
  const stubRunner = async (_opts: AgentRunOptions): Promise<AgentRunResult> => ({
    success: true,
    output: JSON.stringify({ intent: "create_task", confidence: 0.85, extractedSlug: null, extractedContent: "test" }),
    costUsd: 0.001,
    turns: 1,
    durationMs: 50,
  });

  const noopLogger = { info() {}, warn() {}, error() {} };

  it("uses keyword match when confidence is high", async () => {
    const result = await classifyIntent(
      "create task fix login",
      stubRunner,
      {} as any,
      "",
      noopLogger,
    );
    expect(result.intent).toBe("create_task");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("falls back to LLM for unrecognized input", async () => {
    const result = await classifyIntent(
      "I think we should maybe look at the auth code",
      stubRunner,
      {} as any,
      "",
      noopLogger,
    );
    // stubRunner returns create_task
    expect(result.intent).toBe("create_task");
    expect(result.confidence).toBe(0.85);
  });

  it("returns unknown when LLM fails", async () => {
    const failRunner = async (): Promise<AgentRunResult> => ({
      success: false, output: "", costUsd: 0, turns: 0, durationMs: 0, error: "boom",
    });

    const result = await classifyIntent(
      "ambiguous message",
      failRunner,
      {} as any,
      "",
      noopLogger,
    );
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/sutradhaar.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/sutradhaar.ts`:

```typescript
import type { AgentRunnerFn, AgentRunOptions, AgentRunResult } from "./types.js";
import type { ResolvedConfig } from "../config/loader.js";
import type { TaskLogger } from "./logger.js";

export interface ClassifyResult {
  intent: "create_task" | "approve" | "status" | "cancel" | "unknown";
  confidence: number;
  extractedSlug: string | null;
  extractedContent: string | null;
}

const KEYWORD_PATTERNS: Array<{
  pattern: RegExp;
  intent: ClassifyResult["intent"];
  confidence: number;
}> = [
  { pattern: /^(create|add|new|make)\s+(task|ticket|item|story)/i, intent: "create_task", confidence: 0.95 },
  { pattern: /^(approve|lgtm|ship it|go ahead)/i, intent: "approve", confidence: 0.95 },
  { pattern: /^(status|what'?s\s+running|progress|show\s+tasks)/i, intent: "status", confidence: 0.95 },
  { pattern: /^(cancel|stop|kill|abort)\s+/i, intent: "cancel", confidence: 0.95 },
];

const SLUG_PATTERN = /([a-z0-9]+-){2,}\d{14}/;

export function classifyByKeywords(input: string): ClassifyResult | null {
  const trimmed = input.trim();

  for (const { pattern, intent, confidence } of KEYWORD_PATTERNS) {
    if (pattern.test(trimmed)) {
      const slugMatch = trimmed.match(SLUG_PATTERN);
      return {
        intent,
        confidence,
        extractedSlug: slugMatch ? slugMatch[0] : null,
        extractedContent: trimmed,
      };
    }
  }

  return null;
}

export async function classifyByLLM(
  input: string,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  templateDir: string,
  logger: TaskLogger,
): Promise<ClassifyResult> {
  const result = await runAgentFn({
    stage: "classify",
    slug: "intent-classify",
    taskContent: input,
    previousOutput: "",
    outputPath: "",
    cwd: process.cwd(),
    config,
    templateDir,
    logger,
  });

  if (result.success && result.output) {
    try {
      // Agent may return JSON in code fences — strip them
      const cleaned = result.output.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        intent: parsed.intent ?? "unknown",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        extractedSlug: parsed.extractedSlug ?? null,
        extractedContent: parsed.extractedContent ?? input,
      };
    } catch {
      logger.warn("Failed to parse classify output as JSON");
    }
  }

  return { intent: "unknown", confidence: 0, extractedSlug: null, extractedContent: input };
}

export async function classifyIntent(
  input: string,
  runAgentFn: AgentRunnerFn,
  config: ResolvedConfig,
  templateDir: string,
  logger: TaskLogger,
  confidenceThreshold: number = 0.7,
): Promise<ClassifyResult> {
  const keywordResult = classifyByKeywords(input);
  if (keywordResult && keywordResult.confidence >= confidenceThreshold) {
    return keywordResult;
  }

  return classifyByLLM(input, runAgentFn, config, templateDir, logger);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/sutradhaar.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/sutradhaar.ts tests/core/sutradhaar.test.ts
git commit -m "$(cat <<'EOF'
feat: add Sutradhaar intent classifier with keyword matching and LLM fallback
EOF
)"
```

---

### Task 10: Indra (Approval Handler)

**Files:**
- Create: `src/core/indra.ts`
- Create: `tests/core/indra.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/core/indra.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findHeldTask, listHeldTasks } from "../../src/core/indra.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-indra-" + Date.now());

beforeEach(() => mkdirSync(join(TEST_DIR, "12-hold"), { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("findHeldTask", () => {
  it("returns the path when task exists in hold", () => {
    const holdPath = join(TEST_DIR, "12-hold", "my-task");
    mkdirSync(holdPath, { recursive: true });

    const result = findHeldTask(TEST_DIR, "my-task");
    expect(result).toBe(holdPath);
  });

  it("returns null when task is not in hold", () => {
    expect(findHeldTask(TEST_DIR, "nonexistent")).toBeNull();
  });
});

describe("listHeldTasks", () => {
  it("lists all task slugs in the hold directory", () => {
    mkdirSync(join(TEST_DIR, "12-hold", "task-a"), { recursive: true });
    mkdirSync(join(TEST_DIR, "12-hold", "task-b"), { recursive: true });

    const slugs = listHeldTasks(TEST_DIR);
    expect(slugs).toContain("task-a");
    expect(slugs).toContain("task-b");
    expect(slugs).toHaveLength(2);
  });

  it("returns empty array when hold directory is empty", () => {
    expect(listHeldTasks(TEST_DIR)).toEqual([]);
  });

  it("returns empty array when hold directory does not exist", () => {
    rmSync(join(TEST_DIR, "12-hold"), { recursive: true, force: true });
    expect(listHeldTasks(TEST_DIR)).toEqual([]);
  });

  it("ignores files (only lists directories)", () => {
    mkdirSync(join(TEST_DIR, "12-hold", "real-task"), { recursive: true });
    writeFileSync(join(TEST_DIR, "12-hold", "not-a-task.txt"), "file");

    expect(listHeldTasks(TEST_DIR)).toEqual(["real-task"]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/core/indra.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/indra.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pipeline } from "./pipeline.js";
import type { TaskLogger } from "./logger.js";

export interface ApproveInput {
  source: "slack" | "dashboard" | "cli";
  taskSlug: string;
  feedback?: string;
}

export function findHeldTask(runtimeDir: string, slug: string): string | null {
  const holdDir = join(runtimeDir, "12-hold", slug);
  return existsSync(holdDir) ? holdDir : null;
}

export function listHeldTasks(runtimeDir: string): string[] {
  const holdDir = join(runtimeDir, "12-hold");
  if (!existsSync(holdDir)) return [];
  return readdirSync(holdDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export async function approveTask(
  input: ApproveInput,
  runtimeDir: string,
  pipeline: Pipeline,
  logger: TaskLogger,
): Promise<void> {
  const held = findHeldTask(runtimeDir, input.taskSlug);
  if (!held) {
    throw new Error(`Task ${input.taskSlug} not found in hold`);
  }

  logger.info(`Task ${input.taskSlug} approved via ${input.source}`);
  await pipeline.approveAndResume(input.taskSlug, input.feedback);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/core/indra.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/indra.ts tests/core/indra.test.ts
git commit -m "$(cat <<'EOF'
feat: add Indra approval handler — find/list held tasks and approve to resume pipeline
EOF
)"
```

---

### Task 11: Heimdall (File Watcher) & Crash Recovery

**Files:**
- Create: `src/core/heimdall.ts`
- Create: `tests/core/heimdall.test.ts`
- Create: `src/core/recovery.ts`
- Create: `tests/core/recovery.test.ts`

- [ ] **Step 1: Write recovery tests**

Create `tests/core/recovery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeDirs } from "../../src/runtime/dirs.js";
import { scanForRecovery } from "../../src/core/recovery.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-recovery-" + Date.now());

beforeEach(() => createRuntimeDirs(TEST_DIR));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("scanForRecovery", () => {
  it("finds tasks in pending directories", () => {
    const pendingDir = join(TEST_DIR, "01-questions", "pending", "task-a");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, "run-state.json"), "{}");

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe("task-a");
    expect(items[0].stage).toBe("questions");
  });

  it("finds tasks across multiple stage pending dirs", () => {
    mkdirSync(join(TEST_DIR, "01-questions", "pending", "task-a"), { recursive: true });
    mkdirSync(join(TEST_DIR, "03-design", "pending", "task-b"), { recursive: true });
    mkdirSync(join(TEST_DIR, "06-impl", "pending", "task-c"), { recursive: true });

    const items = scanForRecovery(TEST_DIR);
    expect(items).toHaveLength(3);

    const stages = items.map((i) => i.stage);
    expect(stages).toContain("questions");
    expect(stages).toContain("design");
    expect(stages).toContain("impl");
  });

  it("ignores done directories", () => {
    mkdirSync(join(TEST_DIR, "01-questions", "done", "finished-task"), { recursive: true });
    expect(scanForRecovery(TEST_DIR)).toHaveLength(0);
  });

  it("returns empty array when no pending tasks", () => {
    expect(scanForRecovery(TEST_DIR)).toHaveLength(0);
  });

  it("ignores files in pending (only directories are tasks)", () => {
    const pending = join(TEST_DIR, "01-questions", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "stray-file.txt"), "not a task");

    expect(scanForRecovery(TEST_DIR)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run recovery tests, verify they fail**

```bash
npx vitest run tests/core/recovery.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 3: Write recovery implementation**

Create `src/core/recovery.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STAGE_DIR_MAP } from "./pipeline.js";
import type { Pipeline } from "./pipeline.js";
import type { TaskLogger } from "./logger.js";

export interface RecoveryItem {
  slug: string;
  stage: string;
  dir: string;
}

export interface RecoveryResult {
  resumed: string[];
  skipped: string[];
  errors: Array<{ slug: string; error: string }>;
}

export function scanForRecovery(runtimeDir: string): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const [stage, dirName] of Object.entries(STAGE_DIR_MAP)) {
    const pendingDir = join(runtimeDir, dirName, "pending");
    if (!existsSync(pendingDir)) continue;

    const entries = readdirSync(pendingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        items.push({
          slug: entry.name,
          stage,
          dir: join(pendingDir, entry.name),
        });
      }
    }
  }

  return items;
}

export async function runRecovery(
  runtimeDir: string,
  pipeline: Pipeline,
  logger: TaskLogger,
): Promise<RecoveryResult> {
  const items = scanForRecovery(runtimeDir);
  const result: RecoveryResult = { resumed: [], skipped: [], errors: [] };

  if (items.length === 0) {
    logger.info("No tasks to recover");
    return result;
  }

  logger.info(`Found ${items.length} task(s) to recover`);

  for (const item of items) {
    try {
      logger.info(`Recovering ${item.slug} at stage ${item.stage}`);
      const stageSubdir = `${STAGE_DIR_MAP[item.stage]}/pending`;
      await pipeline.resumeRun(item.slug, stageSubdir);
      result.resumed.push(item.slug);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`Recovery failed for ${item.slug}: ${error}`);
      result.errors.push({ slug: item.slug, error });
    }
  }

  return result;
}
```

- [ ] **Step 4: Run recovery tests, verify they pass**

```bash
npx vitest run tests/core/recovery.test.ts --reporter=verbose
```

Expected: All PASS

- [ ] **Step 5: Write Heimdall tests**

Create `tests/core/heimdall.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHeimdall } from "../../src/core/heimdall.js";
import type { Pipeline } from "../../src/core/pipeline.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-heimdall-" + Date.now());

beforeEach(() => mkdirSync(join(TEST_DIR, "00-inbox"), { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

describe("createHeimdall", () => {
  it("starts and stops without error", async () => {
    const mockPipeline: Pipeline = {
      async startRun() {},
      async resumeRun() {},
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const heimdall = createHeimdall({
      runtimeDir: TEST_DIR,
      pipeline: mockPipeline,
      logger: noopLogger(),
    });

    expect(heimdall.isRunning()).toBe(false);

    heimdall.start();
    expect(heimdall.isRunning()).toBe(true);

    await heimdall.stop();
    expect(heimdall.isRunning()).toBe(false);
  });

  it("does not start twice", () => {
    const mockPipeline: Pipeline = {
      async startRun() {},
      async resumeRun() {},
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const heimdall = createHeimdall({
      runtimeDir: TEST_DIR,
      pipeline: mockPipeline,
      logger: noopLogger(),
    });

    heimdall.start();
    heimdall.start(); // second call should be no-op
    expect(heimdall.isRunning()).toBe(true);
  });

  it("calls pipeline.startRun when a .task file appears in inbox", async () => {
    const startedFiles: string[] = [];
    const mockPipeline: Pipeline = {
      async startRun(path) { startedFiles.push(path); },
      async resumeRun() {},
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const heimdall = createHeimdall({
      runtimeDir: TEST_DIR,
      pipeline: mockPipeline,
      logger: noopLogger(),
    });

    heimdall.start();

    // Wait for watcher to be ready, then drop a task file
    await new Promise((r) => setTimeout(r, 1000));
    writeFileSync(join(TEST_DIR, "00-inbox", "test-task.task"), "# Task: Test\n");

    // Wait for chokidar to detect the file (awaitWriteFinish: 500ms + buffer)
    await new Promise((r) => setTimeout(r, 2000));

    await heimdall.stop();

    expect(startedFiles.length).toBe(1);
    expect(startedFiles[0]).toContain("test-task.task");
  });

  it("ignores non-.task files in inbox", async () => {
    const startedFiles: string[] = [];
    const mockPipeline: Pipeline = {
      async startRun(path) { startedFiles.push(path); },
      async resumeRun() {},
      async approveAndResume() {},
      getActiveRuns() { return []; },
    };

    const heimdall = createHeimdall({
      runtimeDir: TEST_DIR,
      pipeline: mockPipeline,
      logger: noopLogger(),
    });

    heimdall.start();
    await new Promise((r) => setTimeout(r, 1000));

    writeFileSync(join(TEST_DIR, "00-inbox", "readme.md"), "# Not a task\n");
    await new Promise((r) => setTimeout(r, 2000));

    await heimdall.stop();
    expect(startedFiles).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run Heimdall tests, verify they fail**

```bash
npx vitest run tests/core/heimdall.test.ts --reporter=verbose
```

Expected: FAIL

- [ ] **Step 7: Write Heimdall implementation**

Create `src/core/heimdall.ts`:

```typescript
import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import type { Pipeline } from "./pipeline.js";
import type { TaskLogger } from "./logger.js";

export interface Heimdall {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface HeimdallOptions {
  runtimeDir: string;
  pipeline: Pipeline;
  logger: TaskLogger;
}

export function createHeimdall(options: HeimdallOptions): Heimdall {
  const { runtimeDir, pipeline, logger } = options;
  const inboxDir = join(runtimeDir, "00-inbox");
  let watcher: FSWatcher | null = null;
  let running = false;

  return {
    start() {
      if (running) return;

      watcher = chokidar.watch(inboxDir, {
        ignored: (path: string, stats) => !!stats?.isFile() && !path.endsWith(".task"),
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      watcher.on("add", async (filePath: string) => {
        if (!filePath.endsWith(".task")) return;
        logger.info(`New task detected: ${filePath}`);
        try {
          await pipeline.startRun(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Failed to start run for ${filePath}: ${msg}`);
        }
      });

      watcher.on("error", (error: Error) => {
        logger.error(`Watcher error: ${error.message}`);
      });

      watcher.on("ready", () => {
        logger.info("Heimdall watching inbox for new tasks");
      });

      running = true;
    },

    async stop() {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      running = false;
      logger.info("Heimdall stopped");
    },

    isRunning() {
      return running;
    },
  };
}
```

- [ ] **Step 8: Run Heimdall tests, verify they pass**

```bash
npx vitest run tests/core/heimdall.test.ts --reporter=verbose
```

Expected: All PASS (the file-detection test may need the timeouts — chokidar + awaitWriteFinish)

- [ ] **Step 9: Commit**

```bash
git add src/core/heimdall.ts tests/core/heimdall.test.ts src/core/recovery.ts tests/core/recovery.test.ts
git commit -m "$(cat <<'EOF'
feat: add Heimdall file watcher and crash recovery scan
EOF
)"
```

---

### Task 12: Start & Stop Commands

**Files:**
- Modify: `src/commands/start.ts`
- Modify: `src/commands/stop.ts`
- Create: `tests/commands/start.test.ts`
- Create: `tests/commands/stop.test.ts`

- [ ] **Step 1: Write start command test**

Create `tests/commands/start.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerStartCommand } from "../../src/commands/start.js";

describe("registerStartCommand", () => {
  it("registers 'start' command on the program", () => {
    const program = new Command();
    registerStartCommand(program);

    const cmd = program.commands.find((c) => c.name() === "start");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("Start");
  });
});
```

- [ ] **Step 2: Write stop command test**

Create `tests/commands/stop.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerStopCommand } from "../../src/commands/stop.js";

describe("registerStopCommand", () => {
  it("registers 'stop' command on the program", () => {
    const program = new Command();
    registerStopCommand(program);

    const cmd = program.commands.find((c) => c.name() === "stop");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("Stop");
  });
});
```

- [ ] **Step 3: Run tests, verify they pass (existing stubs register correctly)**

```bash
npx vitest run tests/commands/start.test.ts tests/commands/stop.test.ts --reporter=verbose
```

Expected: PASS (stubs already register the command names)

- [ ] **Step 4: Implement start command**

Replace `src/commands/start.ts` entirely:

```typescript
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig, loadEnvFile } from "../config/loader.js";
import { verifyRuntimeDirs } from "../runtime/dirs.js";
import { createSystemLogger } from "../core/logger.js";
import { createAgentRegistry } from "../core/registry.js";
import { createPipeline } from "../core/pipeline.js";
import { runAgent } from "../core/agent-runner.js";
import { createHeimdall, type Heimdall } from "../core/heimdall.js";
import { runRecovery } from "../core/recovery.js";

let activeHeimdall: Heimdall | null = null;

export function getActiveHeimdall(): Heimdall | null {
  return activeHeimdall;
}

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the ShaktimaanAI pipeline watcher")
    .action(async () => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      loadEnvFile(join(dirname(configPath), ".env"));

      const { valid, missing } = verifyRuntimeDirs(config.pipeline.runtimeDir);
      if (!valid) {
        console.error("Missing runtime directories:", missing.join(", "));
        console.error("Run 'shkmn init' first.");
        process.exit(1);
      }

      const logDir = join(config.pipeline.runtimeDir, "logs");
      const systemLogger = createSystemLogger(logDir);

      const registry = createAgentRegistry(
        config.agents.maxConcurrentTotal,
        config.agents.maxConcurrentValidate,
      );

      // Resolve template directory relative to this file's location in dist/
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const templateDir = join(thisDir, "..", "templates");

      const pipeline = createPipeline({
        runtimeDir: config.pipeline.runtimeDir,
        config,
        registry,
        systemLogger,
        agentRunner: runAgent,
        templateDir,
      });

      // Crash recovery
      systemLogger.info("Running crash recovery scan...");
      const recovery = await runRecovery(config.pipeline.runtimeDir, pipeline, systemLogger);
      if (recovery.resumed.length > 0) {
        systemLogger.info(`Recovered ${recovery.resumed.length} task(s)`);
      }
      if (recovery.errors.length > 0) {
        systemLogger.error(`Recovery errors: ${recovery.errors.length}`);
      }

      // Start Heimdall
      const heimdall = createHeimdall({
        runtimeDir: config.pipeline.runtimeDir,
        pipeline,
        logger: systemLogger,
      });
      heimdall.start();
      activeHeimdall = heimdall;

      // Write PID file for stop command
      const pidFile = join(config.pipeline.runtimeDir, "heimdall.pid");
      writeFileSync(pidFile, process.pid.toString());

      console.log("ShaktimaanAI pipeline started. Watching for tasks...");
      console.log(`Runtime: ${config.pipeline.runtimeDir}`);
      console.log("Press Ctrl+C to stop.");

      const shutdown = async () => {
        console.log("\nStopping ShaktimaanAI...");
        registry.abortAll();
        await heimdall.stop();
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(pidFile);
        } catch { /* ignore */ }
        console.log("Stopped.");
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
```

- [ ] **Step 5: Implement stop command**

Replace `src/commands/stop.ts` entirely:

```typescript
import { Command } from "commander";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the ShaktimaanAI pipeline watcher")
    .action(() => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const pidFile = join(config.pipeline.runtimeDir, "heimdall.pid");
      if (!existsSync(pidFile)) {
        console.error("ShaktimaanAI is not running (no PID file found).");
        process.exit(1);
      }

      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGTERM");
        unlinkSync(pidFile);
        console.log(`Sent stop signal to ShaktimaanAI (PID ${pid}).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to stop process ${pid}: ${msg}`);
        // Clean up stale PID file
        try { unlinkSync(pidFile); } catch { /* ignore */ }
        process.exit(1);
      }
    });
}
```

- [ ] **Step 6: Run all tests to verify nothing is broken**

```bash
npx vitest run --reporter=verbose
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/start.ts src/commands/stop.ts tests/commands/start.test.ts tests/commands/stop.test.ts
git commit -m "$(cat <<'EOF'
feat: implement start/stop commands with Heimdall, pipeline wiring, PID file, and crash recovery
EOF
)"
```

---

## Post-Completion Verification

After all 12 tasks are done, run the full test suite one final time:

```bash
npx vitest run --reporter=verbose
```

All tests should pass. Then verify the build:

```bash
npm run build
```

The `dist/` output should include all new modules. Verify the templates are accessible:

```bash
ls dist/templates/
```

If templates are not in dist (tsup may not copy non-TS files), add a postbuild copy step to `package.json`:

```json
"scripts": {
  "build": "tsup && cp -r src/templates dist/templates",
}
```

---

## What Spec 2a Delivers

After completing this plan, you can:

1. **`shkmn start`** — Starts Heimdall (file watcher) + runs crash recovery
2. **`shkmn stop`** — Stops the running watcher via PID signal
3. **Drop a `.task` file in inbox** → Heimdall detects it → pipeline runs through configured stages → task lands in `10-complete/`, `11-failed/`, or `12-hold/`
4. **`pipeline.approveAndResume(slug)`** → resumes a held task past the review gate
5. **Brahma** creates `.task` files from structured input (wired to CLI in Spec 3)
6. **Sutradhaar** classifies ambiguous input by keywords or LLM (wired to Slack in Spec 3)
7. **Indra** finds and approves held tasks (wired to CLI in Spec 3)
8. **Agent registry** enforces concurrency limits (max total + max validate)
9. **Crash recovery** scans pending dirs on startup and resumes interrupted runs
10. **Stub templates** for all 9 stages are ready for Spec 2b/2c to flesh out

## What's Next

- **Spec 2b: Alignment Agents** — Replace stub templates for Narada, Chitragupta, Vishwakarma, Vastu, Chanakya with real prompts. Add stage-specific logic (e.g., hiding task from Chitragupta).
- **Spec 2c: Execution Agents & TDD** — Hanuman (worktree setup), Karigar (TDD impl), Dharma (build/test), Drona (review loop), Garuda (PR creation). Git worktree management. Red-green-refactor cycle.
