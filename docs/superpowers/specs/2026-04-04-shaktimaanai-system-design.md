# ShaktimaanAI — System Design Document

**Version:** 1.0
**Date:** 2026-04-04
**Author:** Pratyush Pande (with Claude)
**Status:** Approved

---

## 1. Overview

ShaktimaanAI is an agentic development pipeline that automates the software development lifecycle — from task intake through research, design, implementation, testing, review, and PR creation. It uses Claude's Agent SDK to run specialized LLM-powered agents, orchestrated by deterministic TypeScript code.

### Core Principles

- **Deterministic orchestration, intelligent agents** — routing, scheduling, lifecycle management, and state recovery are pure code. LLMs are used only for intent classification (ambiguous input) and within agents doing actual work.
- **Multi-surface, single handler** — every action (task creation, approval, status) has one canonical implementation. Multiple input surfaces (Slack, Dashboard, CLI) all funnel to that handler.
- **QRSPI methodology** — coding tasks follow a rigorous alignment-then-execution pipeline inspired by the QRSPI framework, preventing the "plan-reading illusion."
- **Test-driven development** — all code implementation follows red-green-refactor per vertical slice.
- **Cross-platform** — full TypeScript/Node.js stack. No OS-specific dependencies.
- **Installable product** — distributed via npm. Users install it; contributors clone it.

---

## 2. Product Identity

| Attribute | Value |
|---|---|
| Full name | ShaktimaanAI |
| npm package | `shaktimaanai` |
| CLI alias | `shkmn` |
| Repo | `ShaktimaanAI` (this repo) |
| Dashboard template repo | `shaktimaanai-dashboard` |

---

## 3. Architecture

```
                    ┌─────────────────────────────────────────┐
                    │          INPUT SURFACES                   │
                    │  Slack  |  Dashboard UI  |  shkmn CLI    │
                    └────┬─────────┬──────────────┬────────────┘
                         │         │              │
                         ▼         ▼              ▼
                    ┌─────────────────────────────────────────┐
                    │  SUTRADHAAR (Intent Classifier)          │
                    │  Keywords first, LLM for ambiguous input │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │  BRAHMA (Canonical Task Creator)          │
                    │  Parse → Validate → Slug → .task file    │
                    └────────────────┬────────────────────────┘
                                     │
                         ┌───────────▼───────────┐
                         │  HEIMDALL (Watcher)    │
                         │  watches inbox dir     │
                         └───────────┬───────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │         PIPELINE ENGINE                   │
                    │  Route → Spawn agent → Track lifecycle   │
                    │  Concurrency cap | Agent registry         │
                    └──┬────┬────┬────┬────┬─────────────────┘
                       │    │    │    │    │
                       ▼    ▼    ▼    ▼    ▼
                    ALIGNMENT AGENTS    EXECUTION AGENTS
                    (Narada, Chitragupta,  (Hanuman, Karigar,
                     Vishwakarma, Vastu,    Dharma, Drona,
                     Chanakya)              Garuda)
                       │                        │
                       │    ┌───────────┐       │
                       │    │  INDRA    │       │
                       │    │ (Approval │       │
                       │    │  Handler) │       │
                       │    └───────────┘       │
                       │                        │
              ┌────────▼────────────────────────▼─────────┐
              │              DATA LAYER                     │
              │  status.json | history.json | config.json   │
              └────────┬──────────────────────────────────┘
                       │  git push
              ┌────────▼──────────────────────────────────┐
              │     DASHBOARD REPO (per-user)               │
              │  GitHub Action → rebuild → GitHub Pages     │
              └───────────────────────────────────────────┘

              ┌───────────────────────────────────────────┐
              │     SCHEDULED TASKS (node-cron)             │
              │  Daily rollup | Notion push | Monthly rpt   │
              └───────────────────────────────────────────┘
```

