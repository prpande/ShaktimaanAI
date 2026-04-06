<!-- Last verified: 2026-04-06 | Sources of truth: src/cli.ts (commands), src/config/defaults.ts (agent names, config) -->

# ShaktimaanAI

An agentic development pipeline that automates the software development lifecycle — from task intake through research, design, implementation, testing, review, and PR creation.

ShaktimaanAI uses [Claude's Agent SDK](https://github.com/anthropics/claude-agent-sdk) to run specialized LLM-powered agents through a 9-stage pipeline, orchestrated by deterministic TypeScript code. Drop a task in via the CLI (`shkmn task "..."`) and the pipeline handles the rest.

## Pipeline Architecture

Tasks flow through 9 stages split into two phases:

```
ALIGNMENT (read-only — no Write/Edit tools)        EXECUTION (write-enabled)
──────────────────────────────────────────          ────────────────────────
1. questions ─► 2. research ─► 3. design ──┐       6. impl ◄─► 7. validate
                                           │           │
                              [review gate]│       8. review
                                           │           │
              4. structure ◄───────────────┘       9. pr
                   │
              5. plan ─────────────────────────► worktree setup ─► impl
```

**Alignment stages** (questions → plan) explore the problem space without modifying code. Agents in these stages have Read/Glob/Grep access but cannot Write or Edit files.

**Execution stages** (impl → pr) modify code. The `impl` stage is the first with Write/Edit tool permissions.

### Review Gate

After the **design** stage, tasks pause automatically and move to the `12-hold/` directory. A human reviews the design and resumes the pipeline with:

```bash
shkmn approve <task-slug>
```

This is configured via `agents.defaultReviewAfter` (default: `"design"`).

### Worktree Isolation

Before the `impl` stage, the pipeline engine creates an isolated git worktree at `shkmn/<task-slug>`. Each task gets its own branch, preventing concurrent tasks from interfering with each other. This is an infrastructure step performed by the pipeline engine — not a pipeline stage.

## Agents

Each agent is named after figures from Hindu mythology and Hindi culture, reflecting its role.

### Pipeline Stage Agents

| # | Stage | Agent | Role | Named After |
|---|---|---|---|---|
| 1 | questions | **Narada** | Generates targeted technical questions to clarify the task | The eternal questioner sage |
| 2 | research | **Chitragupta** | Researches the codebase and gathers facts objectively | Divine scribe who records all deeds |
| 3 | design | **Vishwakarma** | Designs the technical architecture and approach | Architect of the gods |
| 4 | structure | **Vastu** | Decomposes the design into vertical implementation slices | Science of structure and layout |
| 5 | plan | **Chanakya** | Writes a tactical, step-by-step implementation plan | Master strategist and advisor |
| 6 | impl | **Karigar** | Writes code following TDD (tests first, then implementation) | Craftsman / artisan |
| 7 | validate | **Dharma** | Validates that builds pass and tests are green | Impartial judge of right action |
| 8 | review | **Drono** | Reviews code quality and suggests improvements | Strict guru and teacher |
| 9 | pr | **Garuda** | Creates the pull request and pushes the branch | Swift divine messenger |

### Infrastructure Components

| Component | Agent | Role |
|---|---|---|
| Watcher | **Heimdall** | Watches `00-inbox/` for new `.task` and `.control` files, dispatches to pipeline |
| Task Creator | **Brahma** | Builds canonical `.task` files with metadata from CLI or other surfaces |
| Approval Handler | **Indra** | Finds held tasks in `12-hold/` and resumes pipeline on approval |
| Intent Classifier | **Sutradhaar** | Classifies task intent via keyword matching with LLM fallback |

### Utility

| Component | Agent | Role |
|---|---|---|
| Worktree | **Hanuman** | Named role for git worktree operations — infrastructure utility, not a pipeline stage |

## Key Features

- **QRSPI alignment stages** — five read-only stages (questions, research, design, structure, plan) prevent the "plan-reading illusion" where plans look good but rest on wrong technical assumptions
- **TDD execution** — the impl/validate loop follows red-green-refactor: Karigar writes tests first, then implementation; Dharma validates builds and test results
- **Deterministic orchestration** — routing, state transitions, and recovery are pure TypeScript. LLMs are used only within agent stages and for intent classification
- **Review gates** — tasks pause after configurable stages (default: design) for human review before execution begins
- **Worktree isolation** — each task runs in its own git worktree and branch, enabling concurrent task execution without interference
- **Crash recovery** — folder-based state means the pipeline can be killed at any time. On restart, `shkmn start` scans pending directories and resumes interrupted tasks automatically

## Quick Tasks

For simple, single-step tasks that don't need the full 9-stage pipeline, prefix your task with `quick:`:

```bash
shkmn task "quick: fix the typo in the footer component"
```

Quick tasks are handled by **Astra**, a single agent with full Read/Write/Edit/Bash permissions and a 30-minute timeout. Astra bypasses all alignment and review stages, executing the task directly.

## Prerequisites

| Tool | Check Command | Required |
|---|---|---|
| Node.js ≥ 20 | `node --version` | Yes |
| Claude Code | `claude --version` | Yes |
| GitHub CLI | `gh --version` | Yes |
| Git | `git --version` | Yes |
| Azure CLI | `az --version` | Optional |

Run `shkmn doctor` after installation to verify all prerequisites and configuration.

## Installation

```bash
git clone https://github.com/prpande/ShaktimaanAI.git
cd ShaktimaanAI
npm install
npm run build
npm link
```

After linking, the `shkmn` command is available globally on your machine.

### Environment Variables

Copy the example environment file and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | API key for Claude Agent SDK — agents cannot run without this |
| `GITHUB_PAT` | Optional | GitHub personal access token for PR creation |
| `ADO_PAT` | Optional | Azure DevOps personal access token |
| `SLACK_TOKEN` | Optional | Slack bot token (Slack integration is not yet fully implemented) |
| `SLACK_WEBHOOK_URL` | Optional | Slack webhook for notifications |

Place the `.env` file in your ShaktimaanAI runtime directory (the directory you select during `shkmn init`).

## Configuration

Run the setup wizard to create your configuration file:

```bash
shkmn init
```

This creates `shkmn.config.json` with your runtime directory, repository paths, and agent settings.

### Reading and Writing Config

```bash
shkmn config get agents.defaultReviewAfter    # → "design"
shkmn config set agents.retryCount 2
```

### Key Config Sections

| Section | Purpose |
|---|---|
| `pipeline` | Runtime directory and agent prompt paths |
| `repos` | Repository root and aliases for multi-repo setups |
| `agents` | Stage list, review gates, concurrency limits, timeouts, tool permissions |
| `worktree` | Retention period (`retentionDays: 7`) and cleanup behavior |
| `quickTask` | Review requirements and complexity threshold for quick tasks |
| `slack` | Slack integration settings (disabled by default) |
| `ado` | Azure DevOps organization, project, and area path |

## CLI Commands

### Setup

| Command | Description |
|---|---|
| `shkmn init` | Interactive setup wizard — creates config, runtime dirs |
| `shkmn config get <path>` | Get a config value by dot-path |
| `shkmn config set <path> <value>` | Set a config value by dot-path |
| `shkmn doctor` | System health check — verifies prerequisites, config, env, agent prompts |

### Lifecycle

| Command | Description |
|---|---|
| `shkmn start` | Start the watcher daemon (Heimdall) and resume interrupted tasks |
| `shkmn stop` | Stop the watcher daemon gracefully |

### Task Management

| Command | Description |
|---|---|
| `shkmn task "<description>"` | Create a new task and drop it in the inbox |
| `shkmn approve [slug]` | Approve a task paused at a review gate |
| `shkmn cancel [slug]` | Cancel a running or pending task |
| `shkmn skip [slug]` | Skip the current stage and advance to the next |

### Pipeline Control

| Command | Description |
|---|---|
| `shkmn pause [slug]` | Pause a running task |
| `shkmn resume [slug]` | Resume a paused task |
| `shkmn modify-stages [slug]` | Change the remaining stages for a task |
| `shkmn restart-stage [slug]` | Re-run the current stage from scratch |
| `shkmn retry [slug]` | Retry a failed task from its last stage |

### Diagnostics

| Command | Description |
|---|---|
| `shkmn status` | Show active pipeline runs and their current stage |
| `shkmn logs [slug]` | Tail logs for a specific task |
| `shkmn history` | Show recently completed tasks |
| `shkmn stats` | Display daily/session pipeline statistics |

## Usage Examples

### Initial Setup

```bash
shkmn init       # interactive wizard — sets runtime dir, repo paths
shkmn doctor     # verify prerequisites and configuration
```

### Running a Task

```bash
shkmn start                          # start the watcher daemon
shkmn task "Add user authentication" # create a task
shkmn status                         # check pipeline progress
```

### Reviewing and Approving

```bash
# After the design stage, the task pauses at 12-hold/
shkmn status                         # shows task waiting for approval
shkmn approve add-user-auth          # approve and resume pipeline
```

### Checking Logs and History

```bash
shkmn logs add-user-auth             # tail logs for a specific task
shkmn history                        # show recently completed tasks
shkmn stats                          # daily pipeline statistics
```

### Quick Task

```bash
shkmn task "quick: fix the broken link in the footer"
# Astra handles it directly — no alignment stages, no review gate
```

## Recovery & Crash Resilience

ShaktimaanAI uses a **folder-based state machine**. Task state is determined by which directory the task file lives in:

| Directory | State |
|---|---|
| `00-inbox/` | New task, awaiting pickup |
| `01-questions/` through `09-pr/` | Active in the named stage (with `pending/` and `done/` subdirectories) |
| `10-complete/` | Successfully finished |
| `11-failed/` | Failed after retries exhausted |
| `12-hold/` | Paused at a review gate, awaiting `shkmn approve` |

### Automatic Resume

When `shkmn start` is called, the pipeline scans all directories for interrupted tasks:
- Tasks in `pending/` subdirectories are resumed from their current stage
- Tasks in `00-inbox/` are dispatched normally

### Worktree Recovery

If the pipeline crashes mid-implementation, the git worktree at `shkmn/<task-slug>` is preserved. On restart, the existing worktree is **reused** rather than recreated. Completed worktrees are retained for `worktree.retentionDays` (default: 7 days) and cleaned up automatically when `worktree.cleanupOnStartup` is enabled.

## Documentation

- [System Design Document](docs/superpowers/specs/2026-04-04-shaktimaanai-system-design.md) — full architecture, agent roster, pipeline stages, concurrency model, crash recovery
- [Implementation Plans](docs/superpowers/plans/) — spec-by-spec implementation plans
- [Agent Prompts](agents/) — the `.md` files that define each agent's behavior (authoritative source for agent roles)
- [0th Draft](docs/0thDraft/) — original brainstorming documents

## License

MIT — see [LICENSE](LICENSE) for details.
