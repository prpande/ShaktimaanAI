# Agent-User Communication via AskUser — Design Spec

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Add bidirectional agent-user communication to the ShaktimaanAI pipeline, allowing stage agents to ask clarifying questions mid-execution and resume with the user's answer.

---

## 1. Problem Statement

Currently, once a task enters the pipeline, agents run autonomously through all stages without any ability to ask the user for clarification. If an agent encounters ambiguity — unclear requirements, competing approaches, missing context — it must guess. This leads to wasted work when the guess is wrong, caught only at the review stage or by the user after completion.

The pipeline needs a structured communication channel where agents can pause, ask the user a question (via Slack or CLI), and resume with the answer — without breaking the existing fire-and-forget stage execution model.

## 2. Design Principles

- **Pipeline-orchestrated**: The pipeline owns the ask/wait/resume lifecycle. Agents just call a tool.
- **Centralized Slack access**: No agent reads from Slack directly. The watcher and Astra handle all inbound message routing.
- **Serializable sessions**: Agent state is persisted to disk via SDK session checkpoints. No long-lived processes.
- **Non-blocking**: Only the asking task pauses. Other tasks continue.
- **Configurable**: Which stages can ask questions is controlled via config. The feature has a global kill switch.

## 3. The AskUser Tool

A synthetic tool registered in the agent runner, available only to stages listed in `config.userQuestions.enabledStages`.

### Tool Definition

```typescript
{
  name: "AskUser",
  description: "Ask the user a question via Slack and wait for their response. Use when you encounter ambiguity that would significantly affect your output quality.",
  input_schema: {
    question: string,       // The question to ask
    context: string,        // Why you're asking (shown to user)
    options?: string[]      // Optional multiple-choice options
  }
}
```

### Interception Flow

The agent runner registers `AskUser` as an allowed tool for configured stages. When the SDK emits a `tool_use` block with `name: "AskUser"`, the runner intercepts it before execution:

1. Extracts the `tool_use_id`, question, context, and options from the tool call
2. Saves a session checkpoint to disk (see Section 4)
3. Throws a custom `AskUserInterrupt` error that the stage runner catches

The stage runner then handles the hold/outbox/state transition.

### Agent Prompt Guidance

Added to the system prompt of enabled stage agents:

```
You have access to the AskUser tool. Use it when:
- A requirement is ambiguous and guessing wrong would waste significant work
- You need to choose between meaningfully different approaches
- Critical information is missing from the task or prior stage outputs

When asking questions:
- Batch all your questions into a single AskUser call. Do not ask one question
  at a time if you have multiple. Gather all your unknowns first, then ask
  them together in one well-structured message.
- Number your questions so the user can respond to each clearly.
- Provide multiple-choice options where possible to make responding easy.

Do NOT use it for:
- Minor stylistic preferences you can make a reasonable default on
- Questions already answered in the task description or prior artifacts
- Validation that can wait until the review stage
- Information discoverable from the codebase — search the code, read docs,
  and explore the repo before asking the user. Only ask when you've exhausted
  what the codebase can tell you.
```

## 4. Session Checkpoint & Resume

When `AskUser` is intercepted, the runner persists everything needed to resume the agent exactly where it left off. The Claude Agent SDK supports session serialization via `getSessionMessages(sessionId)` and session resumption via `query({ options: { resume: sessionId } })` with tool result injection through `parent_tool_use_id`.

### Checkpoint Structure

```typescript
interface StageCheckpoint {
  slug: string;
  stage: string;
  sdkSessionId: string;
  pendingToolCall: {
    tool_use_id: string;      // The AskUser tool_use block ID
    tool_name: "AskUser";
    input: {
      question: string;
      context: string;
      options?: string[];
    };
  };
  questionMessageTs: string | null;  // Set after Slack send (for reply matching)
  askCount: number;                   // How many AskUser calls so far this stage run
  costUsdSoFar: number;
  turnsSoFar: number;
  savedAt: string;                    // ISO timestamp
}
```