### 3.1 Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript (full stack) |
| Runtime | Node.js |
| Agent SDK | Claude Agent SDK (@anthropic-ai/claude-code) |
| File watching | chokidar |
| Scheduling | node-cron |
| GitHub | `gh` CLI via child_process |
| Azure DevOps | `az boards` / `az devops` CLI via child_process |
| Slack | Slack MCP (already integrated) |
| Notion | Notion MCP (already integrated) |
| Distribution | npm package |
| Dashboard hosting | GitHub Pages (static) |
| Dashboard CI | GitHub Actions |
| Impl isolation | Git worktrees |

### 3.2 Repo Separation

| Repo | Purpose | Who uses it |
|---|---|---|
| `ShaktimaanAI` | Product source — scripts, agents, templates, CLI | Contributors only |
| `shaktimaanai-dashboard` | GitHub template repo for per-user dashboards | Created per-user during `shkmn init` |
| Local runtime directory | Tasks, logs, secrets, agent registry | Never committed |

---

## 4. Agent Roster

### 4.1 Infrastructure Agents

| Name | Role | Type | Description |
|---|---|---|---|
| **Heimdall** | Watcher | Deterministic | Persistent process. Watches inbox directory via chokidar, dispatches pipeline runs. |
| **Sutradhaar** | Intent Classifier | Hybrid | Keyword matching for known patterns, LLM for ambiguous freeform input. Structured JSON output with intent + confidence. |
| **Brahma** | Task Creator | Deterministic | Canonical handler for task creation from all surfaces. Parses, validates, generates slug, writes `.task` file. |
| **Indra** | Approval Handler | Deterministic | Canonical handler for approvals from all surfaces. Writes approval to task, resumes paused pipeline run. |

### 4.2 Alignment Agents (QRSPI)

| Name | Role | Type | Input | Output |
|---|---|---|---|---|
| **Narada** | Questions | LLM | Task description | Targeted technical questions |
| **Chitragupta** | Research | LLM | Questions only (task hidden) | Factual codebase map |
| **Vishwakarma** | Design | LLM | Research + task revealed | Architectural design doc. **Review gate.** |
| **Vastu** | Structure | LLM | Validated design | Vertical slices + implementation phases |
| **Chanakya** | Plan | LLM | Structure | Tactical implementation plan per slice |

### 4.3 Execution Agents

| Name | Role | Type | Description |
|---|---|---|---|
| **Hanuman** | Work Tree | Deterministic | Organizes slices from Vastu into executable task hierarchy |
| **Karigar** | Impl | LLM | Writes code (tests first in TDD). Runs in git worktree. Parallel across tasks. |
| **Dharma** | Validate | LLM | Discovers and runs build/test commands per repo. Sequential queue for build-constrained repos. |
| **Drona** | Review | LLM | Reviews code quality. If issues found, loops back to Karigar + Dharma. |
| **Garuda** | PR | Deterministic | Pushes branch, creates PR via `gh`, links ADO item via `az`. Only runs after Drona passes. |

---

## 5. Pipeline Stages

### 5.1 Coding Tasks (full QRSPI + TDD)

```
ALIGNMENT:
  Narada (Questions)
    → Chitragupta (Research) [task hidden]
      → Vishwakarma (Design) [task revealed, REVIEW GATE]
        → Vastu (Structure) [vertical slices]
          → Chanakya (Plan) [tactical details]

EXECUTION:
  Hanuman (Work Tree)
    → Per slice:
        Karigar (Impl: write tests) → Dharma (Validate: red)
        → Karigar (Impl: write code) → Dharma (Validate: green)
        → Karigar (Impl: refactor) → Dharma (Validate: confirm)
    → Full test suite run
    → Drona (Review) ↔ Karigar + Dharma (fix loop, max N cycles)
    → Garuda (PR: push, create PR, link ADO)
```

### 5.2 Non-Coding Tasks

Subset of stages. Examples:
- Research-only: `Narada → Chitragupta`
- Doc task: `Narada → Chitragupta → Vishwakarma`
- Research + spec: `Narada → Chitragupta → Vishwakarma → Vastu → Chanakya`

### 5.3 Stage Configuration

