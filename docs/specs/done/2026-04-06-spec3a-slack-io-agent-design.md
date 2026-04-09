# Spec 3a: Slack I/O Agent (Narada) — Design Document

**Version:** 1.0
**Date:** 2026-04-06
**Author:** Pratyush Pande (with Claude)
**Status:** Draft
**Depends on:** Spec 3 (Input Surfaces)

---

## 1. Overview

Spec 3 implemented the Slack integration architecture (notifier types, event formatting, filtering, cursor persistence, slug resolution) but left the actual Slack API calls stubbed. This spec completes the Slack integration by introducing a dedicated Slack I/O agent (Narada) that uses MCP tools to read and write Slack messages.

The key constraint: the user's org does not permit installing custom Slack Bot Apps, so there is no standalone `SLACK_TOKEN`. All Slack access must go through Claude's MCP tools (`mcp__claude_ai_Slack__*`), which are available to Agent SDK subprocesses.

### Scope

- Dedicated Slack I/O agent (Narada) using Haiku model and MCP tools
- File-based message queue (outbox, inbox, sent log, thread map)
- Watcher integration: agent-mediated polling replacing direct REST
- Per-agent model override (`agents.models` config)
- Agent name reassignment: questions agent becomes Gargi, Narada moves to Slack I/O
- Thread round-tripping: tasks from Slack reply in the originating thread
- Approval detection via Slack thread replies
- DM polling support
- Init wizard Slack setup prompts
- Missing `task_approved` event emission
- Cleanup of unused `SLACK_WEBHOOK_URL` and `fetchChannelMessages()`

### Out of Scope

- Slack Bot App / Socket Mode (requires org admin permissions)
- Slack interactive components (buttons, modals)
- Multi-workspace support
- Rich message formatting (Block Kit)

---

## 2. Architecture

### 2.1 Agent-Mediated Slack I/O

The pipeline watcher (`shkmn start`) runs as a standalone Node.js process. MCP tools are not available directly in Node.js — they are available only through Agent SDK subprocesses. Therefore, all Slack I/O is mediated by a dedicated agent (Narada) spawned per poll tick.

```
Outbound:
  Pipeline event ──→ emitNotify ──→ SlackNotifier ──→ append to slack-outbox.jsonl
     ... (next poll tick) ...
  Watcher ──→ spawn Narada (Haiku) ──→ reads outbox ──→ mcp__slack_send_message ──→ updates sent log + threads

Inbound:
  Watcher ──→ spawn Narada (Haiku) ──→ mcp__slack_read_channel ──→ writes slack-inbox.jsonl
     ... (agent completes) ...
  Watcher ──→ reads inbox ──→ filterMessages ──→ classifyByKeywords ──→ .task / .control files

Approvals:
  Watcher ──→ spawn Narada (Haiku) ──→ mcp__slack_read_thread (held task threads) ──→ detects "approved"
     ... (agent completes) ...
  Watcher ──→ reads inbox approvals ──→ .control file { operation: "approve" }
```

### 2.2 Single Agent Call Per Tick

Narada handles all three responsibilities (outbound, inbound, approvals) in a single agent invocation per poll tick. This minimizes API cost — one Haiku call every N seconds instead of separate calls for read/write/approval.

### 2.3 New Files

```
agents/slack-io.md                          ← Narada agent prompt
{runtimeDir}/slack-outbox.jsonl             ← Pending outbound notifications
{runtimeDir}/slack-inbox.jsonl              ← Inbound messages from Narada
{runtimeDir}/slack-sent.jsonl               ← Record of successfully sent messages
{runtimeDir}/slack-threads.json             ← slug → Slack thread_ts mapping
```

### 2.4 Modified Files