### File Location

Stored alongside stage artifacts:

```
artifacts/{stage}-checkpoint.json
```

### Resume Flow

1. Watcher detects user reply, writes `.control` file: `{ operation: "resume_stage", slug, stage, answer: "user's reply text" }`
2. Stage runner loads checkpoint from disk
3. Calls `query({ options: { resume: checkpoint.sdkSessionId } })` with the user's answer injected as the tool result:
   ```typescript
   {
     type: 'user',
     parent_tool_use_id: checkpoint.pendingToolCall.tool_use_id,
     tool_use_result: {
       status: "success",
       answer: "The user's reply text from Slack"
     }
   }
   ```
4. Agent continues — sees the tool result as if `AskUser` returned normally
5. Checkpoint file is deleted on successful resume
6. If agent calls `AskUser` again, the cycle repeats (new checkpoint, new hold, `askCount` increments)

### Crash Recovery

If the process dies while a task is on hold, the checkpoint file persists on disk. On restart, `recovery.ts` scans for checkpoint files in `12-hold/` directories with `holdReason: "awaiting_user_response"` and re-registers the pending question with the watcher for reply matching.

## 5. Hold State Extension

The existing hold mechanism is extended to support the `awaiting_user_response` state.

### RunState Changes

```typescript
// Extended HoldReason
type HoldReason = "approval_required" | "budget_exhausted" | "awaiting_user_response";

// New fields on RunState when holdReason is "awaiting_user_response":
{
  holdReason: "awaiting_user_response",
  holdDetail: "design agent asking: 'Should we use REST or GraphQL?'",
  pausedAtStage: "design",
  pendingQuestion: {
    checkpointPath: string;      // Path to stage-checkpoint.json
    questionMessageTs: string;   // Slack message ts for reply matching
    askedAt: string;             // ISO timestamp
    askCount: number;            // Total AskUser calls this stage run
  }
}
```

### Task Directory Movement

- When `AskUser` fires: task moves from `{stage}/pending/` to `12-hold/`
- When user replies and stage resumes: task moves from `12-hold/` to `{stage}/pending/`
- Stage runner then picks it up via the normal `resumeStage()` path

### Status Visibility

`shkmn status` shows held tasks with pending question detail:

```
task-xyz    HOLD  (awaiting_user_response)  design
  → "Should we use REST or GraphQL? (asked 12m ago)"
```

### Notification

The `SlackNotifier` emits a `task_held` event with `holdReason: "awaiting_user_response"` so the user gets a Slack notification that the task is waiting on them, in addition to the question message itself.

## 6. Watcher Reply Routing via Astra

AskUser does not add a new watcher-side pre-triage path for agent-question replies. Existing watcher special-cases that already run before Astra (for example, approval handling) remain unchanged. For inbound messages that are not consumed by those existing pre-Astra paths, the normal flow through Astra continues, and Astra gains awareness of pending agent questions so it can correctly route user answers.

### Astra Context Enrichment

When there are tasks on hold with pending questions, the watcher builds a summary for Astra and appends it to the normal triage input:

```
## Pending Agent Questions

The following tasks are waiting for user responses. If the inbound message
is answering one of these, return action "question_reply" with the matching
slug in your response.

1. Task: task-api-refactor-20260410120000 (slug)
   Stage: design (Vishwakarma)
   Asked: "Should we use REST or GraphQL? And should we support pagination
   from day one?" (12m ago)
   Thread: #proj-channel, thread_ts 1712719200.123456

2. Task: task-auth-migration-20260410130000 (slug)
   Stage: questions (Narada)
   Asked: "1. Should we migrate existing sessions or invalidate them?
   2. Is SAML support required or just OIDC?" (3m ago)
   Thread: #proj-channel, thread_ts 1712719800.456789
```

### Updated Astra Output Schema