Per-task, specified in the `.task` file:
```
## Pipeline Config
stages: questions, research, design, structure, plan, impl, validate, review, pr
review_after: design
```

### 5.4 Review Gates

Configurable via `review_after` field. When a review gate is hit:
1. Pipeline run pauses
2. Task moves to `12-hold/` directory
3. Notification sent via all surfaces (Slack thread, dashboard status)
4. Indra (Approval Handler) waits for approval from any surface
5. On approval, pipeline run resumes from next stage

---

## 6. TDD Per Vertical Slice

Each slice from Vastu/Chanakya goes through a red-green-refactor cycle:

```
Slice lifecycle:
  pending → writing_tests → red → writing_impl → green → refactoring → done

Per slice artifact directory:
  03-impl/active/{slug}/slice-{nn}/
    ├── slice-spec.md         ← from Chanakya
    ├── tests-written.md      ← Karigar output (red phase)
    ├── impl-written.md       ← Karigar output (green phase)
    └── validate-results.md   ← Dharma output (each run)
```

- **Red phase**: Karigar writes tests only. Dharma confirms they compile but fail.
- **Green phase**: Karigar writes minimal code to pass. Dharma confirms tests pass.
- **Refactor phase**: Karigar improves code. Dharma confirms tests still pass.
- **Full suite**: After all slices, Dharma runs the complete test suite once before Drona reviews.

---

## 7. Concurrency Model

```json
{
  "agents": {
    "max_concurrent_total": 3,
    "max_concurrent_validate": 1
  }
}
```

- Multiple pipeline runs can be active simultaneously (up to `max_concurrent_total`)
- Karigar (impl) agents run in parallel — different worktrees, no conflicts
- Dharma (validate) respects per-repo build constraints — repos flagged `sequential_build: true` share a sequential queue
- Repos without build constraints can validate in parallel

---

## 8. Crash Recovery

The folder structure IS the state. No in-memory state is required for recovery.

**On startup (`shkmn start`):**

| Directory scanned | State inferred | Action |
|---|---|---|
| `00-inbox/*.task` | New task | Start pipeline run |
| `01-questions/pending/` | Mid-questions | Re-run Narada |
| `02-research/pending/` | Mid-research | Re-run Chitragupta |
| `03-design/pending/` | Mid-design | Re-run Vishwakarma |
| `04-structure/pending/` | Mid-structure | Re-run Vastu |
| `05-plan/pending/` | Mid-plan | Re-run Chanakya |
| `06-impl/pending/` | Mid-impl | Clean stale worktree, re-run Karigar |
| `06-impl/active/` | Mid-TDD slice | Resume from current slice phase |
| `07-validate/pending/` | Mid-validate | Re-run Dharma |
| `08-review/pending/` | Mid-review | Re-run Drona |
| `09-pr/pending/` | Mid-PR | Re-run Garuda |
| `{NN}-*/done/` (any stage) | Stage complete, not moved | Resume from next stage |
| `12-hold/` | Awaiting approval | Re-register watch, wait |
| `10-complete/` | Done | No action |
| `11-failed/` | Failed | No action |

**Rule: move-then-act.** Task file moves to `pending/` before agent starts. If agent crashes, file stays in `pending/` and gets re-run on restart.

---

## 9. Input & Approval Architecture

### 9.1 Task Creation (Brahma)

All surfaces converge to one function:

```
createTask(input: {
  source: 'slack' | 'dashboard' | 'cli',
  content: string,          // natural language or structured
  repo?: string,            // repo alias or path
  adoItem?: string,         // existing ADO work item ID
  slackThread?: string,     // for Slack-originated tasks
  stages?: string[],        // override default stages
  reviewAfter?: string      // override default review gate
}) → .task file in 00-inbox/
```

### 9.2 Approval (Indra)

All surfaces converge to one function:

```
approveTask(input: {
  source: 'slack' | 'dashboard' | 'cli',
  taskSlug: string,
  feedback?: string         // optional reviewer comments
}) → writes approval, resumes pipeline
```

