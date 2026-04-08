# Enriched Slack Notifications — Design

**Date:** 2026-04-08
**Status:** Draft
**Scope:** Improve Slack notification messages with timestamps, stage metrics, and task completion summaries

## Problem

Current Slack notifications are minimal and unhelpful:
- No timestamps — user can't tell when events happened
- `stage_completed` only shows artifact path (a local filesystem path, meaningless in Slack)
- `task_completed` has no summary — just "Task completed `slug`"
- `task_held` and `task_failed` lack context about what the stage did before stopping
- No duration, cost, token usage, or model information
- No newline after the `outboundPrefix`, making messages feel cramped

## Changes

### 1. Add `timezone` to config

```typescript
// In ShkmnConfig.slack:
timezone: string;  // IANA timezone, e.g., "Asia/Kolkata"

// In DEFAULT_CONFIG.slack:
timezone: "UTC",

// In schema.ts:
timezone: z.string().default("UTC"),
```

### 2. Enrich NotifyEvent types (`surfaces/types.ts`)

Add optional metric fields to `stage_completed`, `task_held`, `task_failed`, and `task_completed`:

```typescript
export type NotifyEvent =
  | ({ type: "task_created"; title: string; source: string; stages: string[];
       slackThread?: string } & EventBase)
  | ({ type: "stage_started"; stage: string;
       agentName?: string } & EventBase)
  | ({ type: "stage_completed"; stage: string; artifactPath: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       verdict?: string; agentName?: string } & EventBase)
  | ({ type: "task_held"; stage: string; artifactUrl: string;
       holdReason?: string; holdDetail?: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       agentName?: string } & EventBase)
  | ({ type: "task_approved"; approvedBy: string; feedback?: string } & EventBase)
  | ({ type: "task_completed"; prUrl?: string;
       completedStages?: Array<{ stage: string; completedAt: string;
         costUsd?: number; turns?: number; inputTokens?: number;
         outputTokens?: number; model?: string }>;
       startedAt?: string;
       agentNames?: Record<string, string> } & EventBase)
  | ({ type: "task_failed"; stage: string; error: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       agentName?: string } & EventBase)
  // ... rest unchanged
```

### 3. Pass metrics at emission sites (`pipeline.ts`)

**stage_completed (line ~726):**
```typescript
emitNotify({
  type: "stage_completed", slug, stage,
  artifactPath: `${stage}-output${outputSuffix}.md`,
  durationSeconds: Math.round(result.durationMs / 1000),
  costUsd: result.costUsd,
  model: runOptions.model,
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  turns: result.turns,
  verdict: (stage === "review" || stage === "validate") ? verdict : undefined,
  agentName: config.agents.names[stage] ?? stage,
  timestamp: new Date().toISOString(),
});
```

**task_held — budget (line ~550):**
```typescript
emitNotify({
  type: "task_held", slug, stage, artifactUrl: "",
  holdReason: "budget_exhausted",
  holdDetail: modelResolution.reason,
  durationSeconds: result ? Math.round(result.durationMs / 1000) : undefined,
  costUsd: result?.costUsd,
  model: runOptions.model,
  inputTokens: result?.inputTokens,
  outputTokens: result?.outputTokens,
  turns: result?.turns,
  agentName: config.agents.names[stage] ?? stage,
  timestamp: new Date().toISOString(),
});
```

Note: budget holds fire before the agent runs (at the pre-stage check), so `result` is not available. Metrics will be undefined for budget holds. For review-gate holds (line ~762), the stage just completed — metrics from the last completed stage can be included.

**task_held — review gate (line ~762):**
```typescript
emitNotify({
  type: "task_held", slug, stage, artifactUrl: "",
  holdReason: "approval_required",
  agentName: config.agents.names[stage] ?? stage,
  timestamp: new Date().toISOString(),
});
```