```typescript
{
  action: "answer" | "route_pipeline" | "control_command" | "question_reply" | "clarify_task" | "clarify_question_target",
  slug?: string,                // Required when action is "question_reply"
  clarificationText?: string    // Required when action is "clarify_task" or "clarify_question_target"
}
```

### New Astra Actions

**`question_reply`**: Astra determines the message is a reply to a pending agent question. Returns the matching `slug`. Watcher writes `.control` file to resume that task's stage.

**`clarify_task`**: Astra determines the inbound message is a new task request but too ambiguous to route properly. Returns a `clarificationText` to post back to the user. The user's follow-up reply goes through Astra again with the original message + clarification context. Once Astra has enough info, it returns `route_pipeline`.

**`clarify_question_target`**: Astra detects a reply that could match multiple pending questions and cannot determine which one. Returns a `clarificationText` listing the candidate tasks/questions. The user's follow-up reply goes through Astra again, which should now resolve it to `question_reply` with a slug.

### Astra Routing Priority

1. Clear thread match + topic match → `question_reply` with slug
2. Thread match but ambiguous which task → `clarify_question_target`
3. New task request but ambiguous → `clarify_task`
4. No match to any pending question → normal triage (`answer`, `route_pipeline`, `control_command`)

### Watcher's Role

Minimal — context assembly and action dispatch only:

- On startup and after any hold state change: rebuild pending questions list from all tasks in `12-hold/` with `holdReason: "awaiting_user_response"`
- Pass this list as context to Astra on every triage call
- Dispatch based on Astra's returned action (write `.control` file, post clarification to outbox, or proceed with normal triage handling)

## 7. Reply Content Analysis

When the user replies to an agent's question, they may include additional guidance, scope changes, or new hints beyond the direct answer. The agent captures and persists these.

### Agent Instruction

Added to the agent prompt for stages with `AskUser` enabled:

```
After receiving a reply via AskUser:
- Analyze the user's response for:
  1. Direct answer to your question(s) — use this to continue your work
  2. New hints or guidance — if the user mentions preferences, constraints, or
     approaches that would help downstream stages, write them to
     artifacts/stage-hints-update.md so they propagate forward
  3. Scope changes — if the user is adding, removing, or modifying requirements
     beyond your question, capture these as task updates in
     artifacts/task-amendment.md
```

### Stage Hints Update

Agent writes `artifacts/stage-hints-update.md` when the reply contains guidance useful for downstream stages:

```markdown
## Hints added during design (from user Q&A)
- User wants event-driven architecture, not polling
- Must support multi-tenant isolation at the DB level
```

The pipeline reads this after stage completion and merges into `RunState.stageHints` for downstream stages.

### Task Amendment

Agent writes `artifacts/task-amendment.md` when the user's reply materially changes the task scope:

```markdown
## Task Amendment (from design Q&A)
- Added requirement: SAML support in addition to OIDC
- Removed: mobile-first constraint (user confirmed desktop-only for v1)
```

The pipeline appends this to the task's context so all subsequent stages see the updated requirements.

Both outputs are optional — if the reply is a clean answer, the agent continues without writing either file.

## 8. Slack Message Formatting

### Agent Question Format

```
🤖 [ShaktimaanAI] 🔵 Vishwakarma (design) needs your input on task-api-refactor:

"The spec mentions both REST and GraphQL endpoints.

1. Should I design for both, or pick one?
   a) REST only — simpler, faster to implement
   b) GraphQL only — flexible for frontend
   c) Both — with REST as primary

2. Should pagination be built in from day one?"

Reply to this message to answer.
```

Components:
- `outboundPrefix` ("🤖 [ShaktimaanAI]") — existing prefix, ensures the watcher filters out its own messages
- Blue circle emoji — visual indicator this is a question needing response
- Agent mythological name + stage — e.g., "Vishwakarma (design)"
- Task slug — so user knows which task
- Question body — from the `AskUser` tool call
- Reply prompt — clear call to action

### Disambiguation Format (from Astra)

