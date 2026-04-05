# Spec 3: Input Surfaces (CLI + Slack) — Design Document

**Version:** 1.0
**Date:** 2026-04-05
**Author:** Pratyush Pande (with Claude)
**Status:** Draft
**Depends on:** Spec 1 (Core Foundation & CLI), Spec 2a-2c (Pipeline Engine & Agents)

---

## 1. Overview

Spec 3 adds two programmatic input surfaces — CLI commands and Slack integration — that allow users to create tasks, approve reviews, control running pipelines, and receive notifications. Both surfaces funnel to the canonical handlers (Brahma, Indra, Sutradhaar) built in Specs 1–2.

Dashboard web form and approve button are deferred to Spec 4.

### Scope

- CLI commands: `task`, `approve`, `status`, `logs`, `cancel`, `skip`, `pause`, `resume`, `modify-stages`, `restart-stage`, `retry`
- Slack integration: inbound polling + intent classification, outbound thread-based notifications
- Pipeline control operations: cancel, skip, pause, resume, modify-stages, restart-stage, retry
- Quick task path: short-circuit for simple tasks that don't need the full pipeline
- Stage hints: user guidance extracted and injected into agent prompts
- Interaction logging: per-task markdown + global daily JSON
- Slug resolution: fuzzy matching for Slack and CLI

### Out of Scope

- Dashboard web form / approve button (Spec 4)
- History views and analytics (Spec 5)
- Slack Bot App / Socket Mode (future enhancement — current design uses Slack MCP polling)

---

## 2. Architecture

### 2.1 Surface Adapter Pattern

Each surface gets a thin adapter in `src/surfaces/` that translates surface-specific I/O into calls to canonical handlers. A shared `Notifier` interface handles outbound messages.

```
Inbound:
  CLI command ──→ parse args ──→ canonical handler
  Slack msg   ──→ Sutradhaar ──→ canonical handler

Outbound:
  Pipeline stage transition ──→ notifier.notify(event)
    ├── ConsoleNotifier (prints to stdout when shkmn start is foreground)
    └── SlackNotifier (posts to channel/thread via Slack MCP)
```

### 2.2 New Files

```
src/surfaces/
├── types.ts              ← Notifier interface, NotifyEvent, NotifyLevel enum
├── cli-surface.ts        ← Wires commander actions to handlers
├── slack-surface.ts      ← Poll + parse + classify inbound
├── slack-notifier.ts     ← SlackNotifier: posts to channel/thread via Slack MCP
└── console-notifier.ts   ← Prints events to stdout
src/core/
├── slug-resolver.ts      ← Fuzzy slug matching
├── interactions.ts       ← Per-task markdown + global daily JSON logging
```

### 2.3 Modified Files

| File | Changes |
|---|---|
| `src/core/pipeline.ts` | Emits notify events, adds 7 control operations |
| `src/core/watcher.ts` | Adds Slack polling arm inside Heimdall |
| `src/core/intent-classifier.ts` | New intents, complexity classification, stage hint extraction |
| `src/core/types.ts` | RunState gains `stageHints`, retry versioning |
| `src/core/agent-runner.ts` | `buildSystemPrompt` injects stage hints section |
| `src/core/registry.ts` | Add `abortBySlug(slug)` method |
| `src/config/schema.ts` | New Slack + quickTask config fields |
| `src/commands/*.ts` | Wire CLI commands to cli-surface |
| `agents/quick.md` | New agent prompt for quick tasks |
| `agents/classify.md` | Update for new intents, complexity, stage hint extraction |

---

## 3. Config Additions

New fields in `shkmn.config.json`:

```json
{
  "slack": {
    "enabled": false,
    "channel": "#agent-pipeline",
    "channelId": "",
    "pollIntervalSeconds": 30,
    "notifyLevel": "bookends",
    "allowDMs": false,
    "requirePrefix": true,
    "prefix": "shkmn"
  },
  "quickTask": {
    "requireReview": true,
    "complexityThreshold": 0.8
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `slack.notifyLevel` | `"minimal"` \| `"bookends"` \| `"stages"` | `"bookends"` | Verbosity of Slack notifications |
| `slack.allowDMs` | `boolean` | `false` | Whether to poll and respond to DMs |
| `slack.requirePrefix` | `boolean` | `true` | Whether messages must start with prefix to be classified |
| `slack.prefix` | `string` | `"shkmn"` | Trigger prefix when `requirePrefix` is true |
| `quickTask.requireReview` | `boolean` | `true` | Whether quick task output is held for review |
| `quickTask.complexityThreshold` | `number` | `0.8` | Minimum confidence to auto-classify as quick vs pipeline |

---

## 4. CLI Commands

All commands load config, resolve runtime dir, then delegate to canonical handlers. No business logic in command files.

| Command | Args / Options | Handler |
|---|---|---|
| `shkmn task "<desc>"` | `--repo`, `--ado`, `--stages`, `--hints` | `createTask()` via Brahma |
| `shkmn approve <slug>` | `--feedback` | `approveTask()` via Indra |
| `shkmn status` | none | Scan stage dirs + `12-hold/` |
| `shkmn logs <slug>` | `-f` / `--follow`, `--lines <n>` (default 50) | Read/tail task log file |
| `shkmn cancel <slug>` | none | `pipeline.cancel()` |
| `shkmn skip <slug>` | `--stage <name>` (optional, defaults to current) | `pipeline.skip()` |
| `shkmn pause <slug>` | none | `pipeline.pause()` |
| `shkmn resume <slug>` | none | `pipeline.resume()` |
| `shkmn modify-stages <slug>` | `--stages <comma-list>` | `pipeline.modifyStages()` |
| `shkmn restart-stage <slug>` | `--stage <name>` (optional) | `pipeline.restartStage()` |
| `shkmn retry <slug>` | `--feedback "<text>"` (required) | `pipeline.retry()` |

### 4.1 Stage Hints via CLI

```
shkmn task "build landing page" --repo web-app --hints "design:use contemporary patterns" --hints "impl:prefer Tailwind CSS"
```

Parsed into `stageHints: Record<string, string>` and written to the `.task` file under a `## Stage Hints` section.

### 4.2 Status Output Format

```
Active:
  fix-auth-bug-20260405103000   → research    (12m)
  add-logging-20260405110000    → impl        (3m)

Held (awaiting approval):
  build-landing-20260405090000  → design      (held 45m)
```

### 4.3 Logs Tail Mode

`shkmn logs <slug>` defaults to last 50 lines. With `-f` / `--follow`, streams new lines as they're written (like `tail -f`). Useful for watching an active task in real time.

---

## 5. Slack Surface — Inbound

### 5.1 Polling Loop

Lives inside Heimdall alongside chokidar. Every `pollIntervalSeconds`:

1. Read messages from configured channel (and DMs if `allowDMs: true`) via Slack MCP
2. Filter: skip bot's own messages, skip already-processed messages (track last-seen timestamp)
3. If `requirePrefix: true`, skip messages that don't start with `prefix`
4. Strip prefix if present, pass remaining text to Sutradhaar

**Last-seen tracking:** The poller persists a `slack-cursor.json` file in the runtime directory containing `{ "channelTs": "<timestamp>", "dmTs": "<timestamp>" }`. On startup (including crash recovery), the poller reads this file and resumes from the last processed message. If the file is missing, it starts from "now" (avoids reprocessing old history).

### 5.2 Intent Classification Expansion

Sutradhaar gains new intents and fields:

**New intents:**