**task_failed (line ~320 in failTask):**
```typescript
// failTask needs to accept optional metrics
function failTask(slug, stage, taskDir, state, errorMsg, fromSubdir, metrics?: {
  durationSeconds?: number; costUsd?: number; model?: string;
  inputTokens?: number; outputTokens?: number; turns?: number;
}) {
  // ...
  emitNotify({
    type: "task_failed", slug, stage, error: state.error,
    durationSeconds: metrics?.durationSeconds,
    costUsd: metrics?.costUsd,
    model: metrics?.model,
    inputTokens: metrics?.inputTokens,
    outputTokens: metrics?.outputTokens,
    turns: metrics?.turns,
    agentName: config.agents.names[stage] ?? stage,
    timestamp: new Date().toISOString(),
  });
}
```

**task_completed (line ~778):**
```typescript
emitNotify({
  type: "task_completed", slug,
  completedStages: state.completedStages,
  startedAt: state.startedAt,
  agentNames: config.agents.names,
  timestamp: new Date().toISOString(),
});
```

**stage_started (line ~478):**
```typescript
emitNotify({
  type: "stage_started", slug, stage,
  agentName: config.agents.names[stage] ?? stage,
  timestamp: new Date().toISOString(),
});
```

### 4. Update `formatEvent` (`slack-notifier.ts`)

Pass `timezone` from `SlackNotifierOptions` into formatting. `formatEvent` becomes `formatEvent(event, timezone)`.

**Timestamp helper:**
```typescript
function formatTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    hour: "2-digit", minute: "2-digit",
    hour12: true, timeZoneName: "short",
  });
  // e.g., "2:27 PM IST"
}
```

**Duration helper:**
```typescript
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
```

**Tokens helper:**
```typescript
function formatTokens(input?: number, output?: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `${fmt(input ?? 0)} in / ${fmt(output ?? 0)} out`;
}
```

**Metrics line builder (reused across event types):**
```typescript
function formatMetrics(m: {
  durationSeconds?: number; costUsd?: number; turns?: number;
  inputTokens?: number; outputTokens?: number;
}): string {
  const parts: string[] = [];
  if (m.durationSeconds != null) parts.push(`⏱ ${formatDuration(m.durationSeconds)}`);
  if (m.costUsd != null) parts.push(`💰 $${m.costUsd.toFixed(2)}`);
  if (m.turns != null) parts.push(`${m.turns} turns`);
  const line1 = parts.join(" · ");

  const line2 = (m.inputTokens != null || m.outputTokens != null)
    ? `📊 ${formatTokens(m.inputTokens, m.outputTokens)}`
    : "";

  return [line1, line2].filter(Boolean).join("\n");
}
```

### 5. Message formats

All messages start with `\n` so that after Narada prepends the outboundPrefix, the result is:

```
🤖 [ShaktimaanAI]

🕐 2:27 PM IST
...
```

**stage_started:**
```
🕐 2:27 PM IST
▶️ *design* started — Vishwakarma
```

**stage_completed:**
```
🕐 2:31 PM IST
✅ *design* completed — Vishwakarma (opus)
⏱ 4m 34s · 💰 $0.88 · 27 turns
📊 410 in / 7,353 out
```

**stage_completed with verdict (review/validate):**
```
🕐 2:31 PM IST
✅ *review* completed — Drona (sonnet)
📋 Verdict: APPROVED_WITH_SUGGESTIONS
⏱ 3m 12s · 💰 $0.45 · 18 turns
📊 320 in / 5,100 out
```

**task_held (budget):**
```
🕐 3:04 PM IST
✋ *impl* held — Karigar (opus)
💸 Budget exhausted: opus task limit at 209%
```

**task_held (review gate):**
```
🕐 2:31 PM IST
✋ *design* completed — awaiting approval
```

**task_failed:**
```
🕐 5:56 PM IST
❌ *validate* failed — Dharma (haiku)
⚠️ Unknown validate verdict "unknown" — cannot proceed
⏱ 3m 27s · 💰 $0.12 · 8 turns
📊 200 in / 1,800 out
```