```
🤖 [ShaktimaanAI] ❓ I'm not sure which question your reply is for:

1. task-api-refactor (design — Vishwakarma): "Should we use REST or GraphQL?"
2. task-auth-migration (questions — Narada): "Migrate sessions or invalidate?"

Reply with the number or task name.
```

### Implementation

The `SlackNotifier` gets a new `agent_question` event type. The question formatting logic lives in the notifier — the agent runner passes raw question data through the outbox entry.

## 9. Configuration

Controlled through `shkmn.config.json`, validated by Zod schema.

### New Config Fields

```typescript
{
  userQuestions: {
    // Global kill switch. If false, AskUser tool is never registered.
    enabled: boolean,

    // Which stages can call AskUser. Empty array = feature disabled.
    enabledStages: string[],
  }
}
```

### Defaults

```typescript
{
  userQuestions: {
    enabled: true,
    enabledStages: ["design", "structure", "plan"],
  }
}
```

- `design`, `structure`, `plan`: alignment stages where user input most impacts output quality
- `questions`, `research`: excluded — these stages should work autonomously with what's available
- `impl`, `validate`, `review`, `pr`: excluded — execution stages should work with the established plan

**Note on Astra**: Astra's `clarify_task` action is separate from the `AskUser` tool. Astra does not call `AskUser` — it returns `clarify_task` as a triage action, and the watcher posts the clarification. This is configured via Astra's prompt, not via `enabledStages`. The `userQuestions.enabled` global toggle also controls whether Astra's `clarify_task` action is available.

### Flow

- Agent runner checks `config.userQuestions.enabled` and whether the current stage is in `enabledStages`
- If yes: registers `AskUser` in the agent's tool list and adds User Communication prompt guidance to the agent's system prompt
- If no: `AskUser` is never registered — the agent doesn't know it exists

## 10. CLI Interaction Modes

Two paths based on how the pipeline is running.

### Foreground Mode (`shkmn start` in a terminal)

When `process.stdin.isTTY && !config.daemon`:

- Agent calls `AskUser` → stage runner detects foreground mode
- Question displayed directly in terminal:
  ```
  ┌─────────────────────────────────────────────────
  │ 🔵 Vishwakarma (design) — task-api-refactor
  │
  │ The spec mentions both REST and GraphQL endpoints.
  │
  │ 1. Should I design for both, or pick one?
  │    a) REST only — simpler, faster to implement
  │    b) GraphQL only — flexible for frontend
  │    c) Both — with REST as primary
  │
  │ 2. Should pagination be built in from day one?
  └─────────────────────────────────────────────────
  Your answer: █
  ```
- User types response → injected directly as tool result → agent resumes immediately
- No hold state, no checkpoint serialization, no Slack round-trip
- If Slack notifications are enabled, the Q&A is posted to Slack after the fact for the thread record

### Background/Daemon Mode (`shkmn watch` or detached)

Full async flow as described in Sections 4-6:

- Checkpoint → hold → Slack question → watcher detects reply via Astra → resume

Additionally, the `shkmn answer` command provides a local CLI alternative:

```bash
# See pending questions
shkmn status --questions

# Answer a specific task's question
shkmn answer task-api-refactor "Use REST for v1, add GraphQL later"
```

`shkmn answer` writes the same `.control` file as the watcher: `{ operation: "resume_stage", slug, stage, answer }`.

### Race Condition: Slack + CLI Answer

If the user answers via both Slack and CLI, the first one wins. The second is ignored because the checkpoint has already been consumed and the task is no longer in `12-hold/`.

### Slack Thread Record from CLI

In foreground mode, after the Q&A completes, the stage runner writes a summary to the Slack outbox for thread continuity:

```
🤖 [ShaktimaanAI] 📝 Vishwakarma (design) asked a question (answered via CLI):

Q: "Should we use REST or GraphQL?"
A: "Use REST for v1, add GraphQL later"
```

