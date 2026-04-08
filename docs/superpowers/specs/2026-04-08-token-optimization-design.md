# Token Optimization Design

**Date:** 2026-04-08
**Status:** Draft
**Goal:** Reduce pipeline token consumption by 60-80% per run without sacrificing output quality.

## Problem Statement

Pipeline agents run via the Claude Agent SDK's `query()` function, which loads the full Claude Code environment — hooks, MCP server definitions, skills catalogs, and the base system prompt — into every agent invocation. Stream log analysis of a real pipeline run shows:

- **Research stage (Opus, 54 turns):** Initial cache creation of **72,182 tokens**, peak cache read of **89,180 tokens** per turn. Cost: $1.63.
- **Design stage (Opus, 14 turns):** Initial cache creation of **28,387 tokens**. Cost: $0.54.

The `SessionStart` hook alone injects ~40-50k tokens of superpowers/skills/MCP instructions that headless pipeline agents never use. The actual pipeline system prompt (identity, task content, agent instructions, repo context) accounts for only ~15-20k tokens.

Additionally, the artifact accumulation strategy concatenates ALL `.md` files from `artifacts/` into a single `previousOutput` blob, which grows with every stage and balloons further on retries.

## Design

### 1. SDK Isolation

**Problem:** Every `query()` call loads hooks, MCP server definitions, and the Claude Code system prompt (~50-70k tokens of overhead).

**Fix:** Use SDK isolation options in `agent-runner.ts`:

```typescript
const messages = query({
  prompt: taskPrompt,        // dynamic: task content, previous output
  options: {
    systemPrompt,            // replaces Claude Code system prompt entirely
    settingSources: [],      // prevents hooks from loading (SDK isolation mode)
    mcpServers: mcpForStage, // only servers this stage needs (or {} for none)
    // ... existing options (model, allowedTools, etc.)
  },
});
```

**`systemPrompt` vs `prompt` split:**
- `options.systemPrompt` — static per-stage instructions: identity, pipeline context, agent instructions, output format. Benefits from prompt caching across turns.
- `prompt` — dynamic per-invocation content: task content, previous stage outputs, repo context, retry feedback.

**Dynamic MCP server selection via Astra:**

Instead of hardcoding which MCP servers each stage gets, Astra (quick-triage) determines which external systems the task needs during its initial classification. This is a natural extension of Astra's routing role — it already recommends stages and gathers context.

**Astra output change** — add `requiredMcpServers` to the triage JSON output:

```json
{
  "action": "route_pipeline",
  "recommendedStages": ["research", "design", "plan", "impl", "review", "validate", "pr"],
  "requiredMcpServers": ["slack", "notion"],
  "...": "..."
}
```

Valid values: `"slack"`, `"notion"`, `"figma"` (extensible as new MCP servers are added). Astra determines these by analyzing the task content — does it reference Figma designs, Notion pages, Slack threads, or other external systems?

**Pipeline flow:**
1. Astra outputs `requiredMcpServers` during triage
2. The pipeline stores this in `RunState.requiredMcpServers`
3. At each stage, `agent-runner.ts` resolves MCP servers as the **intersection** of:
   - Astra's `requiredMcpServers` (what the task needs)
   - The stage's `DEFAULT_STAGE_TOOLS` allowed tools (what the stage is permitted to use)

For example: Astra says `["slack", "figma"]`. The `research` stage allows `mcp__claude_ai_Slack__*` but not Figma tools → only Slack MCP is loaded. The `impl` stage allows all tools → both Slack and Figma MCPs are loaded.

**MCP server registry** — a mapping from short names to SDK `McpServerConfig` objects, defined in `defaults.ts`:

```typescript
export const MCP_SERVER_REGISTRY: Record<string, McpServerConfig> = {
  slack:  { /* Slack MCP server config */ },
  notion: { /* Notion MCP server config */ },
  figma:  { /* Figma MCP server config */ },
};
```

**Resolution function:**