**task_created:**
```
🕐 2:27 PM IST
🚀 *Task created* `spec4-dashboard`
📋 stages: design, structure, plan, impl, review, validate, pr
```

**task_completed:**
```
🕐 6:12 PM IST
🎉 *Task completed* `spec4-dashboard`

📊 *Pipeline Summary*
⏱ Total: 2h 34m · 💰 $8.42

| Stage | Agent | Model | Duration | Cost | Tokens |
|-------|-------|-------|----------|------|--------|
| questions | Gargi | sonnet | 2m 59s | $0.38 | 4,564 |
| research | Chitragupta | sonnet | 8m 10s | $0.99 | 18,784 |
| design | Vishwakarma | opus | 2m 38s | $0.43 | 6,769 |
| structure | Vastu | sonnet | 6m 11s | $0.52 | 22,411 |
| plan | Chanakya | opus | 8m 22s | $1.45 | 40,943 |
| impl | Karigar | opus | 12m 0s | $3.74 | 41,194 |
| review | Drona | sonnet | 4m 2s | $0.45 | 5,420 |
| validate | Dharma | haiku | 1m 15s | $0.12 | 2,000 |
| pr | Garuda | sonnet | 1m 30s | $0.34 | 3,200 |
```

The table is built from `completedStages` array. For stages with retries (multiple impl entries), show only the last successful entry to keep the table clean. Total duration is computed from `startedAt` to `timestamp`. Total cost sums all `costUsd` across completedStages (including retries).

**task_approved:**
```
🕐 3:15 PM IST
👍 *Task approved* `spec4-dashboard` by user
```

**task_cancelled:**
```
🕐 3:15 PM IST
🚫 *Task cancelled* `spec4-dashboard` by user
```

**task_paused:**
```
🕐 3:15 PM IST
⏸ *Task paused* `spec4-dashboard` by user
```

**task_resumed:**
```
🕐 3:15 PM IST
▶️ *Task resumed* `spec4-dashboard` by user
```

**stage_retried:**
```
🕐 3:15 PM IST
🔁 *impl* retried — attempt 2
📋 feedback: "Fix the failing tests in auth module"
```

**stage_skipped:**
```
🕐 3:15 PM IST
⏭ *research* skipped
```

**stages_modified:**
```
🕐 3:15 PM IST
✏️ *Stages modified* `spec4-dashboard`
📋 old: design, structure, plan, impl, review, validate, pr
📋 new: design, plan, impl, review, validate, pr
```

### 6. Newline after prefix

The `formatEvent` function prepends `\n` to every message. Narada's prompt concatenates `${outboundPrefix} ${entry.text}`, so the final Slack message becomes:

```
🤖 [ShaktimaanAI]
 
🕐 2:27 PM IST
✅ *design* completed — Vishwakarma (opus)
...
```

The leading `\n` in `entry.text` creates the visual separation after the prefix.

### 7. Console notifier

`console-notifier.ts` can continue using the existing simple format, or adopt the same `formatEvent`. This spec only changes the Slack notifier formatting. Console output is for the terminal running `shkmn start` — brevity matters more there.

## Files Changed

- `src/config/defaults.ts` — add `timezone` to `DEFAULT_CONFIG.slack`
- `src/config/schema.ts` — add `timezone` to Zod schema
- `src/surfaces/types.ts` — add metric fields to event types
- `src/surfaces/slack-notifier.ts` — new `formatEvent` with timezone, metrics, multiline
- `src/core/pipeline.ts` — pass metrics at all `emitNotify` call sites

## Testing

1. Test `formatTime` with various timezones (UTC, Asia/Kolkata, America/New_York).
2. Test `formatDuration` — seconds, minutes, hours.
3. Test `formatTokens` — formatting with commas.
4. Test `formatMetrics` — with full data, partial data, no data.
5. Test `formatEvent` for each event type — verify multiline format, timestamp position, metrics inclusion.
6. Test `task_completed` summary table — verify total cost/duration computation, retry dedup (show last per stage).
7. Test leading `\n` is present in all formatted messages.
