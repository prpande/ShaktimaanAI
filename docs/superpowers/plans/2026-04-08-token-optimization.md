# Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce pipeline token consumption by 60-80% per run through SDK isolation, scoped artifact passing, model adjustments, and stage ordering fixes.

**Architecture:** The agent-runner's `query()` call is modified to use SDK isolation mode (`settingSources: []`, custom `systemPrompt`), eliminating ~50-70k tokens of Claude Code overhead per agent. Artifact passing is scoped per-stage instead of concatenating all artifacts. Validate moves to Haiku, research to Sonnet.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Zod

**Spec:** `docs/superpowers/specs/2026-04-08-token-optimization-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/types.ts` | Modify | Add `requiredMcpServers`, `repoSummary` to `RunState` and `AgentRunOptions` |
| `src/config/defaults.ts` | Modify | Add `STAGE_ARTIFACT_RULES`, `MCP_TOOL_PREFIXES`, `STAGE_MCP_NEEDS`. Update model defaults |
| `src/core/retry.ts` | Modify | Rename `READY_FOR_REVIEW` → `PASS` |
| `src/core/agent-runner.ts` | Modify | Split prompt builder, add SDK isolation, add MCP resolution |
| `src/core/pipeline.ts` | Modify | Replace artifact concatenation with `collectArtifacts()` |
| `src/core/astra-triage.ts` | Modify | Add `requiredMcpServers` to schema |
| `src/core/task-creator.ts` | Modify | Pass `requiredMcpServers` through task creation |
| `src/core/watcher.ts` | Modify | Thread `requiredMcpServers` from triage to task creator |
| `agents/validate.md` | Modify | Update verdict from `READY_FOR_REVIEW` → `PASS` |
| `agents/quick-triage.md` | Modify | Add `requiredMcpServers` output, strengthen ordering |
| `agents/impl.md` | Modify | Add plan-first guidance |
| `agents/review.md` | Modify | Add code-inspection guidance |
| `agents/design.md` | Modify | Add alignment chain guidance |
| `agents/structure.md` | Modify | Add alignment chain guidance |
| `agents/plan.md` | Modify | Add alignment chain guidance |
| `tests/core/retry.test.ts` | Modify | Update verdict references |
| `tests/core/agent-runner.test.ts` | Modify | Test prompt split, artifact scoping, MCP resolution |
| `tests/core/pipeline.test.ts` | Modify | Update verdict references, test `collectArtifacts()` |

---

### Task 1: Rename validate verdict READY_FOR_REVIEW → PASS

**Files:**
- Modify: `src/core/retry.ts:44`
- Modify: `agents/validate.md:83-93`
- Test: `tests/core/retry.test.ts`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Update the verdict constant in retry.ts**

In `src/core/retry.ts`, change line 44:

```typescript
const VALIDATE_VERDICTS = ["PASS", "NEEDS_FIXES"] as const;
```

And update `decideAfterValidate` at line 118:

```typescript
if (outcome.verdict === "PASS") {
    return { action: "continue", reason: "Validation passed" };
}
```

- [ ] **Step 2: Update the validate agent prompt**

In `agents/validate.md`, replace lines 80-95:

```markdown
## Step 5 — Output Verdict

The final line of your output MUST be in this exact format (the pipeline parses it):

```
**Verdict:** PASS
```

or

```
**Verdict:** NEEDS_FIXES
```

Use `PASS` if and only if both build AND tests passed (or build was skipped and tests passed).
Use `NEEDS_FIXES` otherwise.

Do NOT include any text after the verdict line.
```

- [ ] **Step 3: Update retry tests**

In `tests/core/retry.test.ts`, replace all instances of `READY_FOR_REVIEW` with `PASS`. Key locations:

- `parseAgentVerdict` tests: change expected values from `"READY_FOR_REVIEW"` to `"PASS"`
- `decideAfterValidate` test fixtures: change `verdict: "READY_FOR_REVIEW"` to `verdict: "PASS"` and `**Verdict:** READY_FOR_REVIEW` to `**Verdict:** PASS`

Use find-and-replace across the file: `READY_FOR_REVIEW` → `PASS`

- [ ] **Step 4: Update pipeline tests**

In `tests/core/pipeline.test.ts`, replace all instances of `READY_FOR_REVIEW` with `PASS`. These appear in mock runner return values like:

```typescript
"**Verdict:** PASS"
```

Use find-and-replace across the file: `READY_FOR_REVIEW` → `PASS`

- [ ] **Step 5: Update pipeline-budget tests**

In `tests/core/pipeline-budget.test.ts`, replace `READY_FOR_REVIEW` with `PASS`:

```typescript
output: "**Verdict:** PASS\n\nAll checks passed.",
```

- [ ] **Step 6: Run tests to verify**

Run: `npx vitest run tests/core/retry.test.ts tests/core/pipeline.test.ts tests/core/pipeline-budget.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/retry.ts agents/validate.md tests/core/retry.test.ts tests/core/pipeline.test.ts tests/core/pipeline-budget.test.ts
git commit -m "refactor: rename validate verdict READY_FOR_REVIEW → PASS

Removes misleading name that implied validate precedes review.
The canonical order is impl → review → validate → pr."
```

---

### Task 2: Add types for requiredMcpServers and repoSummary

**Files:**
- Modify: `src/core/types.ts:28-58` (RunState)
- Modify: `src/core/types.ts:60-72` (AgentRunOptions)
- Modify: `src/core/types.ts:88-105` (AstraTriageResult)

- [ ] **Step 1: Add fields to RunState**

In `src/core/types.ts`, add after the `holdDetail` field (line 57):

```typescript
  // Token optimization: Astra-determined MCP requirements and repo summary
  requiredMcpServers?: string[];
  repoSummary?: string;
```

- [ ] **Step 2: Add fields to AgentRunOptions**

In `src/core/types.ts`, add after the `model` field (line 72):

```typescript
  requiredMcpServers?: string[];
  repoSummary?: string;
```

- [ ] **Step 3: Add requiredMcpServers to AstraTriageResult**

In `src/core/types.ts`, add after the `repoSummary` field (line 100):

```typescript
  requiredMcpServers?: string[] | null;
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors (new fields are optional)

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add requiredMcpServers and repoSummary to pipeline types

Supports dynamic MCP server selection via Astra triage
and cached repo context for validate stage."
```

---

### Task 3: Add STAGE_ARTIFACT_RULES and update model defaults

**Files:**
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add the artifact rules type and config**

In `src/config/defaults.ts`, add after the `STAGE_CONTEXT_RULES` block (after line 57):

```typescript
export interface StageArtifactRule {
  mode: 'all_prior' | 'specific' | 'none';
  specificFiles?: string[];
  includeRetryFeedback?: boolean;
  useRepoSummary?: boolean;
}

export const STAGE_ARTIFACT_RULES: Record<string, StageArtifactRule> = {
  questions:       { mode: 'none' },
  research:        { mode: 'all_prior' },
  design:          { mode: 'all_prior' },
  structure:       { mode: 'all_prior' },
  plan:            { mode: 'all_prior' },
  impl:            { mode: 'all_prior', includeRetryFeedback: true },
  review:          { mode: 'specific', specificFiles: ['plan-output', 'design-output'] },
  validate:        { mode: 'none', useRepoSummary: true },
  pr:              { mode: 'specific', specificFiles: ['impl-output', 'review-output'] },
  quick:           { mode: 'none' },
  "quick-triage":  { mode: 'none' },
  "quick-execute": { mode: 'none' },
  "slack-io":      { mode: 'none' },
};
```

- [ ] **Step 2: Add MCP tool prefix mapping**

Add after `STAGE_ARTIFACT_RULES`:

```typescript
/**
 * Maps short MCP server names to their tool name prefixes.
 * Used to match Astra's requiredMcpServers against stage tool permissions.
 */
export const MCP_TOOL_PREFIXES: Record<string, string> = {
  slack:  "mcp__claude_ai_Slack__",
  notion: "mcp__plugin_notion_notion__",
  figma:  "mcp__plugin_figma_figma__",
};
```

- [ ] **Step 3: Update default model assignments**

In `DEFAULT_CONFIG.agents.models` (line 197-210), change:

```typescript
models: {
  questions: "sonnet",
  research: "sonnet",      // was "opus" — tool-heavy, not reasoning-heavy
  design: "opus",
  structure: "sonnet",
  plan: "opus",
  impl: "opus",
  review: "sonnet",
  validate: "haiku",       // was "sonnet" — mechanical build/test/verdict
  pr: "sonnet",
  "quick-triage": "haiku",
  quick: "haiku",
  "quick-execute": "sonnet",
  "slack-io": "haiku",
},
```

- [ ] **Step 4: Update validate context rule**