---

## 10. Dashboard

- **Hosting**: GitHub Pages (static site, per-user repo from template)
- **Build**: GitHub Actions triggered on data file push (dalakotilaw pattern)
- **Auto-commit**: `[skip ci]` to prevent infinite loops
- **Data files**: `status.json`, `history.json`, `week-so-far.json`
- **Views**: Kanban board, list view, detail panel, task submission form, approve button
- **Update mechanism**: Orchestrator pushes JSON to dashboard repo via git commit + push

---

## 11. Scheduled Tasks

Managed by node-cron within the Heimdall process (not OS-level schedulers):

| Task | Schedule | What it does |
|---|---|---|
| Daily rollup | 11:55 PM | Aggregates day's work, writes daily log, regenerates week-so-far.json |
| Notion push | Friday 6 PM | Pushes weekly summary to Notion |
| Monthly report | 1st of month 8 AM | Generates prior month's report |

---

## 12. Config System

Two layers:

| File | Location | Contents | Committed? |
|---|---|---|---|
| `shkmn.config.json` | Runtime directory | All non-secret settings (paths, repos, schedules, concurrency) | No (local) |
| `.env` | Runtime directory | Secrets (PATs, tokens, API keys) | No (local) |

Setup wizard (`shkmn init`) creates both files with guided prompts.

Per-repo config (optional): `.shkmn.json` in repo root for repo-specific overrides (e.g., `sequential_build: true`).

---

## 13. Folder Structure

### 13.1 Runtime Directory (configurable, local)

```
{RUNTIME_ROOT}/
├── 00-inbox/                    ← Task files dropped here
├── 01-questions/
│   ├── pending/
│   └── done/
├── 02-research/
│   ├── pending/
│   └── done/
├── 03-design/
│   ├── pending/
│   └── done/
├── 04-structure/
│   ├── pending/
│   └── done/
├── 05-plan/
│   ├── pending/
│   └── done/
├── 06-impl/
│   ├── pending/
│   ├── active/{slug}/slice-{nn}/  ← Per-slice TDD artifacts
│   └── done/
├── 07-validate/
│   ├── pending/
│   └── done/
├── 08-review/
│   ├── pending/
│   └── done/
├── 09-pr/
│   ├── pending/
│   └── done/
├── 10-complete/{slug}/          ← All artifacts bundled
├── 11-failed/
├── 12-hold/                     ← Tasks paused at review gates
├── logs/
│   ├── {slug}.log
│   └── heimdall.log
├── history/
│   ├── history.json
│   ├── daily-log/
│   └── monthly-reports/
├── shkmn.config.json
├── .env
└── agent-registry.json          ← Runtime, tracks active agents
```

### 13.2 npm Package (installed)

```
shaktimaanai/
├── bin/
│   └── shkmn.ts                 ← CLI entry point
├── src/
│   ├── agents/
│   │   ├── narada.ts            ← Questions agent
│   │   ├── chitragupta.ts       ← Research agent
│   │   ├── vishwakarma.ts       ← Design agent
│   │   ├── vastu.ts             ← Structure agent
│   │   ├── chanakya.ts          ← Plan agent
│   │   ├── hanuman.ts           ← Work tree organizer
│   │   ├── karigar.ts           ← Impl agent
│   │   ├── dharma.ts            ← Validate agent
│   │   ├── drona.ts             ← Review agent
│   │   └── garuda.ts            ← PR agent
│   ├── core/
│   │   ├── heimdall.ts          ← File watcher
│   │   ├── brahma.ts            ← Task creator
│   │   ├── indra.ts             ← Approval handler
│   │   ├── sutradhaar.ts        ← Intent classifier
│   │   ├── pipeline.ts          ← Pipeline engine + stage transitions
│   │   ├── registry.ts          ← Agent registry + concurrency
│   │   └── recovery.ts          ← Crash recovery / startup scan
│   ├── config/
│   │   ├── loader.ts            ← Config + .env loader
│   │   └── schema.ts            ← Config validation
│   ├── surfaces/
│   │   ├── slack.ts             ← Slack input/output
│   │   ├── dashboard.ts         ← Dashboard data push
│   │   └── cli.ts               ← CLI commands
│   └── templates/
│       ├── prompt-questions.md
│       ├── prompt-research.md
│       ├── prompt-design.md
│       ├── prompt-structure.md
│       ├── prompt-plan.md
│       ├── prompt-impl.md
│       ├── prompt-validate.md
│       ├── prompt-review.md
│       └── prompt-classify.md
├── dashboard-template/           ← GitHub template repo contents
│   ├── .github/workflows/
│   │   └── build-deploy.yml
│   ├── docs/
│   │   ├── index.html
│   │   └── data/
│   │       ├── status.json
│   │       ├── history.json
│   │       └── week-so-far.json
│   └── README.md
└── package.json
```

