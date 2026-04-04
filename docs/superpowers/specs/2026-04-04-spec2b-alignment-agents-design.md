# Spec 2b: Alignment Agents — Design Document

> **Note (Spec 2d):** The agent config via markdown frontmatter system described in this document has been superseded by Spec 2d (Agent Prompt Simplification). Agent MD files are now pure prompt instructions with no YAML frontmatter. Operational metadata (tool permissions, max turns, timeouts) lives in `src/config/defaults.ts`. Template variables (`{{VARIABLE}}` placeholders) have been replaced by code-composed prompts in `buildSystemPrompt`. See `docs/superpowers/specs/2026-04-04-spec2d-agent-prompt-simplification-design.md` for the current design.

**Goal:** Replace the 5 stub alignment agent prompts with production-quality prompts, introduce agent configuration via markdown files, add repo context gathering, and update tool permissions — making the Questions → Research → Design → Structure → Plan pipeline functional for real coding tasks.

**Depends on:** Spec 2a (Pipeline Infrastructure) — completed.

---

## Naming Rule

All code, filenames, agent config files, documentation, and identifiers use descriptive English names. Mythological display names (configured in `shkmn.config.json` → `agents.names`) exist in exactly ONE place — the user's config file. They are never hardcoded in source code, agent markdown files, comments, specs, or tests. The `{{AGENT_NAME}}` template variable resolves the display name from config at runtime.

---

## Architecture Overview

Spec 2a built the runtime backbone: pipeline engine, agent runner (Claude Agent SDK), template hydrator, stage-map, registry, crash recovery. It created stub prompt templates in `src/templates/prompt-*.md` with basic instructions.

Spec 2b makes three changes:

1. **Agent config via markdown** — Each agent is defined by a markdown file in `agents/` with YAML frontmatter (tools, timeouts, turns) and a markdown body (the full prompt template). Replaces `src/templates/prompt-*.md` and the hardcoded `STAGE_TOOL_MAP`.

2. **Repo context gathering** — A tiered strategy that reads the target repo's convention files, config signals, and structure to inject as `{{REPO_CONTEXT}}` into agent prompts. Agents adapt to the repo without hardcoding stack assumptions.

3. **Production prompts for alignment agents** — Full behavioral instructions, investigation strategies, output format specifications, and self-validation checklists for all 5 alignment stages.

---

## 1. Agent Configuration via Markdown

### File Structure

```
agents/
├── questions.md         ← Questions agent (alignment)
├── research.md          ← Research agent (alignment)
├── design.md            ← Design agent (alignment)
├── structure.md         ← Structure agent (alignment)
├── plan.md              ← Plan agent (alignment)
├── impl.md              ← Impl agent (stub — Spec 2c)
├── validate.md          ← Validate agent (stub — Spec 2c)
├── review.md            ← Review agent (stub — Spec 2c)
├── pr.md                ← PR agent (stub — Spec 2c)
├── classify.md          ← Intent classifier (moved from src/templates/)
└── agent-template.md    ← Blank starter for new agents
```

### File Format

YAML frontmatter for machine-readable config. Markdown body for the prompt template.

```markdown
---
stage: questions
description: Asks targeted technical questions to prevent wrong assumptions
tools:
  allowed: [Read, Glob, Grep, Bash, WebSearch, WebFetch]
  disallowed: [Write, Edit]
max_turns: 30
timeout_minutes: 20
---

# Identity

You are {{AGENT_NAME}}, the questions agent in the ShaktimaanAI pipeline.

# Instructions
...
```

- No `name:` field in frontmatter — display names come only from `shkmn.config.json`.
- The markdown body is hydrated via `hydrateTemplate()` with all template variables before being sent to the Agent SDK.

### Agent Config Loader

New module: `src/core/agent-config.ts`

```typescript
interface AgentConfig {
  stage: string;
  description: string;
  tools: {
    allowed: string[];
    disallowed: string[];
  };
  maxTurns?: number;
  timeoutMinutes?: number;
  promptTemplate: string;  // markdown body after frontmatter
}

function loadAgentConfig(agentDir: string, stage: string): AgentConfig
```

Reads `{agentDir}/{stage}.md`, parses YAML frontmatter, returns config + prompt body.

### Override Precedence