| Intent | Example triggers |
|---|---|
| `create_task` | "fix the auth bug in repo-x" |
| `approve` | "approve fix-auth-bug-2026...", "lgtm" |
| `cancel` | "cancel fix-auth-bug-2026...", "stop that task" |
| `skip` | "skip research on fix-auth", "skip design" |
| `pause` | "pause fix-auth", "hold on fix-auth" |
| `resume` | "resume fix-auth", "continue fix-auth" |
| `modify_stages` | "drop review for fix-auth", "add structure stage to fix-auth" |
| `restart_stage` | "restart design on fix-auth" |
| `retry` | "retry design — use microservices instead" |
| `status` | "what's running", "status" |
| `unknown` | Fallback |

**Expanded ClassifyResult:**

```typescript
interface ClassifyResult {
  intent: string;
  confidence: number;
  extractedSlug: string | null;
  extractedContent: string | null;
  extractedStages: string[] | null;     // for modify_stages
  extractedFeedback: string | null;     // for retry, approve
  stageHints: Record<string, string> | null;  // extracted guidance
  complexity: "quick" | "pipeline" | null;    // null for non-create intents
  complexityConfidence: number;               // 0 when complexity is null
}
```

### 5.3 Thread Context

When a message is a thread reply under a pipeline notification for a specific task, the task slug is inferred from the parent message. "approve" in a task's notification thread = approve that task. No need to mention the slug explicitly.

### 5.4 Prefix Handling

| `requirePrefix` | Message | Processed? |
|---|---|---|
| `true` | "shkmn fix the auth bug" | Yes — prefix stripped, "fix the auth bug" classified |
| `true` | "fix the auth bug" | No — ignored |
| `false` | "fix the auth bug" | Yes — classified directly |
| either | Thread reply "approve" | Yes — thread context, prefix not required in replies |

---

## 6. Slack Surface — Outbound (Notifications)

### 6.1 NotifyEvent Types

| Event | Payload | Description |
|---|---|---|
| `task_created` | slug, title, source, stages | New task entered inbox |
| `stage_started` | slug, stage name | Agent spawned for stage |
| `stage_completed` | slug, stage name, artifact path | Stage finished, artifact produced |
| `task_held` | slug, stage name, artifact GitHub URL | Awaiting approval at review gate |
| `task_approved` | slug, who approved, feedback if any | Approval received |
| `task_completed` | slug, PR URL if applicable | Pipeline finished |
| `task_failed` | slug, stage, error summary | Pipeline failed |
| `task_cancelled` | slug, by whom | Cancelled via command |
| `task_paused` | slug, by whom | Manually paused |
| `task_resumed` | slug, by whom | Resumed from pause |
| `stage_retried` | slug, stage, attempt number, feedback | Stage re-running with feedback |
| `stage_skipped` | slug, stage name | Stage skipped via command |
| `stages_modified` | slug, old stages, new stages | Stage list changed mid-flight |

### 6.2 NotifyLevel Filtering

| Level | Events shown |
|---|---|
| `minimal` | `task_held`, `task_failed` |
| `bookends` | minimal + `task_created`, `task_completed`, `task_cancelled` |
| `stages` | bookends + all `stage_*` events + `task_paused`, `task_resumed`, `task_approved`, `stages_modified` |

### 6.3 Slack Message Threading

- Each task gets a **root message** posted when `task_created` fires
- All subsequent events for that task are posted as **thread replies** under that root message
- `task_held` thread replies include the GitHub link to the artifact in the dashboard repo for review context
- Thread-based replies enable natural approval and retry flows

### 6.4 Console Notifier

`ConsoleNotifier` prints a one-line format to stdout for `shkmn start` foreground mode. Same `NotifyLevel` filtering applies — always uses `stages` level since you're actively watching the terminal.

### 6.5 Graceful Degradation

When `slack.enabled: false`, the SlackNotifier is not registered. Only the ConsoleNotifier operates. Pipeline control commands from CLI still work — notifications just go to stdout. The Slack polling arm in Heimdall is skipped entirely.

---

## 7. Pipeline Control Operations

### 7.1 New Pipeline Methods