---

## 14. Spec Decomposition

Five specs, in implementation order. Each spec gets its own document.

### Spec 1: Core Foundation & CLI
- npm package scaffolding, `shkmn` CLI entry point
- Config system (`shkmn.config.json` + `.env`)
- Setup wizard (`shkmn init`)
- `.task` file format
- Runtime directory creation
- Auth verification (`gh`, `az`, `claude`)

### Spec 2: Pipeline Engine & Agents
- Heimdall (watcher)
- Brahma (task creator)
- Sutradhaar (intent classifier)
- QRSPI alignment agents (Narada, Chitragupta, Vishwakarma, Vastu, Chanakya)
- Execution agents (Hanuman, Karigar, Dharma, Drona, Garuda)
- TDD red-green-refactor loop
- Stage transitions and review gates
- Indra (approval handler)
- Concurrency management and agent registry
- Crash recovery (startup scan)
- Git worktree management for Karigar

### Spec 3: Input Surfaces
- Slack integration (inbound parsing → Brahma, outbound notifications, thread-based approvals → Indra)
- CLI commands (`shkmn task`, `shkmn approve`, `shkmn status`, `shkmn logs`)
- Dashboard web form → Brahma
- Dashboard approve button → Indra

### Spec 4: Dashboard
- GitHub template repo structure
- Static site (HTML/JS/CSS, no framework dependency)
- GitHub Actions workflow (dalakotilaw pattern: data push → rebuild → auto-commit to docs/)
- Kanban board, list view, detail panel
- Task submission form, approve button
- `status.json` event schema
- Responsive design, dark theme

### Spec 5: History, Analytics & Reporting
- `history.json` (append-only record)
- Daily rollup (node-cron)
- Weekly summary (`week-so-far.json`)
- Monthly reports
- Notion push (ad hoc + scheduled)
- Dashboard History tab (heatmap, bar charts, metrics)
- Standup banner

---

## 15. CLI Commands

| Command | Description |
|---|---|
| `shkmn init` | Setup wizard — creates config, runtime dir, dashboard repo |
| `shkmn start` | Start Heimdall (watcher + scheduler). Runs crash recovery first. |
| `shkmn stop` | Stop Heimdall gracefully |
| `shkmn task "description"` | Create a task via CLI → Brahma |
| `shkmn approve <slug>` | Approve a task in review → Indra |
| `shkmn status` | Show active pipeline runs and their current stages |
| `shkmn logs <slug>` | Tail the log for a specific task |
| `shkmn history` | Show recent completed tasks |
| `shkmn config` | View/edit config interactively |

---

## 16. Security Considerations

- Secrets stored in `.env` in runtime directory (never committed)
- Agent SDK tool permissions scoped per agent (Karigar gets file write, Chitragupta gets read-only)
- `gh` and `az` CLIs use their own auth — no tokens passed through ShaktimaanAI
- Validate agent (Dharma) runs in the worktree, not in the user's working tree
- Intent classifier confidence threshold — below 0.7 asks for clarification instead of guessing
- Per-agent max turns to prevent runaway loops
- Per-agent timeout to kill stalled agents