## 11. Agent Prompt Updates

### Enabled Stage Agents (design, structure, plan)

Common block added to `agents/design.md`, `agents/structure.md`, `agents/plan.md`:

```markdown
## User Communication

You can ask the user questions via the AskUser tool when you hit genuine
ambiguity that the codebase and prior artifacts cannot resolve.

### Before asking:
- Search the codebase thoroughly — read relevant files, grep for patterns
- Check all prior stage artifacts for answers
- Check the task description, context, and stage hints
- Only ask when you've exhausted what's available to you

### When asking:
- Batch all your questions into a single AskUser call
- Number your questions for easy reference
- Provide multiple-choice options where possible
- Include brief context for why you're asking (what decision it unblocks)

### After receiving a reply:
- If the user's response includes new guidance, preferences, or constraints
  useful for downstream stages, write them to artifacts/stage-hints-update.md
- If the user materially changes scope (adds/removes requirements), write
  the changes to artifacts/task-amendment.md
- Then continue your work incorporating the answer

### Do NOT ask about:
- Minor stylistic choices you can make a reasonable default on
- Things already answered in task description or prior artifacts
- Information discoverable from the codebase
- Validation that can wait for the review stage
```

### Astra (Quick-Triage Agent)

Added to `agents/quick-triage.md`:

```markdown
## Task Clarity Check

Before routing a message to the pipeline, assess whether the request is
clear enough to produce a well-defined task. If the intent, scope, or
target is ambiguous, return clarify_task with a question that resolves
the ambiguity. Do not create vague tasks that will waste pipeline stages.

When the user replies to your clarification, check if their response
includes additional context or hints beyond the direct answer. If so,
include these as stageHints in the task metadata when routing to the pipeline.
```

### Unchanged Agents

No changes to: questions, research, impl, validate, review, pr, slack-io (Narada), recovery (Chiranjeevi).

## 12. End-to-End Flow

Complete lifecycle of an agent asking a question:

```
1. Design agent (Vishwakarma) hits ambiguity during stage execution
   ├─ Searches codebase, reads prior artifacts — can't resolve it
   └─ Calls AskUser({ question: "REST or GraphQL?", context: "...", options: [...] })

2. Agent runner intercepts the AskUser tool call
   ├─ Saves StageCheckpoint to artifacts/{stage}-checkpoint.json
   │   (sdkSessionId, pendingToolCall with tool_use_id, costSoFar, turns)
   └─ Throws AskUserInterrupt — stage runner catches it

3. Stage runner handles the interrupt
   ├─ Writes question to slack-outbox.jsonl (branded format, thread_ts from task)
   ├─ Updates RunState: holdReason="awaiting_user_response", pendingQuestion={...}
   ├─ Moves task directory to 12-hold/
   └─ Emits task_held notification + agent_question notification

4. Narada sends the outbox (triggered by watcher)
   ├─ Posts branded question to Slack thread
   ├─ Returns message ts
   └─ Checkpoint updated with questionMessageTs

5. User sees the question in Slack, replies

6. Watcher polls Slack, picks up the reply
   ├─ Builds pending questions context from all held tasks
   ├─ Sends message + pending questions context to Astra
   └─ Astra returns: question_reply (slug: task-api-refactor)

7. Watcher writes .control file
   { operation: "resume_stage", slug: "task-api-refactor", stage: "design",
     answer: "Use REST for v1, we'll add GraphQL later" }

8. Pipeline processes .control file → resumeStage()
   ├─ Moves task from 12-hold/ → 03-design/pending/
   ├─ Loads checkpoint from artifacts/{stage}-checkpoint.json
   ├─ Calls query({ options: { resume: checkpoint.sdkSessionId } }) with user's answer as tool result
   │   linked via parent_tool_use_id
   └─ Deletes checkpoint file

9. Design agent resumes with full context
   ├─ Sees AskUser tool returned: { status: "success", answer: "Use REST..." }
   ├─ Checks if reply contains new hints → writes stage-hints-update.md if yes
   ├─ Continues design work with the answer
   └─ May call AskUser again if needed (cycle repeats from step 2)

10. Stage completes normally
    ├─ Pipeline merges any stage-hints-update.md into RunState.stageHints
    ├─ Pipeline appends any task-amendment.md to task context
    └─ Moves to next stage as usual
```