| File | Changes |
|---|---|
| `src/config/defaults.ts` | Rename questions→Gargi, add slackIO→Narada, add `agents.models` per-stage map, add `slack.dmUserIds` |
| `src/config/schema.ts` | Add `models` and `dmUserIds` validation |
| `src/surfaces/slack-notifier.ts` | Append to outbox file instead of calling sendMessage, read thread map, support originating slackThread |
| `src/surfaces/types.ts` | Add `slackThread?: string` to `task_created` event |
| `src/core/watcher.ts` | Replace `pollSlack()` with agent-mediated approach, add `slackPollInProgress` guard, post-process inbox/sent/cursor |
| `src/core/pipeline.ts` | Add `task_approved` event emission in `approveAndResume()` |
| `src/core/agent-runner.ts` | Pass `config.agents.models[stage]` to Agent SDK `query()` |
| `src/commands/start.ts` | Remove `sendMessage` stub, SlackNotifier takes `runtimeDir` instead of callback |
| `src/commands/init.ts` | Add Slack setup prompts, remove `SLACK_WEBHOOK_URL` from .env template |
| `src/surfaces/slack-surface.ts` | Remove `fetchChannelMessages()` and `getBotUserId()`, keep filter/strip/cursor utilities |

### 2.5 Removed

| Item | Reason |
|---|---|
| `SLACK_WEBHOOK_URL` in .env template | Never used, won't be — all I/O through MCP |
| `sendMessage` callback in SlackNotifier | Replaced by file-based outbox |
| `fetchChannelMessages()` in slack-surface.ts | Replaced by Narada agent via MCP |
| `getBotUserId()` in slack-surface.ts | Bot identity handled by Narada prompt |

---

## 3. Narada Agent

### 3.1 Agent File

**Path:** `agents/slack-io.md`

**Tools allowed:** `mcp__claude_ai_Slack__*`, `Read`, `Write`

**Model:** `haiku` (configured via `agents.models["slack-io"]`)

**Timeout:** 2 minutes

**Max turns:** 15

### 3.2 Input Contract

Narada receives a structured JSON payload as its task content:

```json
{
  "outbox": [
    {
      "id": "evt-1717689600000-abc123",
      "slug": "fix-auth-bug-20260406",
      "type": "task_created",
      "channel": "C0123456789",
      "text": "🚀 *Task created:* fix-auth-bug-20260406 | stages: questions → research → impl",
      "thread_ts": null
    }
  ],
  "inbound": {
    "channelId": "C0123456789",
    "oldest": "1717689500.000000",
    "dmUserIds": ["U111", "U222"],
    "dmOldest": "1717689500.000000"
  },
  "approvalChecks": [
    {
      "slug": "fix-auth-bug-20260406",
      "thread_ts": "1717689601.000100"
    }
  ],
  "files": {
    "outbox": "/path/to/runtime/slack-outbox.jsonl",
    "inbox": "/path/to/runtime/slack-inbox.jsonl",
    "sent": "/path/to/runtime/slack-sent.jsonl",
    "threads": "/path/to/runtime/slack-threads.json",
    "cursor": "/path/to/runtime/slack-cursor.json"
  }
}
```

### 3.3 Narada's Responsibilities

**Step 1 — Send outbox messages:**
1. Read `slack-outbox.jsonl`
2. For each entry, call `mcp__claude_ai_Slack__slack_send_message` with `channel`, `text`, `thread_ts`
3. After each successful send, append to `slack-sent.jsonl`:
   ```json
   {"id": "evt-1717689600000-abc123", "slug": "fix-auth-bug-20260406", "ts": "1717689601.000100", "sentAt": "2026-04-06T10:00:01Z"}
   ```
4. If the event type is `task_created`, update `slack-threads.json` with `slug → ts` mapping
5. After processing all entries, re-write `slack-outbox.jsonl` with only the entries that failed to send (i.e., entries whose `id` does not appear in the sent log). If all entries were sent, write an empty file.

**Step 2 — Read inbound messages:**
1. Call `mcp__claude_ai_Slack__slack_read_channel` with `channelId` and `oldest` timestamp
2. If `dmUserIds` is non-empty, call `mcp__claude_ai_Slack__slack_read_channel` for each user ID with `dmOldest`
3. Write new messages to `slack-inbox.jsonl`:
   ```json
   {"ts": "1717689700.000200", "text": "shkmn fix the login bug", "user": "U456", "thread_ts": null, "channel": "C0123456789"}
   ```

