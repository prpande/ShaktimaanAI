# ShaktimaanAI

An agentic development pipeline that automates the software development lifecycle — from task intake through research, design, implementation, testing, review, and PR creation.

ShaktimaanAI uses Claude's Agent SDK to run specialized LLM-powered agents, orchestrated by deterministic TypeScript code. Drop a task in via Slack, a dashboard form, or the CLI, and the pipeline handles the rest.

## How It Works

Tasks flow through a QRSPI-inspired pipeline with TDD:

```
ALIGNMENT                              EXECUTION
─────────                              ─────────
Narada (Questions)                     Hanuman (Work Tree)
  → Chitragupta (Research)               → Karigar (Impl) ↔ Dharma (Validate)
    → Vishwakarma (Design) [review gate]    → Drona (Review)
      → Vastu (Structure)                     → Garuda (PR)
        → Chanakya (Plan)
```

Each agent is named after figures from Hindu mythology and Hindi culture, reflecting its role:

| Agent | Role | Named After |
|---|---|---|
| **Narada** | Generates targeted technical questions | The eternal questioner sage |
| **Chitragupta** | Researches codebase objectively | Divine scribe who records facts |
| **Vishwakarma** | Designs the architecture | Architect of the gods |
| **Vastu** | Decomposes into vertical slices | Science of structure |
| **Chanakya** | Writes tactical implementation plan | Master strategist |
| **Hanuman** | Organizes work into task tree | Breaker of mountains |
| **Karigar** | Writes code (TDD: tests first) | Craftsman |
| **Dharma** | Validates builds and tests | Impartial judge |
| **Drona** | Reviews code quality | Strict guru |
| **Garuda** | Creates PR, links ADO | Swift divine messenger |

Infrastructure components:

| Component | Role | Named After |
|---|---|---|
| **Heimdall** | File watcher (persistent process) | All-seeing guardian |
| **Brahma** | Canonical task creator | The creator |
| **Indra** | Canonical approval handler | King of devas |
| **Sutradhaar** | Intent classifier | Theater narrator |

## Key Features

- **Three input surfaces, one pipeline** — Slack (primary), dashboard web UI, CLI (`shkmn`). All converge to a single canonical task creator.
- **QRSPI alignment** — five alignment stages prevent the "plan-reading illusion" where plans look good but have wrong technical assumptions.
- **TDD per vertical slice** — red-green-refactor cycle for every implementation slice.
- **Deterministic orchestration** — routing, scheduling, state recovery are pure code. LLMs only used for intent classification and within agents.
- **Crash recovery** — folder structure IS the pipeline state. Kill it anytime, restart, and it picks up where it left off.
- **Cross-platform** — full TypeScript/Node.js. No OS-specific dependencies.
- **Multi-user** — install via npm, each user gets their own dashboard and runtime.

## Architecture

```
Input Surfaces (Slack | Dashboard | CLI)
         │
    Sutradhaar (classify intent)
         │
    Brahma (create task)
         │
    Heimdall (watch inbox, dispatch)
         │
    Pipeline Engine (route → spawn agents → track lifecycle)
         │
    Agents (QRSPI alignment → TDD execution)
         │
    Data Layer (status.json, history.json)
         │
    Dashboard (GitHub Pages, per-user)
```

## Installation

> **Note:** ShaktimaanAI is under active development. Installation instructions will be available once Spec 1 (Core Foundation & CLI) is implemented.

```bash
npm install -g shaktimaanai
shkmn init    # setup wizard
shkmn start   # start the pipeline
```

## CLI Commands

| Command | Description |
|---|---|
| `shkmn init` | Setup wizard — config, runtime dir, dashboard repo |
| `shkmn start` | Start Heimdall (watcher + scheduler) |
| `shkmn stop` | Stop gracefully |
| `shkmn task "description"` | Create a task |
| `shkmn approve <slug>` | Approve a task in review |
| `shkmn status` | Show active pipeline runs |
| `shkmn logs <slug>` | Tail logs for a task |
| `shkmn history` | Show recent completed tasks |

## Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| Agent SDK | Claude Agent SDK |
| File watching | chokidar |
| Scheduling | node-cron |
| GitHub | `gh` CLI |
| Azure DevOps | `az boards` CLI |
| Slack | MCP |
| Notion | MCP |
| Dashboard | GitHub Pages (static) |

## Documentation

- [System Design Document](docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md) — full architecture, agent roster, pipeline stages, concurrency model, crash recovery
- [0th Draft](docs/0thDraft/) — original brainstorming documents that led to the current design

## Development Roadmap

The system is being built in 5 specs, each with its own implementation plan:

1. **Core Foundation & CLI** — npm package, `shkmn` CLI, config system, setup wizard
2. **Pipeline Engine & Agents** — Heimdall, Brahma, QRSPI agents, TDD loop, crash recovery
3. **Input Surfaces** — Slack integration, CLI commands, dashboard form
4. **Dashboard** — GitHub template repo, static site, GitHub Actions
5. **History & Reporting** — daily rollup, weekly/monthly reports, Notion push

## License

See [LICENSE](LICENSE) for details.