| Operation | Valid task state | What happens |
|---|---|---|
| `cancel(slug)` | Active (any stage) or held | Abort running agent via registry, move to `11-failed/` |
| `skip(slug, stage?)` | Active | Skip current stage (or named future stage), advance to next |
| `pause(slug)` | Active | Abort running agent, move to `12-hold/`, no review gate needed |
| `resume(slug)` | Held (via pause) | Resume from the stage it was paused at |
| `modifyStages(slug, newStages)` | Active or held | Replace remaining stages in RunState. Validates no duplicate/invalid names |
| `restartStage(slug, stage?)` | Active or held | Re-run current (or named) stage from scratch. No feedback injected |
| `retry(slug, feedback)` | Held (at review gate) | Re-run held stage with feedback. New versioned artifact |

### 7.2 Distinction Between approve, resume, and retry

| Operation | Trigger | Effect |
|---|---|---|
| `approve` | Review gate passed | Advance to *next* stage |
| `resume` | Manual pause released | Continue from *same* stage |
| `retry` | Re-run with feedback | Re-run *same* stage, new artifact, hold again for review |

### 7.3 Abort Mechanics

`cancel` and `pause` need to stop a running agent. The registry already tracks active agents with `AbortController`. `registry.abort(slug)` signals the agent to stop. The pipeline catches the abort, performs cleanup (worktree if impl stage), and transitions state.

### 7.4 Versioned Retry Artifacts

When `retry` is called for stage X at attempt N:

1. Existing output stays in place (original name or prior `-rN` suffix)
2. New output path: `{stage}-output-r{N}.md` (e.g., `design-output-r1.md`, `design-output-r2.md`)
3. Agent receives: previous version output + reviewer feedback as context
4. After agent completes, task returns to `12-hold/` for another review

### 7.5 Error Handling

If an operation is invalid for the current task state (e.g., `skip` on a completed task), the handler returns a structured error. CLI prints the error and exits with non-zero code. Slack notifier replies in thread with the error message.

---

## 8. Stage Hints

### 8.1 At Task Creation

Written to the `.task` file under a `## Stage Hints` section:

```markdown
# Task: fix the auth bug in repo-x

## What I want done
fix the auth bug in repo-x

## Stage Hints
design: use contemporary and modular design patterns
impl: prefer Tailwind CSS, use async/await

## Context
Source: cli

## Pipeline Config
stages: questions, research, design, structure, plan, impl, validate, review, pr
review_after: design
```

### 8.2 Mid-Flight Hints

Stored in RunState:

```typescript
interface RunState {
  // ... existing fields
  stageHints: Record<string, string[]>;  // key = stage name, value = accumulated hints
}
```

When a mid-flight hint arrives (e.g., "tell the impl agent to use async/await"), it's appended to `runState.stageHints["impl"]`. Multiple hints for the same stage accumulate.

### 8.3 Injection into Agent Prompts

`buildSystemPrompt` in `agent-runner.ts` gains a new context section, inserted after pipeline context and before the agent's prompt instructions:

```markdown
## User Guidance

The user has provided the following instructions for this stage:
- use contemporary and modular design patterns
- prefer composition over inheritance
```

Hints from both sources (`.task` file + RunState) are merged.

### 8.4 Extraction by Sutradhaar

The LLM classification prompt is updated to extract stage hints from natural language. The keyword classifier does not attempt hint extraction — that's inherently an LLM task. If Sutradhaar can't determine which stage a hint targets, it applies the hint to all remaining stages.

---

## 9. Quick Task Path

### 9.1 Complexity Classification

Sutradhaar's output includes a `complexity` field (`"quick"` | `"pipeline"`) with a `complexityConfidence` score.

**Keyword layer (before LLM):**
- Explicit `--quick` flag or "quick:" prefix → `quick` at 1.0 confidence
- Explicit `--full` flag or "full pipeline:" prefix → `pipeline` at 1.0 confidence
- Otherwise LLM classifies based on task content