```typescript
function resolveMcpServers(
  stage: string,
  requiredMcpServers: string[],
  config: ResolvedConfig,
): Record<string, McpServerConfig> {
  const stageTools = resolveToolPermissions(stage, config);
  const result: Record<string, McpServerConfig> = {};

  for (const serverName of requiredMcpServers) {
    const serverConfig = MCP_SERVER_REGISTRY[serverName];
    if (!serverConfig) continue;

    // Check if the stage's allowed tools include this server's tool prefix
    const toolPrefix = MCP_TOOL_PREFIXES[serverName]; // e.g., "mcp__claude_ai_Slack__"
    const isAllowed = stageTools.allowed.some(t =>
      t === toolPrefix + '*' || t.startsWith(toolPrefix)
    );
    if (isAllowed) {
      result[serverName] = serverConfig;
    }
  }

  return result;
}
```

**Fallback:** When `requiredMcpServers` is not set in `RunState` (direct CLI invocations that bypass Astra, backward compatibility), fall back to loading MCP servers based on the stage's `DEFAULT_STAGE_TOOLS` — if the stage allows MCP tool patterns, load the corresponding servers. This preserves current behavior for non-Astra paths.

**Estimated savings:** ~50-70k tokens per agent invocation. Over a 9-stage pipeline run: **~450-630k tokens saved**. Tasks that don't need external systems save even more — zero MCP overhead across all stages.

### 2. Scoped Artifact Passing

**Problem:** `pipeline.ts:407-413` reads every `.md` file from `artifacts/` and concatenates them into `previousOutput`. By the time `impl` runs, this includes all alignment outputs. On retries, it also includes validate/review outputs and feedback files — a multiplicative waste.

**Fix:** Replace the blanket concatenation with stage-aware artifact selection rules.

#### Artifact Passing Rules

| Stage | Receives | Rationale |
|-------|----------|-----------|
| questions | task content only | First stage, no prior output |
| research | all prior outputs (questions) | Builds on questions |
| design | all prior outputs (questions, research) | Needs full discovery context |
| structure | all prior outputs (questions, research, design) | Needs design + research rationale |
| plan | all prior outputs (questions, research, design, structure) | Needs full alignment chain |
| **impl** | **all alignment outputs + retry feedback files** | Needs complete picture; on retry, also gets validate/review feedback but NOT their full outputs |
| **review** | **plan + design outputs only** | Reviews actual code against plan/design via tools (git diff, Read, Grep); does NOT receive impl's self-reported output |
| **validate** | **none** | Discovers build/test commands from repo; runs them and reports verdict. No pipeline context needed |
| **pr** | **review output only** | Uses review summary to draft PR description |

#### Implementation Approach

Add a new configuration in `defaults.ts` that defines which artifact files each stage receives:

```typescript
export const STAGE_ARTIFACT_RULES: Record<string, {
  mode: 'all_prior' | 'specific' | 'none';
  specificFiles?: string[];   // for 'specific' mode: which output files to include
  includeRetryFeedback?: boolean;
}> = {
  questions:  { mode: 'none' },
  research:   { mode: 'all_prior' },
  design:     { mode: 'all_prior' },
  structure:  { mode: 'all_prior' },
  plan:       { mode: 'all_prior' },
  impl:       { mode: 'all_prior', includeRetryFeedback: true },
  review:     { mode: 'specific', specificFiles: ['plan-output', 'design-output'] },
  validate:   { mode: 'none' },
  pr:         { mode: 'specific', specificFiles: ['review-output'] },
};
```

The `all_prior` mode collects outputs only from stages that appear BEFORE the current stage in the pipeline's stage sequence — not validate/review/impl outputs that may exist from retries. This is determined by comparing against the `stages` array in `RunState`.

The `includeRetryFeedback` flag additionally includes `retry-feedback-*.md` files.

The `specific` mode includes only the named output files (matching `{name}-output*.md` pattern to handle retry suffixes like `plan-output-r1.md`).

