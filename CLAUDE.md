# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm run build          # tsup build + copy agents/*.md to dist/agents/
npm run dev            # tsup --watch (dev mode)
npm test               # vitest run (all tests)
npm run test:watch     # vitest in watch mode
npx vitest run tests/core/pipeline.test.ts          # single test file
npx vitest run -t "describes the test name"         # single test by name
```

- Entry point: `src/cli.ts` → bundled to `dist/cli.js` (ESM, node20 target)
- CLI binary: `shkmn` (defined in package.json `bin`)
- Tests live in `tests/` mirroring `src/` structure; Vitest with globals enabled, 30s test timeout, 60s hook timeout

## Architecture

ShaktimaanAI is a deterministic TypeScript orchestrator that routes tasks through a 9-stage pipeline, delegating each stage to a Claude Agent SDK agent. The orchestrator handles all routing, state, and file management — LLMs only run inside agent stages.

### Pipeline Stages (two phases)

**Alignment (QRSPI)** — read-only, no Write/Edit tools:
`questions → research → design → structure → plan`

**Execution (TDD)** — impl has write access:
`impl ↔ validate → review → pr`

The `impl → validate → review` loop retries on failure. The pipeline auto-pauses after a configurable review gate (default: `design`) for human approval before execution begins.

### Directory-Based State Machine

Each task moves through numbered directories as it progresses:
`00-inbox → 01-questions/pending → 01-questions/done → ... → 10-complete | 11-failed | 12-hold`

`RunState` (JSON) tracks: `currentStage`, `status`, `completedStages`, `reviewIssues`. Recovery on restart scans `pending/` dirs to resume interrupted tasks.

### Key Source Modules

- **`src/core/pipeline.ts`** — stage routing, state transitions, orchestration loop
- **`src/core/agent-runner.ts`** — executes agents via Claude Agent SDK
- **`src/core/registry.ts`** — tracks concurrent agents, enforces `maxConcurrentTotal`
- **`src/core/stage-map.ts`** — single source of truth for stage names ↔ directory mappings
- **`src/core/watcher.ts`** — Heimdall: monitors inbox for new tasks via chokidar
- **`src/core/worktree.ts`** — git worktree isolation per task (`shkmn/<task-slug>` branches)
- **`src/core/retry.ts`** — validate/review loop retry logic
- **`src/core/recovery.ts`** — crash recovery from folder state
- **`src/config/defaults.ts`** — agent names, per-stage tool permissions, stage context rules
- **`src/config/schema.ts`** — Zod schema for configuration
- **`src/commands/`** — CLI command handlers (commander.js)
- **`agents/`** — markdown prompt templates per stage (copied to dist/ on build)

### Per-Stage Tool Permissions

Defined in `src/config/defaults.ts` (`DEFAULT_STAGE_TOOLS`). Alignment stages disallow Write/Edit. Only `impl` and `quick` have full write access. The `pr` stage only has Bash (for git/gh commands). This matrix is critical — modifying it changes what agents can do.

### Stage Context Rules

Also in `defaults.ts` (`STAGE_CONTEXT_RULES`): controls what context each stage receives (task content, previous stage output, repo context). Stages chain by reading the previous stage's output artifact at `artifacts/{stage}-output.md`.

## Conventions

- **Agent names are mythological** (Gargi, Chitragupta, Vishwakarma, etc.) but these are display names only. All code, filenames, configs, and identifiers use English names.
- **Slug format**: `task-description-yyyyMMddHHmmss`
- **Config path**: `~/.shkmn/runtime/shkmn.config.json` (validated by Zod schema)
- **Windows EBUSY handling**: retry logic with exponential backoff exists for file operations
- **Agent prompts**: `agents/*.md` — each file is a self-contained prompt template loaded at runtime

## Pipeline Diagnostics

Run `/pipeline-diagnostics` to audit the pipeline runtime directory. The skill:
- Reads baselines from source code (stage-map, defaults, retry logic, types)
- Reads runtime config from `shkmn.config.json`
- Dispatches 4 parallel sub-agents with 34 checks across: Task Pipeline, Slack Agent, Astra/Quick, Infrastructure
- Produces a report at `{runtimeDir}/diagnostics/{timestamp}-diagnostic.md`
- Optionally accepts a task slug to focus the Task Pipeline analysis: `/pipeline-diagnostics <slug>`