**Step 3 — Check approval threads:**
1. For each entry in `approvalChecks`, call `mcp__claude_ai_Slack__slack_read_thread` with `message_ts`
2. Look for replies containing approval keywords: "approved", "approve", "lgtm", "looks good", "ship it"
3. If found, write to `slack-inbox.jsonl` with `isApproval` flag:
   ```json
   {"ts": "1717689800.000300", "text": "approved", "user": "U789", "thread_ts": "1717689601.000100", "channel": "C0123456789", "isApproval": true, "slug": "fix-auth-bug-20260406"}
   ```

**Step 4 — Update cursor:**
1. Update `slack-cursor.json` with the newest `ts` processed for both channel and DMs

### 3.4 Error Handling

- If a `slack_send_message` call fails, leave the entry in the outbox for retry next cycle
- If `slack_read_channel` fails, write an empty inbox and report the error in output
- If `slack_read_thread` fails for a specific thread, skip it and try next cycle
- Narada never crashes the pipeline — errors are reported in output, not thrown

---

## 4. File-Based Message Queue

### 4.1 Outbox — `slack-outbox.jsonl`

Each line is a pending outbound notification:

```jsonl
{"id": "evt-1717689600000-abc123", "slug": "fix-auth-20260406", "type": "task_created", "channel": "C0123456789", "text": "🚀 *Task created:* ...", "thread_ts": null, "addedAt": "2026-04-06T10:00:00.000Z"}
{"id": "evt-1717689605000-def456", "slug": "fix-auth-20260406", "type": "stage_started", "channel": "C0123456789", "text": "▶️ *Stage started:* ...", "thread_ts": "1717689601.000100", "addedAt": "2026-04-06T10:00:05.000Z"}
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique event ID: `evt-{Date.now()}-{random6}` |
| `slug` | string | Task slug for thread mapping |
| `type` | string | NotifyEvent type (task_created, stage_started, etc.) |
| `channel` | string | Slack channel ID to post to |
| `text` | string | Formatted message text |
| `thread_ts` | string \| null | Thread to reply in, or null for root message |
| `addedAt` | string | ISO timestamp when queued |

### 4.2 Inbox — `slack-inbox.jsonl`

Written by Narada, read by watcher:

```jsonl
{"ts": "1717689700.000200", "text": "shkmn fix the login bug", "user": "U456", "thread_ts": null, "channel": "C0123456789"}
{"ts": "1717689800.000300", "text": "approved", "user": "U789", "thread_ts": "1717689601.000100", "channel": "C0123456789", "isApproval": true, "slug": "fix-auth-20260406"}
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `ts` | string | Slack message timestamp |
| `text` | string | Message text |
| `user` | string | Slack user ID |
| `thread_ts` | string \| undefined | Parent thread timestamp (if thread reply) |
| `channel` | string | Channel ID where message was read |
| `isApproval` | boolean \| undefined | True if Narada detected approval intent |
| `slug` | string \| undefined | Task slug (set when isApproval is true) |

### 4.3 Sent Log — `slack-sent.jsonl`

Record of successfully sent messages for deduplication:

```jsonl
{"id": "evt-1717689600000-abc123", "slug": "fix-auth-20260406", "ts": "1717689601.000100", "sentAt": "2026-04-06T10:00:01.000Z"}
```

### 4.4 Thread Map — `slack-threads.json`

Maps task slugs to Slack thread timestamps:

```json
{
  "fix-auth-20260406": "1717689601.000100",
  "add-logging-20260406": "1717689701.000200"
}
```

**Written by:** Narada (after sending `task_created` and getting back a `ts`)
**Read by:** SlackNotifier (to set `thread_ts` on subsequent events for the same slug)

### 4.5 Cursor — `slack-cursor.json`

Existing file, unchanged format:

```json
{
  "channelTs": "1717689800.000300",
  "dmTs": "1717689800.000300"
}
```

---

## 5. Config Changes

### 5.1 Agent Names

| Role | Old Name | New Name |
|---|---|---|
| Questions agent | Narada | **Gargi** |
| Slack I/O agent | *(new)* | **Narada** |

All other agent names unchanged.

### 5.2 Per-Stage Model Override

New field `agents.models` in config:

```json
{
  "agents": {
    "models": {
      "questions": "sonnet",
      "research": "opus",
      "design": "opus",
      "structure": "sonnet",
      "plan": "opus",
      "impl": "opus",
      "review": "sonnet",
      "validate": "sonnet",
      "pr": "sonnet",
      "classify": "haiku",
      "slack-io": "haiku",
      "quick": "sonnet"
    }
  }
}
```

**Schema:** `models` is an optional `Record<string, string>`, default as above. Merged with defaults same as `maxTurns` and `timeoutsMinutes`. Stages without an entry inherit the model from the parent Claude Code session / Agent SDK default.

**Agent runner change:** `runAgent()` reads `config.agents.models[stage]` and passes it to Agent SDK `query()` as the `model` parameter.

### 5.3 DM User IDs

New field `slack.dmUserIds`:

```json
{
  "slack": {
    "dmUserIds": ["U0123456789", "U9876543210"]
  }
}
```

**Schema:** Optional `z.array(z.string())`, default `[]`. When `allowDMs` is true and `dmUserIds` is non-empty, Narada polls these users' DMs. When `allowDMs` is true but `dmUserIds` is empty, the watcher logs a warning and skips DM polling.

### 5.4 Slack I/O Stage Config

New entries in existing per-stage maps:

```typescript
// defaults.ts additions
DEFAULT_STAGE_TOOLS["slack-io"] = {
  allowed: ["mcp__claude_ai_Slack__*", "Read", "Write"],
  disallowed: ["Edit", "Bash", "Glob", "Grep"],
};

STAGE_CONTEXT_RULES["slack-io"] = {
  includeTaskContent: true,
  previousOutputLabel: null,
  includeRepoContext: false,
};

// In DEFAULT_CONFIG.agents:
maxTurns: { ..., "slack-io": 15 },
timeoutsMinutes: { ..., "slack-io": 2 },
```

---

## 6. SlackNotifier Redesign

### 6.1 Constructor Change

**Before (Spec 3):**
```typescript
interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  sendMessage: (params: { channel: string; text: string; thread_ts?: string }) => Promise<{ ts: string }>;
}
```

**After:**
```typescript
interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  runtimeDir: string;
}
```

The notifier no longer takes a `sendMessage` callback. Instead it appends formatted events to the outbox file.

### 6.2 Outbox Append

When `notify(event)` is called:
1. Check `shouldNotify(notifyLevel, event)` — skip if filtered
2. Format event text via `formatEvent(event)` (unchanged)
3. Resolve `thread_ts`:
   - Read `slack-threads.json` (default to empty `{}` if file does not exist)
   - If slug exists in thread map → use that `ts`
   - If event is `task_created` with `slackThread` field → use originating thread
   - Otherwise → `null` (will be posted as root message)
4. Generate unique `id`: `evt-${Date.now()}-${random6chars}`
5. Append JSON line to `slack-outbox.jsonl`

### 6.3 Thread Round-Tripping

When a task originates from Slack (has `slackThread` in metadata):
- The `task_created` NotifyEvent includes `slackThread` field
- SlackNotifier uses this as `thread_ts` for the first notification
- Narada sends it as a reply in the originating Slack thread
- The returned `ts` is stored in `slack-threads.json`
- All subsequent events for this slug reply in the same thread

When a task originates from CLI or dashboard (no `slackThread`):
- First notification posts as root message (`thread_ts: null`)
- Narada gets back a `ts`, stores in `slack-threads.json`
- Subsequent events reply in that thread

---

## 7. Watcher Integration

### 7.1 Poll Cycle

```typescript
let slackPollInProgress = false;

setInterval(() => {
  if (slackPollInProgress) return;
  slackPollInProgress = true;
  pollSlack()
    .catch(err => logger.warn(`[watcher] Slack poll error: ${err.message}`))
    .finally(() => { slackPollInProgress = false; });
}, pollMs);
```

### 7.2 pollSlack() Flow

