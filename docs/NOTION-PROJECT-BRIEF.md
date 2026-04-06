<!-- Notion import note: blockquote (>) blocks render as Notion quote blocks, NOT callout blocks. -->
<!-- Emoji-prefixed quotes (> 🎯) provide visual distinction but won't become native Notion callouts. -->
<!-- Tables: GFM pipe tables may need minor cleanup after Notion import. -->
<!-- Dividers: --- on its own line with surrounding blank lines. -->

# ShaktimaanAI

**An agentic development pipeline that automates the full software development lifecycle — from understanding a task through research, design, implementation, testing, review, and pull request creation.**

**🟢 Active — Pipeline Validated**

> Built with TypeScript and Claude's Agent SDK. Drop a task in via Slack, CLI, or dashboard — a sequence of specialized AI agents handles the rest.

---

## Problem Statement

Most solo developers and small teams hit the same bottleneck: the gap between having a clear idea and shipping a reviewed, tested pull request is filled with repetitive manual work — researching the codebase, designing a solution, writing tests, implementing code, reviewing your own changes, and assembling a PR. Each step is necessary, but together they create a slow, error-prone cycle that burns hours on process instead of problem-solving.

> 🎯 **The core problem**: A developer's time is split between *thinking* (the valuable part) and *process* (the repetitive part). Code review and PR workflows are the most visible pain point, but the friction starts much earlier — in how we research, plan, and structure work before a single line of code is written.

Traditional automation tools address individual steps: linters catch style issues, CI runs tests, copilots suggest completions. But no tool orchestrates the *entire* lifecycle as a coherent pipeline — from understanding the task through delivering a production-ready PR.

ShaktimaanAI exists because that end-to-end orchestration shouldn't require a team of humans. One developer should be able to describe what they want, and a pipeline of specialized agents should handle the research, design, implementation, validation, review, and delivery — with human approval gates at critical decision points.

---

## Solution

ShaktimaanAI is an **agentic pipeline** — a sequence of specialized AI agents, each responsible for one stage of development, orchestrated by deterministic TypeScript code. Unlike general-purpose coding assistants that respond to individual prompts, ShaktimaanAI runs a structured, multi-stage workflow that mirrors how experienced development teams operate.

**Three ways to start a task:**

- **CLI** — Run `shkmn task "your task description"` from any repo
- **Slack** — Drop a task description in a connected Slack channel
- **Dashboard** — Submit via a web form (coming in Spec 4)

All three surfaces feed into the same pipeline. Once a task enters, it flows through 9 stages automatically — with human approval gates at design review and code review.

> 💡 **How it stays aligned**: The pipeline follows a QRSPI methodology — **Q**uestions, **R**esearch, **S**tructure, **P**lan, **I**mplement. The first five stages ensure the agents deeply understand the task, the codebase, and the constraints *before* writing any code. This prevents the "plan-reading illusion" where an AI generates plausible-looking code that doesn't actually fit the project.

The result: a developer describes what they want in plain English, and ShaktimaanAI delivers a tested, reviewed pull request — typically in under 4 hours and for under $15 in API costs.

---

## How It Works

Tasks flow through 9 stages, split into two phases:

### Alignment (Stages 1-5)

The pipeline asks questions, researches the codebase, designs a solution, decomposes it into slices, and writes a tactical plan — all before touching any code.

| Stage | Agent | Named After | What It Does |
|-------|-------|-------------|--------------|
| 1. Questions | **Narada** | The eternal questioner sage | Generates targeted technical questions to clarify requirements and surface ambiguity |
| 2. Research | **Chitragupta** | Divine scribe who records facts | Investigates the codebase, reads docs, and gathers evidence to answer the questions |
| 3. Design | **Vishwakarma** | Architect of the gods | Designs the solution architecture with component interactions and error handling |
| 4. Structure | **Vastu** | Science of structure | Decomposes the design into vertical implementation slices with acceptance criteria |
| 5. Plan | **Chanakya** | Master strategist | Writes a step-by-step execution plan with exact file paths, code, and TDD sequences |

### Execution (Stages 6-9)

The pipeline implements code in TDD cycles, validates correctness, reviews quality, and creates a pull request.

| Stage | Agent | Named After | What It Does |
|-------|-------|-------------|--------------|
| 6. Implement | **Karigar** | Hindi for skilled craftsman | Writes code following the plan — test first, then implementation, slice by slice |
| 7. Validate | **Dharma** | Impartial judge | Runs all tests and checks that acceptance criteria are met; loops back to Karigar if not |
| 8. Review | **Drona** | Strict guru | Reviews code for quality, patterns, and correctness; requests changes if needed |
| 9. PR | **Garuda** | Swift divine messenger | Creates the pull request with a structured description and links to the task |

> ⚡ **Worktree isolation**: Between Plan and Implement, **Hanuman** (named after the breaker of mountains) sets up an isolated Git worktree so execution happens in a clean branch without affecting your working directory. Hanuman is a pipeline agent, not a separate stage — it runs automatically as part of the handoff from alignment to execution.

---

## Key Features

- **Crash Recovery** — The folder structure *is* the pipeline state. If the process crashes, restarts, or is killed mid-stage, the pipeline picks up exactly where it left off. No database, no external state store — just the filesystem.

- **TDD Enforcement** — Every implementation slice follows red-green-refactor: write a failing test, write the minimum code to pass it, then verify. The Validate agent (Dharma) loops back to Implement (Karigar) until all tests pass and acceptance criteria are met.

