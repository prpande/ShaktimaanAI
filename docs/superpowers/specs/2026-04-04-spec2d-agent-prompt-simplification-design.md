# Spec 2d: Agent Prompt Simplification — Design Document

**Version:** 1.0
**Date:** 2026-04-04
**Author:** Pratyush Pande (with Claude)
**Status:** Approved
**Depends on:** Spec 2a, 2b, 2c (all implemented)

---

## 1. Problem

Agent markdown files (`agents/*.md`) currently serve three roles:

1. **Operational metadata** — tool permissions, max turns, timeouts (YAML frontmatter)
2. **Boilerplate context injection** — `{{PIPELINE_CONTEXT}}`, `{{TASK_CONTENT}}`, `{{PREVIOUS_OUTPUT}}`, `{{REPO_CONTEXT}}`, `{{OUTPUT_PATH}}`, `{{STAGE_LIST}}` placeholders repeated identically across every file
3. **Agent-specific prompt instructions** — the unique behavioral rules for each agent

This creates problems:

- **Three-layer ambiguity** for tool permissions: `shkmn.config.json` vs frontmatter vs hardcoded fallback. Unclear which value wins.
- **Redundant metadata**: `max_turns` and `timeout_minutes` in frontmatter duplicate values already in `defaults.ts` (which always override them via the resolution chain).
- **Dead data**: the `description` field in frontmatter is loaded by `loadAgentConfig` but never consumed by any code path.
- **Boilerplate noise**: 30-40% of each MD file is identical template variable sections that obscure the actual prompt instructions.
- **Template variable coupling**: adding a new context variable requires editing every agent MD file.

## 2. Solution

Strip agent MD files down to **pure prompt instructions** — no YAML frontmatter, no template variable placeholders. Move all operational metadata into TypeScript code. Have `buildSystemPrompt` compose the full prompt by wrapping agent instructions with standard context sections.

### 2.1 What Agent MD Files Become

Each file in `agents/` becomes a plain markdown document containing only the agent-specific instructions, self-validation rules, and output format. No `---` frontmatter fences. No `{{VARIABLE}}` placeholders.

Example — `agents/questions.md` goes from:

```markdown
---
stage: questions
description: Asks targeted technical questions...
tools:
  allowed: [Read, Glob, Grep, Bash, WebSearch, WebFetch]
  disallowed: [Write, Edit]
max_turns: 30
timeout_minutes: 20
---

# Identity

You are {{AGENT_NAME}}, the questions agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Repo Context

{{REPO_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Instructions
...
```

To:

```markdown
Your questions will be handed to the research agent, who will investigate
them. Your questions are the ONLY input the research agent receives
alongside the original task.

## Instructions
...

## Self-Validation
...

## Output Format
...
```

### 2.2 Where Operational Metadata Lives

All operational parameters consolidate into `defaults.ts`, following the existing pattern for `maxTurns` and `timeoutsMinutes`:

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

The tool override chain simplifies from three layers to two:

```
config.agents.tools[stage]  →  DEFAULT_STAGE_TOOLS[stage]  →  read-only fallback
```

### 2.3 How `buildSystemPrompt` Composes Prompts

Instead of hydrating `{{VARIABLE}}` placeholders inside the MD file, `buildSystemPrompt` assembles the full prompt from sections. Stage-specific context rules determine which sections each agent receives:

#### Stage Context Rules

| Stage | Gets task content? | Previous output label | Gets repo context? |
|---|---|---|---|
| questions | Yes | *(none — first stage)* | Yes |
| research | **No** (QRSPI blind) | Questions to Investigate | Yes |
| design | Yes | Research Findings | Yes |
| structure | No | Design Document | No |
| plan | No | Implementation Slices | Yes |
| impl | Yes | Implementation Plan | Yes |
| validate | No | Implementation Output | Yes |
| review | Yes | Validation Report | Yes |
| pr | Yes | Review Output | No |
| classify | Yes | *(none)* | No |

These rules are encoded as a data structure in code:

```typescript
export const STAGE_CONTEXT_RULES: Record<string, {
  includeTaskContent: boolean;
  previousOutputLabel: string | null;  // null = omit section
  includeRepoContext: boolean;
}> = {
  questions: { includeTaskContent: true,  previousOutputLabel: null, includeRepoContext: true },
  research:  { includeTaskContent: false, previousOutputLabel: "Questions to Investigate", includeRepoContext: true },
  design:    { includeTaskContent: true,  previousOutputLabel: "Research Findings", includeRepoContext: true },
  structure: { includeTaskContent: false, previousOutputLabel: "Design Document", includeRepoContext: false },
  plan:      { includeTaskContent: false, previousOutputLabel: "Implementation Slices", includeRepoContext: true },
  impl:      { includeTaskContent: true,  previousOutputLabel: "Implementation Plan", includeRepoContext: true },
  validate:  { includeTaskContent: false, previousOutputLabel: "Implementation Output", includeRepoContext: true },
  review:    { includeTaskContent: true,  previousOutputLabel: "Validation Report", includeRepoContext: true },
  pr:        { includeTaskContent: true,  previousOutputLabel: "Review Output", includeRepoContext: false },
  classify:  { includeTaskContent: true,  previousOutputLabel: null, includeRepoContext: false },
};
```