```
1. Build Narada input payload:
   a. Read slack-outbox.jsonl → outbox array
   b. Read slack-cursor.json → oldest timestamps
   c. Read slack-threads.json + find held tasks → approvalChecks array
   d. Read config → channelId, dmUserIds
2. Spawn Narada via agent runner:
   - stage: "slack-io"
   - model: haiku (from config.agents.models)
   - timeout: 2 minutes
   - tools: mcp__claude_ai_Slack__*, Read, Write
3. After agent completes:
   a. Read slack-inbox.jsonl → process inbound messages
   b. Read slack-sent.jsonl → log confirmations
   c. Process inbound:
      - Run filterMessages() as safety net
      - For approval entries → write .control file { operation: "approve", slug: "..." }
      - For new messages → classifyByKeywords() → .task or .control file
   d. Write empty file to slack-inbox.jsonl after processing (clear for next cycle)
```

### 7.3 Adaptive Payload

The poll always runs (new tasks can arrive anytime), but the payload scales with activity:

| Pipeline state | Outbox | Inbound | Approvals |
|---|---|---|---|
| Idle (no tasks) | Empty | Read channel + DMs | None |
| Active tasks | May have events | Read channel + DMs | None |
| Held tasks with threads | May have events | Read channel + DMs | Check held task threads |

An idle poll with no outbox is a single `slack_read_channel` call — minimal tokens, fast, cheap (~$0.002-0.005 on Haiku).

### 7.4 Narada Lifecycle

Narada is ephemeral — spawned fresh per poll tick, not a persistent process. If it crashes or times out:
- Outbox entries remain on disk → sent next cycle
- Cursor hasn't advanced → same messages read again (deduplicated by sent log)
- No state is lost, no recovery needed

Narada does NOT count against `maxConcurrentTotal` for pipeline agents. The watcher tracks it separately via the `slackPollInProgress` flag.

---

## 8. Pipeline Changes

### 8.1 task_approved Event

`approveAndResume()` in `pipeline.ts` currently processes approvals but does not emit a notification event. Add:

```typescript
emitNotify({
  type: "task_approved",
  slug,
  approvedBy: "user",
  feedback: feedback ?? "",
  timestamp: new Date().toISOString(),
});
```

### 8.2 task_created Event — slackThread Field

Add optional `slackThread?: string` to the `task_created` NotifyEvent payload. The pipeline sets this from `TaskMeta.slackThread` when emitting the event during `startRun()`.

---

## 9. Approval via Slack Thread

### 9.1 Detection

When a task is held at a review gate and has a Slack thread (in `slack-threads.json`), Narada checks the thread for approval replies.

**Approval keywords** (case-insensitive): `approved`, `approve`, `lgtm`, `looks good`, `ship it`

Narada writes detected approvals to the inbox with `isApproval: true` and the resolved `slug`.

### 9.2 Watcher Processing

When the watcher finds an approval entry in the inbox:
1. Verify the slug is actually in `12-hold/`
2. Write `.control` file: `{ "operation": "approve", "slug": "...", "feedback": "Approved via Slack by U789" }`
3. The existing control file handler in the watcher processes the approval

### 9.3 Safety

- Only held tasks are checked for approvals (not active or completed)
- The watcher verifies the task is in hold before writing the control file
- Duplicate approvals are harmless (approveAndResume on an already-running task throws, watcher catches)

---

## 10. DM Support

### 10.1 Config

```json
{
  "slack": {
    "allowDMs": true,
    "dmUserIds": ["U0123456789"]
  }
}
```

When `allowDMs` is true and `dmUserIds` is non-empty, the Narada input payload includes DM user IDs. Narada calls `mcp__claude_ai_Slack__slack_read_channel` with each user ID (Slack treats DMs as channels addressable by user ID).

When `allowDMs` is true but `dmUserIds` is empty, the watcher logs a warning:
```
[watcher] Slack DM polling enabled but no dmUserIds configured — skipping DMs
```

### 10.2 Cursor

`slack-cursor.json` already has a `dmTs` field. Narada advances it after processing DM messages.

---

## 11. Init Wizard Updates

### 11.1 New Prompts

After the existing ADO setup section, add optional Slack setup:

1. "Enable Slack integration?" → boolean (default: no)
2. If yes:
   - "Slack channel ID (e.g. C0123456789):" → text input
   - "Require prefix for channel messages?" → boolean (default: yes)
   - "Monitor DMs from specific users? (comma-separated user IDs, or leave blank):" → text input

### 11.2 .env Template Cleanup