**Relationship with `STAGE_CONTEXT_RULES`:** The new `STAGE_ARTIFACT_RULES` replaces the `previousOutputLabel` field in `STAGE_CONTEXT_RULES` — that field becomes unused. The `includeTaskContent` and `includeRepoContext` fields in `STAGE_CONTEXT_RULES` remain and continue to control whether task content and repo context are included in the prompt. Updated context rules for execution stages:

| Stage | includeTaskContent | includeRepoContext | Artifact Mode |
|-------|---|---|---|
| validate | false (unchanged) | true (unchanged) | none |
| review | true (unchanged) | true (unchanged) | specific (plan + design) |
| pr | true (unchanged) | false (unchanged) | specific (review) |

In `pipeline.ts`, the artifact collection block (lines 407-413) is replaced with a function that applies these rules:

```typescript
function collectArtifacts(
  artifactsDir: string,
  stage: string,
  stages: string[],
): string {
  const rules = STAGE_ARTIFACT_RULES[stage] ?? { mode: 'all_prior' };

  if (rules.mode === 'none') return '';

  const files = readdirSync(artifactsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (rules.mode === 'specific') {
    return files
      .filter(f => rules.specificFiles!.some(prefix => f.startsWith(prefix)))
      .map(f => readFileSync(join(artifactsDir, f), 'utf-8'))
      .join('\n');
  }

  // mode === 'all_prior': only include outputs from stages before current
  const stageIdx = stages.indexOf(stage);
  if (stageIdx <= 0) return ''; // first stage or stage not in list
  const priorStages = new Set(stages.slice(0, stageIdx));
  return files
    .filter(f => {
      if (rules.includeRetryFeedback && f.startsWith('retry-feedback-')) return true;
      // Match "{stage}-output.md" or "{stage}-output-r1.md"
      const stageMatch = f.match(/^(\w+)-output/);
      return stageMatch ? priorStages.has(stageMatch[1]) : false;
    })
    .map(f => readFileSync(join(artifactsDir, f), 'utf-8'))
    .join('\n');
}
```

### 3. Model Adjustments

**Problem:** Research runs on Opus (54 turns at $1.63). Validate runs on Sonnet (15 turns for a pass/fail check).

**Changes to `DEFAULT_CONFIG.agents.models`:**

| Stage | Current | Proposed | Rationale |
|-------|---------|----------|-----------|
| research | opus | **sonnet** | Research is tool-heavy (Read, Grep, Bash, WebSearch). The reasoning between tool calls is straightforward. Sonnet handles this well at ~5x less cost. |
| validate | sonnet | **haiku** | Validate's job is mechanical: run build, run tests, report verdict. Haiku is fully capable of executing commands and classifying pass/fail. |
| All others | unchanged | unchanged | Controllable via `agents.models` in config at any time. |

**Estimated savings:** Research drops from ~$1.63 to ~$0.33 per run. Validate drops from ~$0.10 to ~$0.02.

### 4. Agent Prompt Refinements

Modify execution stage prompts to align with the new artifact passing strategy:

**`impl` prompt addition:**
> You receive the complete alignment chain (questions, research, design, structure, plan) as your context. Rely on the plan as your primary guide. If the plan references files, patterns, or APIs that you need to verify, use your tools (Read, Grep, Glob) to inspect the codebase directly.

**`review` prompt modification:**
> You receive the plan and design documents. Your job is to review the ACTUAL code changes against what the plan specified. Use `git diff` to discover what changed, then Read the modified files. Do not rely on implementation summaries — inspect the work directly.

**`validate` prompt — no changes needed.** The existing prompt already says "discover build and test commands" and works from the repo. It naturally functions without prior pipeline context.

**`quick-triage` prompt modification:**
> Add `requiredMcpServers` to the output format. Instruct Astra to analyze the task content for references to external systems (Figma URLs, Notion pages, Slack threads, etc.) and output the corresponding server names. Example guidance: "If the task references Figma designs or figma.com URLs, include `figma`. If it references Notion pages or needs Notion queries, include `notion`. If it references Slack threads or needs Slack context, include `slack`. If no external systems are needed, output an empty array."