Below `quickTask.complexityThreshold` (default 0.8), the bot asks for clarification: "This looks like it could be a quick task — should I handle it directly or run the full pipeline?"

### 9.2 Quick Path Flow

```
Sutradhaar classifies → complexity: "quick"
  → Spawn quick agent (agents/quick.md)
     Context: task content + stage hints + repo context (if repo specified)
  → requireReview: true?
     yes → output to 12-hold/{slug}/, notify with GitHub link, wait for approve
     no  → output to 10-complete/{slug}/
  → Log interaction + agent run to daily JSON
  → Notify via surfaces (task_created → task_completed, or task_created → task_held)
```

### 9.3 Escalation

If reviewing a quick task output, the user can reply "full pipeline" (or `shkmn modify-stages <slug> --stages questions,research,...`). The task gets reclassified, moves out of hold, and enters the full QRSPI path from the beginning.

### 9.4 Agent Prompt (`agents/quick.md`)

Dedicated prompt for quick tasks:
- Identity: general-purpose task executor
- Instructions: complete the task directly, be concise, match the tone/format implied by the request
- Output: write result to the provided output path
- No multi-stage thinking, no TDD, no slices

---

## 10. Slug Resolution

### 10.1 Resolution Strategy

`resolveSlug(query: string, runtimeDir: string): string | string[]`

Priority order:

1. **Thread context** (Slack only) — if message is a thread reply under a task notification, resolve from parent message's task slug. Most specific and reliable.
2. **Exact match** — input matches a full slug exactly
3. **Prefix match** — input matches the start of exactly one slug
4. **Keyword match** — input words match against slug segments (e.g., "auth task" → scans for slugs containing "auth")

Returns:
- Single string if unambiguous match
- Array of strings if multiple matches (caller asks for clarification)
- Empty array if no match

### 10.2 Search Scope

Only scans active stages (`01-*` through `09-*`) and `12-hold/`. Completed (`10-complete/`) and failed (`11-failed/`) tasks are excluded to avoid acting on stale tasks.

### 10.3 CLI Behavior

If ambiguous, prints candidates and exits with non-zero code:

```
Multiple tasks match "auth":
  fix-auth-bug-20260405103000  → impl (active)
  update-auth-flow-20260405120000  → held
Specify the full slug or a unique prefix.
```

---

## 11. Interaction Logging

### 11.1 Per-Task Interaction Log

`interactions.md` stored at `{runtimeDir}/{current-stage-dir}/{slug}/interactions.md`. Moves with the task as it progresses through stages. On stage transition, the file is copied forward to the new stage directory. A final copy is preserved in `10-complete/{slug}/` or `11-failed/{slug}/`. Written on every human-initiated action (creation, approval, retry, skip, pause, resume, cancel, modify-stages, stage hints). Not written for automated pipeline events.

Format:

```markdown
# Interactions — fix-auth-bug-20260405103000

### 2026-04-05 10:30 — CLI
**Intent:** create_task
**Message:** "fix the auth bug in repo-x"
**Stage hints:** design: "use contemporary patterns"
**Action:** Task created, pipeline started

### 2026-04-05 11:15 — Slack
**Intent:** retry
**Target stage:** design
**Message:** "redo this, use microservices instead of monolith"
**Action:** Re-ran Vishwakarma (design) → design-output-r1.md

### 2026-04-05 11:45 — Slack
**Intent:** approve
**Message:** "lgtm"
**Action:** Approved, resumed from structure stage
```

### 11.2 Global Daily Log

`interactions/YYYY-MM-DD.json` in the dashboard repo. Comprehensive machine-readable log covering human interactions, agent runs, stage transitions, and control commands.

**Entry types:**