In `STAGE_CONTEXT_RULES`, update the validate entry to disable `includeRepoContext` (it will use Astra's repoSummary instead):

```typescript
validate:  { includeTaskContent: false, previousOutputLabel: "Review Output", includeRepoContext: false },
```

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/config/defaults.ts
git commit -m "feat: add STAGE_ARTIFACT_RULES, MCP prefixes, update models

- Scoped artifact passing rules per pipeline stage
- MCP tool prefix mapping for dynamic server resolution
- Research: opus → sonnet, validate: sonnet → haiku
- Validate: disable includeRepoContext (uses repoSummary)"
```

---

### Task 4: Implement collectArtifacts() in pipeline.ts

**Files:**
- Modify: `src/core/pipeline.ts:407-413`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test for collectArtifacts**

In `tests/core/pipeline.test.ts`, add a new describe block. Import `collectArtifacts` from the pipeline module (it will be exported for testing). Add tests:

```typescript
import { collectArtifacts } from "../../src/core/pipeline.js";

describe("collectArtifacts", () => {
  const artifactsDir = join(TEST_DIR, "artifacts-test");

  beforeAll(() => {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "questions-output.md"), "Q output", "utf-8");
    writeFileSync(join(artifactsDir, "research-output.md"), "R output", "utf-8");
    writeFileSync(join(artifactsDir, "design-output.md"), "D output", "utf-8");
    writeFileSync(join(artifactsDir, "plan-output.md"), "P output", "utf-8");
    writeFileSync(join(artifactsDir, "impl-output.md"), "I output", "utf-8");
    writeFileSync(join(artifactsDir, "review-output.md"), "Rev output", "utf-8");
    writeFileSync(join(artifactsDir, "retry-feedback-validate-1.md"), "Fix these", "utf-8");
  });

  const stages = ["questions", "research", "design", "plan", "impl", "review", "validate", "pr"];

  it("returns empty for mode:none stages", () => {
    expect(collectArtifacts(artifactsDir, "questions", stages)).toBe("");
    expect(collectArtifacts(artifactsDir, "validate", stages)).toBe("");
  });

  it("returns all prior alignment outputs for all_prior mode", () => {
    const result = collectArtifacts(artifactsDir, "design", stages);
    expect(result).toContain("Q output");
    expect(result).toContain("R output");
    expect(result).not.toContain("D output");
  });

  it("includes all alignment outputs for impl", () => {
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).toContain("Q output");
    expect(result).toContain("R output");
    expect(result).toContain("D output");
    expect(result).toContain("P output");
    expect(result).not.toContain("I output");
  });

  it("includes retry feedback for impl when includeRetryFeedback is set", () => {
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).toContain("Fix these");
  });

  it("returns only specific files for review", () => {
    const result = collectArtifacts(artifactsDir, "review", stages);
    expect(result).toContain("P output");
    expect(result).toContain("D output");
    expect(result).not.toContain("Q output");
    expect(result).not.toContain("I output");
  });

  it("returns impl and review outputs for pr", () => {
    const result = collectArtifacts(artifactsDir, "pr", stages);
    expect(result).toContain("I output");
    expect(result).toContain("Rev output");
    expect(result).not.toContain("Q output");
    expect(result).not.toContain("P output");
  });

  it("excludes execution stage outputs from all_prior", () => {
    // impl should not see review/validate outputs even if files exist
    const result = collectArtifacts(artifactsDir, "impl", stages);
    expect(result).not.toContain("Rev output");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/pipeline.test.ts -t "collectArtifacts"`
Expected: FAIL — `collectArtifacts` not exported

- [ ] **Step 3: Implement collectArtifacts**

In `src/core/pipeline.ts`, add the function after the imports and re-export it:

```typescript
import { STAGE_ARTIFACT_RULES } from "../config/defaults.js";

export function collectArtifacts(
  artifactsDir: string,
  stage: string,
  stages: string[],
): string {
  const rules = STAGE_ARTIFACT_RULES[stage] ?? { mode: 'all_prior' as const };

  if (rules.mode === 'none') return '';

  let files: string[];
  try {
    files = readdirSync(artifactsDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return '';
  }

  if (rules.mode === 'specific') {
    return files
      .filter(f => rules.specificFiles!.some(prefix => f.startsWith(prefix)))
      .map(f => readFileSync(join(artifactsDir, f), 'utf-8'))
      .join('\n');
  }

  // mode === 'all_prior': only include outputs from stages before current
  const stageIdx = stages.indexOf(stage);
  if (stageIdx <= 0) return '';
  const priorStages = new Set(stages.slice(0, stageIdx));

  return files
    .filter(f => {
      if (rules.includeRetryFeedback && f.startsWith('retry-feedback-')) return true;
      const stageMatch = f.match(/^(\w[\w-]*?)-output/);
      return stageMatch ? priorStages.has(stageMatch[1]) : false;
    })
    .map(f => readFileSync(join(artifactsDir, f), 'utf-8'))
    .join('\n');
}
```

- [ ] **Step 4: Replace the inline artifact concatenation in processStage**

In `src/core/pipeline.ts`, in the `processStage` function, replace the artifact collection block (around line 407-414):

Old code:
```typescript
      let previousOutput = "";
      if (existsSync(artifactsDir)) {
        const files = readdirSync(artifactsDir).filter(f => f.endsWith(".md")).sort();
        for (const file of files) {
          previousOutput += readFileSync(join(artifactsDir, file), "utf-8") + "\n";
        }
      }
```

New code:
```typescript
      const previousOutput = existsSync(artifactsDir)
        ? collectArtifacts(artifactsDir, stage, state.stages)
        : "";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "feat: implement scoped artifact passing via collectArtifacts()

Replaces blanket concatenation of all .md artifacts with
stage-aware rules: alignment stages get all_prior, review
gets plan+design only, validate gets none, pr gets impl+review."
```

---

### Task 5: Split buildSystemPrompt into system + user prompts

**Files:**
- Modify: `src/core/agent-runner.ts:84-173`
- Test: `tests/core/agent-runner.test.ts`

- [ ] **Step 1: Write failing tests for the split**

In `tests/core/agent-runner.test.ts`, add tests for the new functions:

```typescript
import {
  buildSystemPrompt,       // existing — will be kept for backward compat
  buildAgentSystemPrompt,  // new
  buildAgentUserPrompt,    // new
  resolveToolPermissions,
  resolveMaxTurns,
  resolveTimeoutMinutes,
} from "../../src/core/agent-runner.js";

describe("buildAgentSystemPrompt", () => {
  it("includes identity and agent instructions", () => {
    writeAgentMd("questions", "# Ask good questions");
    const config = makeConfig();
    const options = makeOptions(config, "questions");
    const result = buildAgentSystemPrompt(options);
    expect(result).toContain("questions agent");
    expect(result).toContain("Ask good questions");
  });

  it("does NOT include task content or previous output", () => {
    writeAgentMd("design", "# Design instructions");
    const config = makeConfig();
    const options = makeOptions(config, "design");
    options.taskContent = "Build a feature";
    options.previousOutput = "Research findings here";
    const result = buildAgentSystemPrompt(options);
    expect(result).not.toContain("Build a feature");
    expect(result).not.toContain("Research findings here");
  });
});

describe("buildAgentUserPrompt", () => {
  it("includes task content when rules say so", () => {
    writeAgentMd("design", "# Design");
    const config = makeConfig();
    const options = makeOptions(config, "design");
    options.taskContent = "Build a feature";
    const result = buildAgentUserPrompt(options);
    expect(result).toContain("Build a feature");
  });

  it("includes previous output when available", () => {
    writeAgentMd("design", "# Design");
    const config = makeConfig();
    const options = makeOptions(config, "design");
    options.previousOutput = "Research findings";
    const result = buildAgentUserPrompt(options);
    expect(result).toContain("Research findings");
  });

  it("includes repoSummary for validate when useRepoSummary is set", () => {
    writeAgentMd("validate", "# Validate");
    const config = makeConfig();
    const options = makeOptions(config, "validate");
    options.repoSummary = "npm test runs vitest";
    const result = buildAgentUserPrompt(options);
    expect(result).toContain("npm test runs vitest");
  });
});
```

You will also need to add a `makeOptions` helper to the test file:

```typescript
function makeOptions(config: ReturnType<typeof makeConfig>, stage: string): AgentRunOptions {
  return {
    stage,
    slug: "test-slug",
    taskContent: "Test task content",
    previousOutput: "",
    outputPath: join(TEST_DIR, "output.md"),
    cwd: REPO_DIR,
    config,
    logger: { info() {}, warn() {}, error() {} },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/agent-runner.test.ts -t "buildAgentSystemPrompt"`
Expected: FAIL — functions don't exist

- [ ] **Step 3: Implement the split**

In `src/core/agent-runner.ts`, add two new functions alongside the existing `buildSystemPrompt` (which remains for backward compatibility):

```typescript
/**
 * Builds the system prompt: static per-stage content that benefits from caching.
 * Contains: identity, pipeline context, agent instructions, output instructions.
 * Does NOT contain: task content, previous output, repo context, stage hints.
 */
export function buildAgentSystemPrompt(options: AgentRunOptions): string {
  const { stage, slug, taskContent, config, outputPath } = options;

  const agentsDir = resolveAgentsDir(config);
  const agentInstructions = loadAgentPrompt(agentsDir, stage);
  const taskMeta = parseTaskFile(taskContent);

  const agentName = config.agents.names[stage] ?? stage;
  const stageList = (taskMeta.stages.length > 0 ? taskMeta.stages : config.agents.defaultStages).join(", ");

  const sections: string[] = [];

  // Identity
  sections.push(`# Identity\n\nYou are ${agentName}, the ${stage} agent in the ShaktimaanAI pipeline.`);

  // Pipeline context
  const EXECUTION_STAGES = new Set(["impl", "validate", "review", "pr"]);
  const isExecStage = EXECUTION_STAGES.has(stage);
  let pipelineCtx = `## Pipeline Context\n\nPipeline: ShaktimaanAI | Task: ${slug} | Stage: ${stage}\nStage sequence for this task: ${stageList}`;
  if (taskMeta.repo) {
    if (isExecStage && options.cwd !== taskMeta.repo) {
      pipelineCtx += `\nTarget repository (original): ${taskMeta.repo}`;
      pipelineCtx += `\nWorking directory (YOUR worktree copy): ${options.cwd}`;
      pipelineCtx += `\nCRITICAL: You are working in a git worktree. ALL file reads, writes, and edits MUST use paths under your working directory (${options.cwd}), NOT the original repo path. The worktree is a full copy of the repo.`;
    } else {
      pipelineCtx += `\nTarget repository: ${taskMeta.repo}`;
      pipelineCtx += `\nIMPORTANT: Your working directory is NOT the repo root. Use absolute paths when reading repo files.`;
    }
    pipelineCtx += `\nIMPORTANT: On Windows, use forward slashes or escaped backslashes in paths. Do NOT use /c/Users/... paths in Node.js — use C:/Users/... instead.`;
  }
  sections.push(pipelineCtx);

  // Agent instructions
  sections.push(`---\n\n${agentInstructions}`);

  // Output instructions
  const { disallowed } = resolveToolPermissions(stage, config);
  const canWrite = !disallowed.includes("Write");
  if (canWrite) {
    sections.push(`---\n\nWrite your output to: ${outputPath}`);
  } else {
    sections.push(
      `---\n\n## Output Instructions\n\n` +
      `Output your complete response as text. Do NOT attempt to write files — ` +
      `the pipeline will capture your text output automatically. ` +
      `Do NOT use Bash to write files (echo, cat heredoc, python, etc.).`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the user prompt: dynamic per-invocation content.
 * Contains: task content, previous stage outputs, repo context, stage hints.
 */
export function buildAgentUserPrompt(options: AgentRunOptions): string {
  const { stage, taskContent, previousOutput, config } = options;

  const rules = STAGE_CONTEXT_RULES[stage] ?? {
    includeTaskContent: true,
    previousOutputLabel: "Previous Output",
    includeRepoContext: true,
  };

  const artifactRules = STAGE_ARTIFACT_RULES[stage];
  const taskMeta = parseTaskFile(taskContent);

  const sections: string[] = [];

  // Task content (conditional)
  if (rules.includeTaskContent) {
    sections.push(`## Task\n\n${taskContent}`);
  }

  // Previous output (now scoped via STAGE_ARTIFACT_RULES)
  if (previousOutput && previousOutput.trim()) {
    const label = rules.previousOutputLabel ?? "Previous Output";
    sections.push(`## ${label}\n\n${previousOutput}`);
  }

  // Repo context — either Astra's cached summary or live gatherRepoContext
  if (artifactRules?.useRepoSummary && options.repoSummary) {
    sections.push(`## Repo Context\n\n${options.repoSummary}`);
  } else if (rules.includeRepoContext) {
    const repoContext = gatherRepoContext(taskMeta.repo);
    sections.push(`## Repo Context\n\n${repoContext}`);
  }

  // User Guidance (stage hints)
  const taskFileHint = taskMeta.stageHints[stage];
  const runtimeHints = options.stageHints?.[stage] ?? [];
  const allHints: string[] = [
    ...(taskFileHint ? [taskFileHint] : []),
    ...runtimeHints,
  ];
  if (allHints.length > 0) {
    const bullets = allHints.map((h) => `- ${h}`).join("\n");
    sections.push(
      `## User Guidance\n\nThe user has provided the following instructions for this stage:\n${bullets}`,
    );
  }

  return sections.join("\n\n");
}
```

Add the import for `STAGE_ARTIFACT_RULES` at the top:

```typescript
import { DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES, STAGE_ARTIFACT_RULES } from "../config/defaults.js";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/agent-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runner.ts tests/core/agent-runner.test.ts
git commit -m "feat: split buildSystemPrompt into system + user prompts

System prompt (static): identity, pipeline context, agent instructions.
User prompt (dynamic): task content, previous output, repo context.
Enables SDK prompt caching and repoSummary support for validate."
```

---

### Task 6: Add SDK isolation to runAgent

**Files:**
- Modify: `src/core/agent-runner.ts:182-337` (runAgent function)

- [ ] **Step 1: Update runAgent to use SDK isolation**

In `src/core/agent-runner.ts`, modify the `runAgent` function. Change the `query()` call to use the new prompt split and SDK isolation:

```typescript
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { stage, cwd, config, logger, abortController: externalAbort } = options;

  const startMs = Date.now();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const { allowed: allowedTools, disallowed: disallowedTools } = resolveToolPermissions(stage, config);
  const systemPrompt = buildAgentSystemPrompt(options);
  const userPrompt = buildAgentUserPrompt(options);
  const streamLogPath = options.outputPath.replace(/\.md$/, "-stream.jsonl");
  const streamLogger = createStreamLogger(streamLogPath);
  const maxTurns = resolveMaxTurns(stage, config);
  const timeoutMinutes = resolveTimeoutMinutes(stage, config);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const model = options.model ?? config.agents.models?.[stage];

  // Resolve MCP servers: intersection of task needs and stage permissions
  const mcpServers = resolveMcpServers(
    stage,
    options.requiredMcpServers ?? [],
    config,
  );

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
    let inputTokens = 0;
    let outputTokens = 0;
    let receivedResult = false;

    const messages = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        settingSources: [],     // SDK isolation — no hooks, no filesystem settings
        mcpServers,             // only servers this stage needs
        ...(model ? { model } : {}),
        allowedTools,
        disallowedTools,
        maxTurns,
        cwd,
        abortController,
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
      },
    });

    // ... rest of the function remains unchanged
```

- [ ] **Step 2: Implement resolveMcpServers**

Add this function to `src/core/agent-runner.ts` before `runAgent`:

```typescript
import { MCP_TOOL_PREFIXES } from "../config/defaults.js";

/**
 * Resolves which MCP servers to load for a stage.
 * Returns the intersection of task-level requirements (from Astra)
 * and stage-level tool permissions.
 *
 * When requiredMcpServers is empty (no Astra triage, direct CLI),
 * falls back to loading servers whose tool prefixes appear in
 * the stage's allowed tools list.
 */
export function resolveMcpServers(
  stage: string,
  requiredMcpServers: string[],
  config: ResolvedConfig,
): Record<string, Record<string, unknown>> {
  const stageTools = resolveToolPermissions(stage, config);
  const result: Record<string, Record<string, unknown>> = {};

  // Determine which MCP servers to consider
  const candidates = requiredMcpServers.length > 0
    ? requiredMcpServers
    : Object.keys(MCP_TOOL_PREFIXES); // fallback: consider all known servers

  for (const serverName of candidates) {
    const toolPrefix = MCP_TOOL_PREFIXES[serverName];
    if (!toolPrefix) continue;

    // Check if the stage's allowed tools include this server's tool prefix
    const isAllowed = stageTools.allowed.some(t =>
      t === toolPrefix + '*' || t.startsWith(toolPrefix),
    );

    if (!isAllowed) continue;

    // Note: Cloud-hosted MCP servers (Slack, Notion, Figma) are loaded
    // via the Claude Code plugin system. The mcpServers option in the SDK
    // is for local stdio/sse/http servers. For cloud MCPs, we rely on
    // the SDK's allowedTools to make the right tools available.
    // This is a placeholder — the exact server config depends on the
    // MCP server type (cloud vs local).
  }

  return result;
}
```

> **Implementation note:** The cloud-hosted MCP servers (Slack, Notion, Figma) are managed by Claude Code's plugin system, not via the `mcpServers` option. With `settingSources: []`, plugins don't auto-load. The `allowedTools`/`disallowedTools` arrays still control which tools the agent can call. For stages needing MCP tools, the implementer should investigate whether passing `settingSources: ['user']` or using the SDK's `plugins` option is needed to load cloud MCP plugins selectively. The core SDK isolation (removing hooks and the Claude Code system prompt) is the primary win regardless.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS (runAgent is mocked in pipeline tests)

- [ ] **Step 4: Commit**

```bash
git add src/core/agent-runner.ts
git commit -m "feat: add SDK isolation to agent runner

- settingSources: [] prevents hooks from loading (~40-50k tokens saved)
- Custom systemPrompt replaces Claude Code default
- User prompt carries dynamic content (task, artifacts, repo context)
- resolveMcpServers placeholder for cloud MCP integration"
```

---

### Task 7: Thread requiredMcpServers through triage → task → pipeline

**Files:**
- Modify: `src/core/astra-triage.ts:9-22`
- Modify: `src/core/task-creator.ts`
- Modify: `src/core/watcher.ts:285-299`
- Modify: `src/core/pipeline.ts` (processStage)
- Modify: `src/task/parser.ts` (if needed)

- [ ] **Step 1: Add requiredMcpServers to triage schema**

In `src/core/astra-triage.ts`, add to `triageResultSchema` after line 19 (`repoSummary`):

```typescript
  requiredMcpServers: z.array(z.string()).nullable().optional(),
```

- [ ] **Step 2: Add requiredMcpServers to CreateTaskInput**

In `src/core/task-creator.ts`, add to `CreateTaskInput` interface:

```typescript
  requiredMcpServers?: string[];
```

- [ ] **Step 3: Thread requiredMcpServers through buildTaskFileContent**

In `src/core/task-creator.ts`, update `buildTaskFileContent` to include `requiredMcpServers`. Add after the `repoSummary` block (around line 153):

```typescript
  if (input.requiredMcpServers && input.requiredMcpServers.length > 0) {
    lines.push("## Required MCP Servers");
    lines.push(input.requiredMcpServers.join(", "));
    lines.push("");
  }
```

Also update the `createTask` function to pass it through.

- [ ] **Step 4: Update watcher to pass requiredMcpServers**

In `src/core/watcher.ts`, update the `case "route_pipeline"` block (around line 285-299):

```typescript
          case "route_pipeline": {
            createTask(
              {
                source: "slack",
                content: text,
                repo: process.cwd(),
                slackThread: entry.thread_ts ?? entry.ts,
                stages: triageResult.recommendedStages ?? undefined,
                stageHints: triageResult.stageHints ?? undefined,
                requiredMcpServers: triageResult.requiredMcpServers ?? undefined,
              },
              runtimeDir,
              config,
              triageResult.enrichedContext ?? undefined,
              triageResult.repoSummary ?? undefined,
            );
```

- [ ] **Step 5: Parse requiredMcpServers from task file and store in RunState**

In `src/task/parser.ts`, check if `requiredMcpServers` is already parsed from task file metadata. If not, add parsing for the `## Required MCP Servers` section. The parsed value should be available in `TaskMeta`.

In `src/core/pipeline.ts`, in `createRunState`, read the parsed `requiredMcpServers` and `repoSummary` from the task metadata and store them in `RunState`:

```typescript
export function createRunState(
  slug: string,
  taskMeta: TaskMeta,
  config: ResolvedConfig,
): RunState {
  // ... existing code ...
  return {
    // ... existing fields ...
    requiredMcpServers: taskMeta.requiredMcpServers,
    repoSummary: taskMeta.repoSummary,
  };
}
```

- [ ] **Step 6: Pass requiredMcpServers and repoSummary to runAgent**

In `src/core/pipeline.ts`, in the `processStage` function, update the `runOptions` construction (around line 429-440):

```typescript
      const runOptions: AgentRunOptions = {
        stage,
        slug,
        taskContent,
        previousOutput: previousOutput.trim(),
        outputPath,
        cwd: stageCwd,
        config,
        stageHints: state.stageHints,
        abortController,
        logger: taskLogger,
        requiredMcpServers: state.requiredMcpServers,
        repoSummary: state.repoSummary,
      };
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/astra-triage.ts src/core/task-creator.ts src/core/watcher.ts src/core/pipeline.ts src/task/parser.ts
git commit -m "feat: thread requiredMcpServers from triage through pipeline

Astra's triage result flows: schema → task file → RunState →
agent runner options. Enables dynamic MCP server resolution."
```

---

### Task 8: Add enforceStageOrder and update quick-triage prompt

**Files:**
- Modify: `src/core/task-creator.ts:64-88`
- Modify: `agents/quick-triage.md`
- Test: `tests/core/task-creator.test.ts` (if exists, else add to existing)

- [ ] **Step 1: Write failing test for enforceStageOrder**

Check if `tests/core/task-creator.test.ts` exists. If so, add to it; if not, the `normalizeStages` function already exists in `task-creator.ts` and handles ordering. Verify that `normalizeStages` already enforces canonical order by running existing tests.

If `normalizeStages` already sorts into `CANONICAL_ORDER`, no new function is needed — it already does what `enforceStageOrder` would do. Check line 87:

```typescript
return CANONICAL_ORDER.filter((s) => stageSet.has(s));
```

This already enforces canonical order. Verify with a test:

```typescript
it("corrects out-of-order stages", () => {
  expect(normalizeStages(["validate", "impl", "review"])).toEqual([
    "design", "plan", "impl", "review", "validate",
  ]);
});
```

- [ ] **Step 2: Update quick-triage prompt for ordering and requiredMcpServers**

In `agents/quick-triage.md`, make these changes:

Replace lines 54 (output format section) — add `requiredMcpServers`:

```markdown
- `requiredMcpServers` — array of MCP server names needed for this task, or `[]`. Valid values: `"slack"`, `"notion"`, `"figma"`. Analyze the task content: if it references Figma designs or figma.com URLs, include `"figma"`. If it references Notion pages or needs Notion queries, include `"notion"`. If it references Slack threads or needs Slack context, include `"slack"`. If no external systems are needed, output `[]`.
```

Replace line 65 (canonical order guidance) with stronger language:

```markdown
- **Execution stage order is FIXED: `impl → review → validate → pr`.** Review ALWAYS comes before validate — the review agent inspects code quality, then the validate agent runs build and tests. NEVER output validate before review.
- **Always preserve the canonical stage order:** questions → research → design → structure → plan → impl → review → validate → pr. The `normalizeStages` function on the server enforces this, but get it right in your output.
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add agents/quick-triage.md src/core/task-creator.ts tests/
git commit -m "feat: strengthen stage ordering, add requiredMcpServers to triage

- Explicit execution stage ordering in quick-triage prompt
- requiredMcpServers field in triage output format
- normalizeStages already enforces canonical order (verified)"
```

---

### Task 9: Update agent prompts

**Files:**
- Modify: `agents/impl.md`
- Modify: `agents/review.md`
- Modify: `agents/design.md`
- Modify: `agents/structure.md`
- Modify: `agents/plan.md`

- [ ] **Step 1: Update impl.md**

Add to the beginning of `agents/impl.md`, after the first heading:

```markdown
## Context Awareness

You receive the complete alignment chain (questions, research, design, structure, plan) as context. The **plan** is your primary guide — follow its slices, steps, and file paths. If the plan references files, patterns, or APIs that you need to verify, use your tools (Read, Grep, Glob) to inspect the codebase directly. Only explore beyond the plan when the provided context is insufficient.
```

- [ ] **Step 2: Update review.md**

Add to the beginning of `agents/review.md`, after the first heading:

```markdown
## Review Approach

You receive the **plan** and **design** documents as context — these describe what was supposed to be built. Your job is to review the ACTUAL code changes against what the plan specified. Use `git diff` or `git log` to discover what changed, then Read the modified files to inspect the implementation. Do not rely on implementation summaries — inspect the work directly.
```

- [ ] **Step 3: Update design.md, structure.md, plan.md**

Add to each file, after the first heading:

```markdown
## Alignment Context

You receive all findings from prior stages. Rely primarily on the most recent stage's output, but reference earlier findings when you need to understand the reasoning behind decisions or verify assumptions.
```

- [ ] **Step 4: Commit**

```bash
git add agents/impl.md agents/review.md agents/design.md agents/structure.md agents/plan.md
git commit -m "feat: update agent prompts for scoped artifact strategy

- impl: plan-first guidance, explore repo only when needed
- review: inspect actual code via git diff, not impl summaries
- design/structure/plan: alignment chain context guidance"
```

---

### Task 10: Final integration test and build verification

**Files:**
- All modified files

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: Build succeeds, agents/*.md copied to dist/agents/

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify agent prompts were copied**

Run: `ls dist/agents/` and verify all modified .md files are present with updated content.

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final integration fixes for token optimization"
```

---

## Post-Implementation Notes

### MCP Cloud Server Integration (Follow-up)

The current implementation uses `settingSources: []` for SDK isolation, which prevents all filesystem settings and hooks from loading. For stages needing cloud-hosted MCP servers (Slack, Notion, Figma), the `resolveMcpServers` function is a placeholder.

**Next step:** Investigate the SDK's behavior when:
1. `settingSources: []` is set but specific MCP tool names are in `allowedTools`
2. The `plugins` option can load specific Claude Code plugins (Slack, Notion, Figma)
3. Whether `settingSources: ['user']` loads MCP configs without hooks

This should be a separate investigation task after the core optimization is deployed and validated.

### Validation

After deploying, run a pipeline task and compare:
- Stream log token counts (cache_creation, cache_read) vs. the baseline (~72k)
- Per-stage cost from interaction logs
- Total pipeline run cost

Expected: initial cache creation should drop from ~72k to ~15-20k tokens per agent invocation.
