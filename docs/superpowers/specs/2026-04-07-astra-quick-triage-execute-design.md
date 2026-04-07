# Spec: Astra — Quick Triage & Execute Agent

**Date:** 2026-04-07
**Status:** Draft
**Replaces:** `classifyByKeywords()`, `classifyByLLM()`, `agents/classify.md`, `agents/quick.md`, `startQuickRun()`

---

## 1. Problem

Every incoming Slack message currently goes through a fragile keyword matcher (`classifyByKeywords`) that either matches a control command or defaults to creating a full 9-stage pipeline task. There is no path for:

- Answering simple questions directly (e.g., "what's the endpoint structure in this repo?")
- Performing lightweight tasks without a pipeline (e.g., "rewrite this message professionally")
- Intelligently selecting which pipeline stages are actually needed
- Providing enriched context to downstream agents (Brahma) to avoid duplicate discovery

The existing quick agent (Astra) is only reachable via a literal `quick:` prefix. The LLM classifier (Sutradhaar) is a fallback that often returns `create_task` with no stage guidance, leading to unnecessary full pipeline runs.

## 2. Solution

Replace the keyword classifier + separate quick agent with a single LLM-driven agent (**Astra**) that acts as the universal first responder for all incoming messages. Astra uses an agent/subagent architecture:

- **Triage phase** (Haiku): Classifies intent, gathers repo context, decides whether to answer directly, route to pipeline, or handle a control command.
- **Execute phase** (Sonnet subagent): Spawned internally by Astra when it decides to handle a task directly. Has full tool access to answer questions, perform quick tasks, update external systems, and respond in Slack.

From the orchestrator's perspective, this is a single agent call to the `quick` stage. The subagent is internal to Astra.

## 3. Architecture

### 3.1 Agent Identity

- **Stage identifier:** `quick` (unchanged)
- **Display name:** "Astra" (in `DEFAULT_AGENT_NAMES` config only)
- **Prompt files:** Two files for independent tuning
  - `agents/quick-triage.md` — Haiku triage instructions, JSON output schema, escalation criteria
  - `agents/quick-execute.md` — Sonnet subagent instructions, tool usage, output format

### 3.2 Three Exit Paths

| Decision | What Astra does | Narada involved? |
|---|---|---|
| **Control command** (approve, cancel, pause, resume, skip, retry, etc.) | Haiku returns parsed command to watcher | Only for error notifications |
| **Direct answer / quick task** | Haiku spawns Sonnet subagent; subagent does the work end-to-end; response written to outbox; Narada triggered to send | Yes (sends the response) |
| **Pipeline routing** | Haiku returns recommended stages, enriched context, stage hints, repo summary to watcher; watcher passes to Brahma | Yes (pipeline notifications) |

### 3.3 Tool Access

| Phase | Tools |
|---|---|
| **Triage (Haiku)** | Read, Glob, Grep, Bash (`gh`), WebSearch, WebFetch, Notion MCP (read), Slack MCP (read), ADO (read) |
| **Execute (Sonnet)** | Full — Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Notion MCP (all), Slack MCP (all), ADO (all) |

Triage is read-only across all external systems. Execute gets full read+write to everything — local files, Slack, Notion, ADO, GitHub.

### 3.4 Model Configuration

| Phase | Model | Max Turns | Timeout |
|---|---|---|---|
| Triage | Haiku | 5 | 2 min |
| Execute | Sonnet | 40 | 30 min |

## 4. Data Flow

### 4.1 Watcher Input to Astra

```typescript
interface AstraInput {
  message: string;         // raw Slack message text
  threadTs?: string;       // Slack thread timestamp for context lookup
  channelId: string;       // source channel
  userId: string;          // sender
  source: "slack" | "cli"; // how the message arrived
}
```

### 4.2 Triage Output Schema

```typescript
interface AstraTriageResult {
  // Decision
  action: "answer" | "route_pipeline" | "control_command";

  // Control command path
  controlOp?: "approve" | "cancel" | "skip" | "pause" |
              "resume" | "modify_stages" | "restart_stage" | "retry";
  extractedSlug?: string;

  // Pipeline routing path
  recommendedStages?: string[];
  stageHints?: Record<string, string>;
  enrichedContext?: string;   // summary of what Astra discovered during triage
  repoSummary?: string;      // repo structure/context for Brahma to reuse

  // Metadata
  confidence: number;
  reasoning: string;          // brief explanation of the decision
}
```