- **Review Gates** — Two human-in-the-loop checkpoints: design review after Vishwakarma produces the architecture, and code review after Drona evaluates the implementation. Reviews can approve, request changes (with retry), or reject.

- **Git Worktree Isolation** — All execution happens in an isolated Git worktree on a dedicated branch. Your working directory stays clean. The final PR merges from the worktree branch back to your target branch.

- **Cost Tracking** — Every stage logs its API cost and turn count. The CLI's `shkmn stats` command shows per-stage breakdowns so you can see exactly where tokens are spent and optimize accordingly.

---

## Architecture

### Core Tech Stack

| Technology | Role |
|-----------|------|
| **TypeScript** | Primary language — strict mode, ES2022 target |
| **Claude Agent SDK** | Powers all 10 pipeline agents via Anthropic's agent framework |
| **Commander.js** | CLI framework for the `shkmn` command interface |
| **Vitest** | Test runner and assertion framework |

### Also Uses

| Technology | Role |
|-----------|------|
| **chokidar** | File system watcher for pipeline state changes |
| **zod** | Runtime schema validation for configuration and task input |
| **@clack/prompts** | Interactive CLI prompts and spinners |
| **tsup** | TypeScript bundler for production builds |
| **dotenv** | Environment variable management |

### System Overview

```
┌─────────────────────────────────────────────────┐
│                  Input Surfaces                  │
│         Slack  ·  CLI (shkmn)  ·  Dashboard      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│              Pipeline Orchestrator               │
│    Deterministic TypeScript · Stage sequencing   │
│    Recovery · Cost tracking · Approval gates     │
└──────────────────────┬───────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────┐     ┌──────────────────┐
│    ALIGNMENT     │     │    EXECUTION     │
│                  │     │                  │
│  Narada          │     │  Hanuman (setup) │
│  Chitragupta     │     │  Karigar ↔ Dharma│
│  Vishwakarma ◆   │     │  Drona ◆         │
│  Vastu           │     │  Garuda          │
│  Chanakya        │     │                  │
└──────────────────┘     └──────────────────┘

◆ = human approval gate
```

> 💡 **Deterministic orchestration, AI execution**: The pipeline flow (which agent runs next, when to retry, how to recover from crashes) is controlled by plain TypeScript — no AI decides the workflow. Each agent uses Claude's Agent SDK only for its specific task (research, design, code, etc.).

---

## Results

*Data from E2E validation, April 2026.*

The pipeline was validated end-to-end across two phases — a clean run and a chaos-tested run with deliberate process kills and timeouts.

| Metric | Phase 1 (Clean Run) | Phase 2 (Chaos Run) |
|--------|---------------------|---------------------|
| **Total API Cost** | $16.32 | $11.84 |
| **Normalized Cost** | ~$8 (without infinite loop bug) | $11.84 |
| **Tests Written** | 482 across 34 files (at time of validation) | Maintained |
| **PR Created** | Yes | Yes |
| **Recovery Tested** | — | Process kills, stage timeouts, network interrupts |

### Bugs Found and Fixed

14 bugs were discovered and fixed across both validation phases — 11 in Phase 1, 3 in Phase 2.

| Severity | Count | Examples |
|----------|-------|---------|
| **P0 — Critical** | 7 | Build failures, infinite review loops, EBUSY file crashes |
| **P1 — Functional** | 3 | Wrong file write paths, worktree isolation gaps, stale test sync |
| **P2 — Quality** | 3 | Path warnings, stream optimization, timeout tuning |
| **Test alignment** | 1 | Stale assertions updated for Spec 3 additions |

> ⚡ **Finding bugs is the point.** A validation exercise that finds zero bugs didn't test hard enough. The 14 fixes — especially the 7 critical ones — mean the pipeline is now substantially more robust than before validation. The infinite loop fix alone cut expected run costs by ~50%.

---

## What's Next

Two major specs remain on the roadmap:

### Spec 4: Dashboard

A web-based task submission and monitoring interface:

- **GitHub template repo** — one-click setup for new projects
- **Static site** — lightweight dashboard built with GitHub Pages
- **Kanban board** — visual pipeline status for active tasks
- **Task submission form** — web alternative to CLI and Slack input

### Spec 5: History & Reporting

Long-term analytics and integration layer:

- **Daily rollup** — automated summary of pipeline runs, costs, and outcomes
- **Weekly/monthly reports** — trend analysis across tasks
- **Notion push** — ad hoc and scheduled sync of pipeline data to Notion
- **Scheduled tasks** — cron-style recurring pipeline runs

---

## Try It

**Repository:** [github.com/prpande/ShaktimaanAI](https://github.com/prpande/ShaktimaanAI)

### Quick Setup

```bash
# Clone the repo
git clone https://github.com/prpande/ShaktimaanAI.git
cd ShaktimaanAI

# Install dependencies and build
npm install
npm run build

# Make the CLI globally available
npm link

# Set up environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (required)
```

### Run Your First Task

```bash
# Initialize ShaktimaanAI in your target repo
cd /path/to/your/project
shkmn init

# Create a task
shkmn task "Add input validation to the user registration form"

# Start the pipeline
shkmn start
```

### Requirements

- **Node.js 20+**
- **GitHub CLI (`gh`)** — required for PR creation
- **Anthropic API key** — set as `ANTHROPIC_API_KEY` in `.env`

---

**License:** MIT — see [LICENSE](https://github.com/prpande/ShaktimaanAI/blob/master/LICENSE) for details.