#### Composed Prompt Structure

```
# Identity

You are {agentName}, the {stage} agent in the ShaktimaanAI pipeline.

## Pipeline Context

Pipeline: ShaktimaanAI | Task: {slug} | Stage: {stage}
Stage sequence for this task: {stageList}

## Task                              ← omitted when includeTaskContent = false

{taskContent}

## {previousOutputLabel}             ← omitted when previousOutputLabel = null

{previousOutput}

## Repo Context                      ← omitted when includeRepoContext = false

{repoContext}

---

{agent MD file content}              ← pure instructions from agents/{stage}.md

---

Write your output to: {outputPath}
```

### 2.4 Why Research Doesn't See the Task

The QRSPI methodology deliberately hides the task description from the research agent to prevent confirmation bias. The research agent receives only the questions generated by the questions agent. This is enforced by `includeTaskContent: false` in the context rules — a code-level guarantee that cannot be accidentally broken by editing a markdown file.

## 3. Code Changes

### 3.1 Files Modified

| File | Change |
|---|---|
| `src/config/defaults.ts` | Add `DEFAULT_STAGE_TOOLS` map. Add `STAGE_CONTEXT_RULES` structure. |
| `src/core/agent-runner.ts` | Rewrite `buildSystemPrompt` to compose prompts from sections + MD body. Update `resolveToolPermissions` to use `DEFAULT_STAGE_TOOLS` instead of agent config tools. Remove `loadAgentConfig` usage for tools/turns. Add `loadAgentPrompt(agentsDir, stage): string` — simple file read. |
| `src/core/agent-config.ts` | Remove `parseFrontmatter`, `loadAgentConfig`, `AgentConfig` interface. Replace with `loadAgentPrompt(agentsDir, stage): string` that reads `{agentsDir}/{stage}.md` and returns raw content. |
| `src/core/template.ts` | Remove `hydrateTemplate` — no longer needed for agent prompts. |
| `agents/*.md` (all 11 files) | Rewrite as pure prompt instructions — no frontmatter, no variable placeholders. |

### 3.2 Files Removed

| File | Reason |
|---|---|
| `src/core/template.ts` | `hydrateTemplate` was only used for agent prompt variable injection. With code-composed prompts, it's unused. |

### 3.3 Test Impact

| Test File | Change |
|---|---|
| `tests/core/agent-config.test.ts` | Remove all frontmatter parsing tests. Replace with simple `loadAgentPrompt` tests (file exists → returns content, file missing → throws). |
| `tests/core/agent-runner.test.ts` | Update `buildSystemPrompt` tests to verify composed prompt structure (identity block, conditional sections, agent instructions body). Update `resolveToolPermissions` tests to use `DEFAULT_STAGE_TOOLS`. |
| `tests/core/template.test.ts` | Remove entirely — `hydrateTemplate` is deleted. |
| New: stage context rules tests | Verify each stage gets correct sections (research has no task, structure has no repo context, etc.). |

## 4. Extensibility: Adding a New Agent

To add a custom stage (e.g., "security-audit"):

1. Create `agents/security-audit.md` with the agent's instructions (pure markdown, no frontmatter)
2. Add the stage's tool permissions to `DEFAULT_STAGE_TOOLS` in `defaults.ts`
3. Add the stage's context rules to `STAGE_CONTEXT_RULES` in `defaults.ts`
4. Add `maxTurns` and `timeoutsMinutes` entries for the stage in `DEFAULT_CONFIG`
5. Register the stage in the pipeline's stage map

This is three touch points in `defaults.ts` (tools, context rules, turns/timeouts) plus one MD file. All operational configuration lives in one place.

## 5. Spec Updates Required

The following existing spec documents reference the old agent MD format and must be updated:

| Document | What to Update |
|---|---|
| `docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md` | Section 13.2: update package structure (remove `src/templates/`, reflect `agents/` as prompt-only files). Section 17: update template format to describe code-composed prompts and the new extensibility steps. |
| `docs/superpowers/specs/2026-04-04-spec2b-alignment-agents-design.md` | Remove agent config via markdown frontmatter section. Remove template variable enhancement section. Update agent runner flow to reflect code composition. |
| `docs/superpowers/specs/2026-04-04-spec2c-execution-agents-design.md` | Update references to agent MD file format and template variables. |

## 6. What Does NOT Change

- The pipeline engine, stage transitions, retry logic, and review gates are untouched
- The `agents/` directory location and filename convention (`{stage}.md`) stay the same
- The config override chain for tools via `shkmn.config.json` (`config.agents.tools[stage]`) stays the same
- The `maxTurns` and `timeoutsMinutes` config resolution stays the same (config → default)
- The shipped `agents/` directory is still copied to `dist/agents` during build
- The `resolveAgentsDir` function continues to support config-level `agentsDir` override