**Alignment stage prompts (design, structure, plan) — add guidance:**
> You receive all findings from prior stages. Rely primarily on the most recent stage's output, but reference earlier findings when you need to understand the reasoning behind decisions or verify assumptions.

### 5. Prompt Architecture Refactor

**Current:** `buildSystemPrompt()` constructs one monolithic string passed as `prompt` (user message). The Claude Code system prompt loads separately with hooks adding more content.

**Proposed:** Split into system prompt + user prompt:

```typescript
// System prompt: static per-stage, benefits from caching
function buildAgentSystemPrompt(options: AgentRunOptions): string {
  // Identity, pipeline context, agent instructions, output instructions
  // Does NOT include task content, previous output, or repo context
}

// User prompt: dynamic per-invocation
function buildAgentUserPrompt(options: AgentRunOptions): string {
  // Task content, scoped previous output, repo context, stage hints
}
```

This separation allows the system prompt to be cached across turns within a single agent invocation. The dynamic content in the user prompt changes per stage but is read once.

## What This Design Does NOT Change

- **Max turns** — Already configurable via `agents.maxTurns` in config. No code changes.
- **Repo context in execution stages** — Kept. Execution stages may need the repo map when the plan misses something. Agent prompts guide "plan first, explore if needed."
- **Stage merging** — Structure and plan remain separate stages. After SDK isolation the per-stage overhead is modest (~15-20k tokens vs current ~70-90k), and the quality benefit of separate decomposition + planning outweighs the token cost.
- **Artifact compression** — Not needed. Scoped artifact passing keeps individual stage outputs manageable (2-5k tokens each).
- **Conditional stage skipping** — Already handled by Astra (quick-triage), which recommends only the stages needed for each task.
- **Pipeline retry logic** — Unchanged. The impl-validate-review retry loop works as before; validate just runs cheaper (Haiku) and with less context (none).

## Estimated Impact

| Optimization | Savings Per Stage | Savings Per Run (9 stages) |
|---|---|---|
| SDK isolation | ~50-70k input tokens | ~450-630k tokens |
| Scoped artifacts (execution stages) | ~10-30k for review/validate/pr | ~40-90k tokens |
| Research opus→sonnet | ~5x cost reduction | ~$1.30 saved |
| Validate sonnet→haiku | ~5x cost reduction | ~$0.08 saved |

**Combined estimate:** 60-80% reduction in input tokens per pipeline run, with cost savings concentrated in the research and impl stages.

## Files to Modify

1. **`src/core/agent-runner.ts`** — Add SDK isolation options (`settingSources`, `systemPrompt`, `mcpServers`). Split `buildSystemPrompt` into system + user prompts. Add `resolveMcpServers()` function.
2. **`src/config/defaults.ts`** — Add `STAGE_ARTIFACT_RULES`, `MCP_SERVER_REGISTRY`, `MCP_TOOL_PREFIXES`. Update default models for research and validate.
3. **`src/core/pipeline.ts`** — Replace artifact concatenation (lines 407-413) with `collectArtifacts()` function. Pass `requiredMcpServers` from `RunState` to agent runner.
4. **`src/core/types.ts`** — Add `requiredMcpServers?: string[]` to `RunState` and `AgentRunOptions`.
5. **`agents/quick-triage.md`** — Add `requiredMcpServers` to output format with detection guidance.
6. **`agents/impl.md`** — Add guidance about relying on plan, exploring repo only when needed.
7. **`agents/review.md`** — Add guidance about inspecting actual code via tools, not relying on impl summary.
8. **`agents/design.md`**, **`agents/structure.md`**, **`agents/plan.md`** — Add guidance about using full alignment chain context.
9. **`src/commands/`** — Update triage response parsing to extract and store `requiredMcpServers`.
10. **Tests** — Update `agent-runner` and `pipeline` tests for new artifact passing, SDK options, and MCP resolution.