| Type | Description | Key fields |
|---|---|---|
| `interaction` | Human message from any surface | source, intent, message, action, stageHints |
| `agent_started` | Agent spawned for a stage | stage, agentName, attempt |
| `agent_completed` | Agent finished successfully | stage, agentName, durationSeconds, tokensUsed, artifactPath |
| `agent_failed` | Agent errored or timed out | stage, agentName, durationSeconds, error |
| `stage_transition` | Task moved between stages | fromStage, toStage |
| `control` | Runtime control command | source, command, targetStage, feedback |

All entries share `timestamp`, `type`, and `slug`.

Example:

```json
[
  {
    "timestamp": "2026-04-05T10:30:00Z",
    "type": "interaction",
    "slug": "fix-auth-bug-20260405103000",
    "source": "cli",
    "intent": "create_task",
    "message": "fix the auth bug in repo-x",
    "action": "task_created"
  },
  {
    "type": "agent_started",
    "timestamp": "2026-04-05T10:30:05Z",
    "slug": "fix-auth-bug-20260405103000",
    "stage": "questions",
    "agentName": "Narada",
    "attempt": 1
  },
  {
    "type": "agent_completed",
    "timestamp": "2026-04-05T10:32:15Z",
    "slug": "fix-auth-bug-20260405103000",
    "stage": "questions",
    "agentName": "Narada",
    "attempt": 1,
    "durationSeconds": 130,
    "tokensUsed": 4200,
    "artifactPath": "01-questions/done/fix-auth-bug/questions-output.md",
    "success": true
  },
  {
    "type": "stage_transition",
    "timestamp": "2026-04-05T10:32:16Z",
    "slug": "fix-auth-bug-20260405103000",
    "fromStage": "questions",
    "toStage": "research"
  },
  {
    "type": "control",
    "timestamp": "2026-04-05T11:15:00Z",
    "slug": "fix-auth-bug-20260405103000",
    "source": "slack",
    "command": "retry",
    "targetStage": "design",
    "feedback": "use microservices instead of monolith"
  }
]
```

Token usage comes from the Agent SDK's result — already available via `AgentRunResult`.

---

## 12. Testing Strategy

### 12.1 Unit Tests

| Module | What's tested |
|---|---|
| `cli-surface.ts` | Arg parsing → correct handler called with correct params |
| `slack-surface.ts` | Message filtering (prefix, bot's own, already-seen), poll loop timing |
| `console-notifier.ts` | NotifyLevel filtering, output format |
| `slack-notifier.ts` | NotifyLevel filtering, thread routing (root vs reply), GitHub link inclusion |
| `intent-classifier.ts` | New intents (cancel, skip, pause, resume, modify-stages, restart-stage, retry), complexity classification, stage hint extraction |
| `slug-resolver.ts` | Exact, prefix, keyword match; ambiguous/no-match cases |
| `interactions.ts` | Per-task markdown format, global JSON append |
| Pipeline control methods | State validation (can't skip a completed task), abort mechanics, retry versioning |
| Quick task path | Classification routing, review hold, escalation to full pipeline |
| Stage hints | Parsing from `.task` file, merging with RunState hints, injection into `buildSystemPrompt` |

### 12.2 Integration Tests

| Test | What it covers |
|---|---|
| CLI → Brahma → inbox | `shkmn task` creates a `.task` file with correct content and hints |
| CLI → Indra → resume | `shkmn approve` resumes a held task |
| CLI → pipeline control | Each control command validates state and transitions correctly |
| Slack poll → classify → handler | End-to-end: message in → classified → correct handler called |
| Notify event → Slack thread | Stage transition → correct message posted as thread reply |
| Retry → versioned artifact | Retry produces `-r1` file, agent receives prior output + feedback |
| Quick path → hold → approve | Quick task → output → held → approved → complete |
| Quick path → escalate | Quick task → held → "full pipeline" → enters QRSPI |

### 12.3 Mocking Strategy

Slack MCP calls are mocked at the MCP boundary. Pipeline, registry, and filesystem are real (using temp directories). Agent runner is mocked — we test routing and control flow, not LLM output.