```
shkmn.config.json (highest — user's explicit overrides)
  → agents/ in runtime directory (user's local customizations)
    → agents/ shipped with npm package (defaults)
      → hardcoded fallbacks (lowest)
```

For tools, maxTurns, timeoutMinutes:
```
config.agents.maxTurns[stage]  ??  agentConfig.maxTurns  ??  30
config.agents.timeoutsMinutes[stage]  ??  agentConfig.timeoutMinutes  ??  30
```

---

## 2. Repo Context Gathering

New module: `src/core/repo-context.ts`

### Function

`gatherRepoContext(repoPath: string): string`

### Tiered Strategy

| Tier | Source | What it provides |
|---|---|---|
| **1: Explicit convention files** | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CONVENTIONS.md`, `.editorconfig`, `.cursorrules`, `.github/copilot-instructions.md` | Direct statements of rules, patterns, stack info |
| **2: Implicit convention signals** | `package.json` / `*.csproj` / `Cargo.toml` (deps & scripts), `tsconfig.json` / `Directory.Build.props` (compiler), `.eslintrc*` / `.prettierrc*` (style), `Dockerfile` / `docker-compose.yml` (runtime) | Stack, toolchain, linting rules, build commands |
| **3: Repo scan fallback** | Directory tree (top 3 levels), recent commit messages (last 15), `README.md` | Inferred structure, naming conventions, project purpose |

**Behavior:**
- Tiers 1 and 2 always run, accumulating findings.
- Tier 3 runs only if Tiers 1 + 2 produced less than ~200 words.
- Tier 1 content included verbatim (with heading per file).
- Tier 2 content summarized — extract relevant fields, not raw file dumps.
- Output capped at ~2000 words to avoid bloating system prompts.
- If no repo path provided, returns `"(no repo context available)"`.

### Output Format

```markdown
## Repo Context: {repo-name}

### Convention Files
{Tier 1 content — verbatim, one heading per file}

### Stack & Tooling
{Tier 2 summaries — extracted relevant fields}