Remove `SLACK_WEBHOOK_URL=` line from the generated `.env` file. Keep `SLACK_TOKEN=` as it may be useful for future direct API access, but add a comment: `# Not required when using MCP-based Slack integration`.

---

## 12. Removed Code

### 12.1 fetchChannelMessages and getBotUserId

Remove from `src/surfaces/slack-surface.ts`:
- `fetchChannelMessages()` function and its REST call
- `getBotUserId()` function and its module-level cache
- Associated imports (`fetch` is no longer needed)

These are replaced by Narada's MCP-based reading.

### 12.2 sendMessage Stub in start.ts

Remove the placeholder `sendMessage` callback. The `createSlackNotifier` call changes from:

```typescript
// Before
createSlackNotifier({
  channelId: config.slack.channelId,
  notifyLevel: config.slack.notifyLevel,
  sendMessage: async (params) => { /* stub */ },
})

// After
createSlackNotifier({
  channelId: config.slack.channelId,
  notifyLevel: config.slack.notifyLevel,
  runtimeDir: config.pipeline.runtimeDir,
})
```

---

## 13. Testing Strategy

### 13.1 Watcher Slack Polling Tests (`tests/core/watcher.test.ts`)

New test cases with `slack.enabled: true` and a mock agent runner:
- Poll tick calls agent runner with stage `"slack-io"` and model `"haiku"`
- Skips poll when `slackPollInProgress` is true
- Processes inbox file after agent completes (creates .task and .control files)
- Updates cursor after successful poll
- Handles agent failure gracefully (logs warning, doesn't crash)

### 13.2 Slack Queue Tests (`tests/core/slack-queue.test.ts`)

Tests for the watcher's pre/post processing (no real agent calls):
- Outbox payload builder: correctly reads `slack-outbox.jsonl` and constructs input JSON
- Inbox processor: parses `slack-inbox.jsonl`, creates .task files for new messages, .control files for approvals
- Sent log processor: reads `slack-sent.jsonl`, verifies entries
- Thread map: reads/writes `slack-threads.json` correctly
- Cursor advancement: updates `slack-cursor.json` after processing
- Deduplication: sent log prevents re-sending outbox entries

### 13.3 SlackNotifier Tests (update `tests/surfaces/slack-notifier.test.ts`)

- Notifier appends to outbox file instead of calling sendMessage
- Thread round-tripping: uses `slackThread` from `task_created` event
- Reads `slack-threads.json` for thread_ts on subsequent events
- Generates unique event IDs

### 13.4 Pipeline Tests (update `tests/core/pipeline-control.test.ts`)

- `approveAndResume` emits `task_approved` event with correct fields

### 13.5 Config Tests

- `agents.models` merges correctly with defaults
- `slack.dmUserIds` validates as string array
- Agent runner resolves model from `config.agents.models[stage]`

### 13.6 Init Wizard Tests (update `tests/commands/init.test.ts`)

- Slack prompts write channelId, requirePrefix, dmUserIds to config
- `.env` template no longer contains `SLACK_WEBHOOK_URL`

---

## 14. Acceptance Criteria

1. Narada agent (`agents/slack-io.md`) exists with MCP tools, Haiku model, 2-min timeout
2. SlackNotifier appends to `slack-outbox.jsonl` instead of calling sendMessage
3. Watcher spawns Narada per poll tick to process outbox + read inbound + check approvals
4. Thread round-tripping: tasks from Slack reply in the originating thread
5. Approval detection: "approved"/"lgtm" in held task threads triggers pipeline approval
6. DM polling: when `allowDMs` and `dmUserIds` configured, Narada reads DMs
7. Per-agent model override: `agents.models` config respected by agent runner
8. Agent names: questions agent is Gargi, Slack I/O agent is Narada
9. `task_approved` event emitted by `approveAndResume()`
10. `task_created` event includes `slackThread` for Slack-originating tasks
11. Init wizard prompts for Slack setup (channelId, prefix, DMs)
12. `SLACK_WEBHOOK_URL` removed from .env template
13. `fetchChannelMessages()` and `sendMessage` stub removed
14. All new/modified code has test coverage
15. Existing 572 tests continue to pass