### 4.3 Flow Per Path

**Direct answer path:**
```
Watcher → Astra (Haiku triage)
  → Astra spawns subagent (Sonnet, full tools)
    → Subagent reads repos/Notion/ADO/Slack threads as needed
    → Subagent performs actions (update Notion, close ADO, etc.)
    → Subagent returns result to Astra
  → Astra writes response to slack-outbox.jsonl
  → Astra returns { action: "answer", completed: true } to watcher
  → Watcher triggers Narada send (on-demand)
  → Watcher logs completion
```

**Pipeline routing path:**
```
Watcher → Astra (Haiku triage)
  → Returns AstraTriageResult with recommendedStages, enrichedContext, repoSummary
  → Watcher passes to Brahma:
    - Original message content
    - Astra's recommendedStages, stageHints, enrichedContext, repoSummary
  → Brahma creates .task file (enriched with Astra's context)
  → .task file lands in 00-inbox → normal pipeline flow
  → Narada handles pipeline Slack notifications
```

**Control command path:**
```
Watcher → Astra (Haiku triage)
  → Returns { action: "control_command", controlOp, extractedSlug }
  → Watcher routes to existing control handlers (same as .control file logic)
```

## 5. Slack I/O Changes

### 5.1 Outbox: On-Demand Sends

Currently, outbox messages wait up to 30 seconds for the next Narada poll cycle. With this change:

- When any agent returns a result that needs Slack notification, the watcher writes to `slack-outbox.jsonl` and **immediately triggers a Narada run**.
- Narada sends the outbox entries and returns.
- Response latency drops from up to 30s to ~2-3s (agent startup time).

### 5.2 Narada: Unified Behavior, Two Triggers

Narada does the same thing every time it runs, regardless of trigger:

1. Send any outbox entries
2. Read channel/DMs for new messages
3. Check approval threads for held tasks
4. Update cursor

**Two triggers:**
- **On-demand:** Watcher triggers after an agent completes (instant outbox send + opportunistic inbox read)
- **Interval:** Adaptive polling (see 5.3) as a background sweep

No separate "modes" in the prompt. Same behavior, same payload, two trigger sources.

### 5.3 Adaptive Polling

The background poll interval adjusts based on pipeline activity:

| Pipeline state | Poll interval | Rationale |
|---|---|---|
| **Active** (tasks in progress) | Longer (e.g., 5 min) | On-demand triggers handle most I/O; poll is just a safety net |
| **Idle** (no tasks) | Shorter (e.g., 45s) | Poll is the only way messages get picked up; be responsive |

```typescript
function getSlackPollInterval(): number {
  const hasActiveTasks = registry.activeCount() > 0;
  return hasActiveTasks
    ? config.slack.pollIntervalActiveSec   // default: 300
    : config.slack.pollIntervalIdleSec;    // default: 45
}
```

The watcher recalculates the interval on each tick.

### 5.4 Crash Recovery

Unchanged. The outbox file serves as a write-ahead log:

1. Write entry to `slack-outbox.jsonl`
2. Trigger Narada send
3. On success: Narada moves entry to `slack-sent.jsonl`
4. On crash: unsent entries remain in outbox, picked up by next Narada run (on-demand or poll)

## 6. Error Handling

**Universal principle: no silent failures.** Every failure that needs user attention gets a Slack message.

The watcher exposes a `notifySlackError(channel, threadTs, message)` utility that writes to outbox and triggers an immediate Narada send. Used consistently across all failure paths.

| Failure | Slack notification | Auto-retry? |
|---|---|---|
| **Triage fails** (Haiku error / invalid JSON) | "I couldn't process your message — retrying." | Yes, up to N retries |
| **Triage fails after N retries** | "I'm unable to understand this message after multiple attempts. Could you rephrase?" | No, message skipped |
| **Subagent fails** (Sonnet error mid-task) | "I ran into a problem while working on that — [brief reason]. Let me know if you'd like me to try again." | No, awaits user |
| **Repo access fails** | "I can't access [repo name] — check permissions or provide the full path." | No, awaits user |
| **Control command invalid slug** | "I couldn't find an active task matching that. Here are the current tasks: [list]." | No, awaits user |
| **Narada send fails** | Entry remains in outbox; retried on next Narada run (on-demand or poll) | Yes, automatic |