### Project Structure
{Tier 3 — directory tree, recent commits, README excerpt — only if needed}
```

---

## 3. Template Variable Enhancement

### Updated Variable List

| Variable | Source | New? |
|---|---|---|
| `{{AGENT_NAME}}` | `config.agents.names[stage] ?? stage` | No |
| `{{AGENT_ROLE}}` | stage name | No |
| `{{TASK_CONTENT}}` | task file content | No |
| `{{PREVIOUS_OUTPUT}}` | accumulated artifacts from prior stages | No |
| `{{OUTPUT_PATH}}` | target output file path | No |
| `{{PIPELINE_CONTEXT}}` | pipeline + task + stage summary | No |
| `{{REPO_CONTEXT}}` | `gatherRepoContext()` output | **Yes** |
| `{{REPO_PATH}}` | repo path from task meta | **Yes** |
| `{{STAGE_LIST}}` | comma-separated stages for this task | **Yes** |

---

## 4. Tool Permissions

Defined in each agent's markdown frontmatter. Overridable by user config.

| Stage | Allowed Tools | Rationale |
|---|---|---|
| **questions** | Read, Glob, Grep, Bash, WebSearch, WebFetch | Full codebase access + web to ask deeply targeted questions |
| **research** | Read, Glob, Grep, Bash, WebSearch, WebFetch, mcp__claude_ai_Slack__*, mcp__plugin_notion_notion__* | Full investigation: codebase, web, Slack history, Notion docs |
| **design** | Read, Glob, Grep, Bash | Codebase access to verify research findings against actual code |
| **structure** | Read, Glob, Grep | Works from accumulated artifacts, read-only codebase reference |
| **plan** | Read, Glob, Grep | Works from accumulated artifacts, read-only codebase reference |
| **impl** | Read, Write, Edit, Bash, Glob, Grep | Full access (stub — Spec 2c) |
| **validate** | Read, Bash, Glob, Grep | Run builds/tests, no writes |
| **review** | Read, Glob, Grep | Read-only code review |
| **pr** | Bash | Push + create PR via CLI |

---

## 5. Alignment Agent Prompts

All prompts follow this structure:
- **Identity** — role description using `{{AGENT_NAME}}` and English role name
- **Repo context** — `{{REPO_CONTEXT}}` injection
- **Inputs** — `{{TASK_CONTENT}}` and/or `{{PREVIOUS_OUTPUT}}`
- **Instructions** — stage-specific behavioral rules
- **Self-validation checklist** — verify output quality before finishing
- **Output format** — required structure for the output

### 5A: Questions Agent

**Purpose:** Generate targeted technical questions that prevent wrong assumptions before implementation. Questions are the ONLY input the research agent receives alongside the task.

**Behavioral instructions:**
- Before generating questions, scan the repo: directory structure, relevant files, existing patterns in the area the task touches.
- Generate informed questions based on actual codebase state, not naive assumptions.

**Required question categories (at least one per category):**
- Existing patterns — how does the codebase currently handle similar things?
- Integration points — what existing code will this touch or depend on?
- Constraints — what rules, conventions, or limitations apply?
- Ambiguity — what's underspecified that could lead to wrong implementation?
- Risk — what could break? Edge cases?
- Dependencies — external libraries, APIs, services involved?

**Self-validation:**
- At least one question per category
- Questions are specific enough for concrete investigation
- No questions already answered by the codebase scan

**Output format:** Categorized markdown list, one question per line with `-` prefix.

### 5B: Research Agent

**Purpose:** Factual investigation. Answer every question with evidence from codebase, web, Slack, and Notion. Does NOT design solutions — gathers evidence only.

**Behavioral instructions:**
- For each question: search codebase first (Grep, Glob, Read), then git history, then web, then Slack/Notion.
- Every finding must cite a source: file path + line number, URL, Slack message, or Notion page.
- Report conflicting evidence explicitly — don't pick a side.
- If a question can't be answered, state "NOT FOUND" with what was searched.

**Self-validation:**
- Every question addressed
- Every answer has a citation
- Unanswered questions flagged clearly

**Output format:** Numbered list matching input questions. Each answer: finding, evidence/citation, confidence (high/medium/low).

### 5C: Design Agent

**Purpose:** Produce architectural design. Dual-track — one design faithful to the task, one adapted if research suggests a better approach.

**Behavioral instructions:**
- Synthesize research findings into a "What we know" summary.
- Produce **Design A: As Requested** — faithful to the task description.
- Evaluate: does research suggest a materially better approach?
- If yes, produce **Design B: Adapted** with explanation of divergence.
- If no, state "No divergence — Design A is aligned with research findings."

**Required sections per design:**
- Overview (what and why)
- Components to create/modify (with file paths)
- Interfaces and data structures (with types)
- Module interactions (call flow)
- Error handling strategy
- Testing strategy

**Self-validation:**
- File paths verified against codebase
- Interfaces match existing patterns from research
- Contradictions between Design A and B explained

**Output format:** Structured markdown with clear Design A / Design B separation.

### 5D: Structure Agent

**Purpose:** Decompose the chosen design into vertical implementation slices.

**Behavioral instructions:**
- Each slice must be independently buildable and testable.
- Prefer vertical slices (thin end-to-end) over horizontal layers.
- Order so no slice depends on a later one.
- No slice should exceed a single focused session (~30-60 min of agent time).
- If both Design A and B exist, decompose BOTH — the review gate will pick.

**Per-slice fields:**
- Slice ID (S1, S2, ...)
- Name
- Files to create/modify
- Acceptance criteria (specific, testable)
- Dependencies on prior slices
- Estimated complexity (small/medium/large)

**Self-validation:**
- Each slice independently testable
- Dependency graph is acyclic
- Sum of slices covers full design
- Acceptance criteria specific enough to automate

**Output format:** Structured markdown, one section per slice.

### 5E: Plan Agent

**Purpose:** Tactical step-by-step execution plan per slice, detailed enough for a coding agent to follow without re-reading earlier artifacts.

**Behavioral instructions:**
- For each slice, produce ordered steps.
- Each step: exact file path, action (create/modify/delete), function signatures with types.
- TDD sequence per step: write failing test → write minimal code to pass → refactor.
- Reference existing code patterns from research (cite file paths).
- Specify build/test commands per slice.
- Include rollback strategy if a slice fails midway.

**Self-validation:**
- Every slice has a TDD sequence
- All file paths verified
- Steps reference actual existing functions/types from research
- Plan executable without referring back to design doc

**Output format:** Structured markdown, grouped by slice, steps numbered.

---

## 6. Changes to Agent Runner

### Current Flow
1. `buildSystemPrompt()` → loads template from `src/templates/`, hydrates with 6 variables
2. `getStageTools()` → returns tools from hardcoded `STAGE_TOOL_MAP`
3. `runAgent()` → calls Agent SDK

### New Flow
1. `loadAgentConfig()` → reads `agents/{stage}.md`, gets prompt template + tool config
2. `gatherRepoContext()` → reads target repo conventions (tiered strategy)
3. `buildSystemPrompt()` → hydrates prompt template with 9 variables
4. `runAgent()` → calls Agent SDK using tools from agent config (merged with user config overrides)

### Tool Resolution
```
1. Load tools from agent config frontmatter
2. Check user config overrides (shkmn.config.json agents.tools.{stage})
3. User config wins if present, else agent config
4. Fallback: read-only [Read, Glob, Grep]
```

### Timeout/Turns Resolution
```
config.agents.maxTurns[stage]  ??  agentConfig.maxTurns  ??  30
config.agents.timeoutsMinutes[stage]  ??  agentConfig.timeoutMinutes  ??  30
```

---

## 7. File Change Summary

### New Files

| File | Purpose |
|---|---|
| `src/core/agent-config.ts` | YAML frontmatter parser + agent config loader |
| `src/core/repo-context.ts` | Tiered repo context gatherer |
| `agents/questions.md` | Questions agent — full prompt + config |
| `agents/research.md` | Research agent — full prompt + config |
| `agents/design.md` | Design agent — full prompt + config |
| `agents/structure.md` | Structure agent — full prompt + config |
| `agents/plan.md` | Plan agent — full prompt + config |
| `agents/impl.md` | Impl agent — stub (Spec 2c) |
| `agents/validate.md` | Validate agent — stub (Spec 2c) |
| `agents/review.md` | Review agent — stub (Spec 2c) |
| `agents/pr.md` | PR agent — stub (Spec 2c) |
| `agents/classify.md` | Intent classifier — moved from src/templates/ |
| `agents/agent-template.md` | Blank starter template for creating new agents |

### Modified Files

| File | What Changes |
|---|---|
| `src/core/agent-runner.ts` | Remove `STAGE_TOOL_MAP`, `getStageTools()`. Use `loadAgentConfig()`. Call `gatherRepoContext()`. Add 3 new template variables. Merge config overrides for tools/turns/timeout. |
| `src/core/template.ts` | Remove `loadTemplate()`. Keep `hydrateTemplate()`. |
| `src/task/parser.ts` | Verify `repo` field exposed in `TaskMeta` |
| `src/config/defaults.ts` | Add `agents/` directory path. Add `agents.tools` config section. |

### Moved + Rewritten

| Old Location | New Location | Nature of Change |
|---|---|---|
| `src/templates/prompt-questions.md` | `agents/questions.md` | Format (frontmatter added) + content rewrite |
| `src/templates/prompt-research.md` | `agents/research.md` | Format + content rewrite |
| `src/templates/prompt-design.md` | `agents/design.md` | Format + content rewrite |
| `src/templates/prompt-structure.md` | `agents/structure.md` | Format + content rewrite |
| `src/templates/prompt-plan.md` | `agents/plan.md` | Format + content rewrite |
| `src/templates/prompt-impl.md` | `agents/impl.md` | Format change only (stub — Spec 2c) |
| `src/templates/prompt-validate.md` | `agents/validate.md` | Format change only (stub) |
| `src/templates/prompt-review.md` | `agents/review.md` | Format change only (stub) |
| `src/templates/prompt-classify.md` | `agents/classify.md` | Format change only (content preserved) |
| `src/templates/agent-template.md` | `agents/agent-template.md` | Updated to new frontmatter format |

### Removed

| Directory | Reason |
|---|---|
| `src/templates/` | All contents migrated to `agents/`. Directory removed. |

---

## 8. What Is NOT In Scope

- Execution agents (impl, validate, review, PR) — Spec 2c
- Slack/Notion/CLI input surfaces — Spec 3
- Dashboard — Spec 4
- No new npm dependencies required
- Pipeline engine, registry, logger, crash recovery — unchanged from Spec 2a