### Failure & Edge Cases

- **Process crash while on hold**: Checkpoint persists on disk. On restart, recovery scans `12-hold/` for tasks with `awaiting_user_response`, rebuilds pending question map.
- **User never replies**: Task stays on hold indefinitely. `shkmn status` shows it. No timeout — user can manually cancel or the task ages out per existing policy.
- **Multiple AskUser calls in one stage**: Each creates a new checkpoint, overwriting the previous. The cycle repeats. `askCount` increments for observability.
- **Astra can't determine target**: Returns `clarify_question_target`, watcher posts disambiguation question, user's next reply re-enters Astra triage.
- **Race — Slack + CLI answer**: First one wins. Second is ignored (checkpoint already consumed, task no longer in hold).

## 13. Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/core/ask-user.ts` | `AskUser` tool definition, `AskUserInterrupt` error class, `StageCheckpoint` type, checkpoint save/load functions |
| `src/commands/answer.ts` | `shkmn answer <slug> <text>` CLI command — writes `.control` file to resume a held stage |

### Modified Files

| File | Change |
|------|--------|
| `src/core/agent-runner.ts` | Register `AskUser` tool for enabled stages, intercept tool call, serialize checkpoint |
| `src/core/stage-runner.ts` | Catch `AskUserInterrupt`, handle foreground (interactive prompt) vs background (hold) paths, `resumeStage()` with SDK session resume |
| `src/core/pipeline.ts` | Process `resume_stage` control action, move task hold→pending on resume, merge stage-hints-update and task-amendment after stage completion |
| `src/core/recovery.ts` | Scan `12-hold/` for `awaiting_user_response` tasks with checkpoint files on restart |
| `src/core/watcher.ts` | Build pending questions context for Astra, handle `question_reply`, `clarify_task`, and `clarify_question_target` actions |
| `src/config/defaults.ts` | Add `userQuestions` defaults, add `AskUser` to tool permissions for enabled stages |
| `src/config/schema.ts` | Zod schema for `userQuestions` config block |
| `src/core/types.ts` | Extend `HoldReason` union, add `pendingQuestion` to `RunState` |
| `src/surfaces/types.ts` | Add `agent_question` notify event type |
| `src/surfaces/slack-notifier.ts` | Format `agent_question` events with branded question template |
| `src/surfaces/console-notifier.ts` | Display questions in terminal for foreground mode awareness |
| `src/core/slack-queue.ts` | Add `agent_question` outbox entry type with question metadata |
| `agents/design.md` | Add User Communication prompt block |
| `agents/structure.md` | Add User Communication prompt block |
| `agents/plan.md` | Add User Communication prompt block |
| `agents/quick-triage.md` | Add Task Clarity Check block, `clarify_task` action, pending questions context handling, `question_reply` action |
| `src/commands/status.ts` | Show pending questions in `shkmn status` output, add `--questions` flag |
| `src/commands/index.ts` | Register `answer` command |

### Unchanged

- `agents/slack-io.md` (Narada) — still just reads outbox and sends
- `agents/questions.md`, `agents/research.md` — no AskUser access
- `agents/impl.md`, `agents/validate.md`, `agents/review.md`, `agents/pr.md` — no AskUser access
- `agents/recovery.md` (Chiranjeevi) — unchanged

## 14. Future — Agent-Driven Validation Suite

A separate spec will define a Claude-driven validation command (similar to `/pipeline-diagnostics`) that exercises the full `AskUser` flow end-to-end from within a Claude session, using real MCP tools and live Slack. This spec covers only the core feature design.