## 7. What Gets Removed

**Files removed:**
- `agents/classify.md` — replaced by `agents/quick-triage.md`
- `agents/quick.md` — replaced by `agents/quick-execute.md`

**Code removed from `src/core/intent-classifier.ts`:**
- `classifyByKeywords()` — eliminated entirely
- `classifyByLLM()` — absorbed into Astra triage
- `ClassifyResult` interface — replaced by `AstraTriageResult`

**Code removed from `src/core/watcher.ts`:**
- Inline `classifyByKeywords(text)` call in `pollSlack()`
- Manual intent routing logic after classification (the if/else chain)
- Replaced by: call Astra, switch on `result.action`

**Code removed from `src/core/pipeline.ts`:**
- `startQuickRun()` — Astra's subagent handles quick tasks directly

**Config changes in `src/config/defaults.ts`:**
- Remove `classify` entries from `DEFAULT_STAGE_TOOLS` and `STAGE_CONTEXT_RULES`
- Update `quick` entries in `DEFAULT_STAGE_TOOLS` to reflect triage-level tools
- Add `quick-execute` tools/context (used by subagent prompt, not by stage config)
- Remove `quickTask.complexityThreshold` (Astra decides internally)
- Replace `slack.pollIntervalSeconds` with `slack.pollIntervalActiveSec` and `slack.pollIntervalIdleSec`

**Config unchanged:**
- `DEFAULT_AGENT_NAMES` keeps `quick: "Astra"` — single stage identity
- All pipeline stages (questions through pr) — untouched
- Brahma / task-creator — unchanged, receives richer input from Astra
- All Slack file formats (outbox, inbox, sent, threads, cursor) — unchanged
- Control file handling — unchanged

## 8. Example Flows

### 8.1 "Rewrite this message to sound more professional"

```
Slack → Narada (inbox) → Watcher → Astra (Haiku)
  Triage: "Text rewriting, no code, no repo needed."
  → action: "answer"
  → Spawns Sonnet subagent
    → Produces rewritten text
    → Returns to Astra
  → Astra writes response to outbox
  → Watcher triggers Narada send → user sees rewrite in Slack
```

### 8.2 "What is the appointment creation endpoint in the scheduling domain in api.codex?"

```
Slack → Narada (inbox) → Watcher → Astra (Haiku)
  Triage: "Code structure question about external repo. Read-only, no pipeline."
  → action: "answer", repoContextNeeded: true
  → Spawns Sonnet subagent
    → gh repo clone <org>/api.codex --depth=1
    → grep/read scheduling controllers and models
    → Builds structured answer
    → Returns to Astra
  → Astra writes response to outbox
  → Watcher triggers Narada send → user sees endpoint details in Slack
```

### 8.3 "Refactor the retry logic in pipeline.ts to use exponential backoff"

```
Slack → Narada (inbox) → Watcher → Astra (Haiku)
  Triage: "Code change in the main repo. Needs design, implementation, review."
  → action: "route_pipeline"
  → recommendedStages: ["design", "plan", "impl", "validate", "review", "pr"]
  → enrichedContext: "retry.ts has linear backoff, 3 retry functions..."
  → repoSummary: "src/core/retry.ts handles validate/review loops..."
  → Watcher passes to Brahma with enriched context
  → Brahma creates .task file with 6 stages (not all 9)
  → Pipeline runs: design → plan → impl → validate → review → pr
```

### 8.4 "Cancel the auth-migration task"

```
Slack → Narada (inbox) → Watcher → Astra (Haiku)
  Triage: "Control command — cancel."
  → action: "control_command", controlOp: "cancel", extractedSlug: "auth-migration-20260407..."
  → Watcher calls pipeline.cancel(slug)
  → Done
```

### 8.5 "In the above task, also update the error messages" (thread reference)

```
Slack → Narada (inbox) → Watcher → Astra (Haiku)
  Triage: "References a previous thread. Need to read thread for context."
  → Reads slack thread via slack_read_thread MCP
  → Understands "above task" was a pipeline routing for auth refactor
  → action: "route_pipeline"
  → stageHints: { "impl": "Also update error messages for the refactored code" }
  → enrichedContext: "Follow-up to auth-migration task, adding error message updates"
  → Watcher passes enriched context to Brahma
```
