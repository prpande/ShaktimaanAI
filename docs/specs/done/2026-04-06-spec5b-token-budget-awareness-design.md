# Spec 5b — Token Budget Awareness

## Problem Statement

The ShaktimaanAI pipeline has no awareness of token consumption relative to API rate limits. The Claude API enforces weekly, daily, and per-session token budgets (especially on the Max 5x plan). A single expensive pipeline run can exhaust the budget, causing hard lockouts that block all subsequent work until the window resets.

The pipeline currently:
- Tracks `costUsd` per stage but never checks it against any limit
- Tracks `inputTokens` and `outputTokens` per stage but doesn't aggregate or enforce them
- Has no model selection — uses whatever the Claude Agent SDK defaults to
- Has no fallback when a preferred model's budget is exhausted

## Goals

1. Enforce token budgets at multiple levels (per-task stage, session, daily, weekly) with a safety margin
2. Gracefully pause tasks to `12-hold` when budgets are hit — never hard-fail
3. Automatically downgrade from opus to sonnet when opus budget is exhausted
4. Respect peak-hour multipliers to avoid lockouts during high-demand windows
5. Resume held tasks via existing `shkmn resume` when budget frees up

## Non-Goals

- Auto-resuming budget-held tasks when windows reset (follow-up feature)
- Real-time token counting mid-turn (SDK doesn't expose this)
- Cost optimization via prompt compression (separate concern, see Spec 5a for context reduction)

---

## Design

### Budget Configuration

New config file: `usage-budget.json` in the runtime directory (`~/.shkmn/runtime/usage-budget.json`).

```json
{
  "model_budgets": {
    "sonnet": {
      "weekly_token_limit": 15000000,
      "daily_token_limit": 3000000,
      "session_token_limit": 800000,
      "per_task_token_limit": 200000
    },
    "opus": {
      "weekly_token_limit": 5000000,
      "daily_token_limit": 1000000,
      "session_token_limit": 300000,
      "per_task_token_limit": 100000
    }
  },
  "peak_hours": {
    "start_utc": "12:00",
    "end_utc": "18:00",
    "multiplier": 0.5
  },
  "safety_margin": 0.15
}
```

**Token limits** are `input + output` combined. The safety margin (0.15) means the pipeline stops at 85% of each limit to avoid hitting the hard API lockout.

**Peak hours** halve the effective budget during 12:00–18:00 UTC (5 AM–11 AM PT) when demand is highest. The multiplier applies to all limits.

### Model Selection

#### Current State

The `agent-runner.ts` calls `query()` from the Claude Agent SDK with no explicit model parameter. The SDK defaults to its built-in model (currently opus-level).

#### Proposed State

Add a `model` field to `AgentRunOptions` and pass it to the SDK's `query()` call:

```typescript
// agent-runner.ts
const messages = query({
  prompt: systemPrompt,
  options: {
    model: options.model,       // NEW — "opus" | "sonnet"
    allowedTools,
    disallowedTools,
    maxTurns,
    cwd,
    abortController,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
  },
});
```

#### Per-Stage Model Defaults

Not all stages need opus. A default model map in `defaults.ts`:

```typescript
defaultModelPerStage: {
  questions:  "sonnet",   // extraction task, doesn't need deep reasoning
  research:   "opus",     // needs thorough codebase analysis
  design:     "opus",     // architectural decisions
  structure:  "sonnet",   // mechanical slicing of design into structure
  plan:       "opus",     // detailed implementation planning
  impl:       "opus",     // code generation, TDD — quality matters most
  review:     "sonnet",   // code review — pattern matching, sonnet is sufficient
  validate:   "sonnet",   // runs build + tests, minimal reasoning needed
  pr:         "sonnet",   // git operations, PR description — mechanical
}
```

This alone saves tokens on the opus budget. On the analyzed run, questions ($0.46), structure ($0.42), validate ($2.46), review ($0.77), and pr ($0.59) would shift to sonnet — saving ~$4.70 of opus budget.

Configurable via `shkmn.config.json`:

```json
{
  "agents": {
    "modelPerStage": {
      "impl": "opus",
      "review": "opus"
    }
  }
}
```

### Model Downgrade Logic

When a stage is about to start, the budget checker determines the preferred model's remaining budget. If the preferred model is `opus` and its budget is exhausted:

1. Check if `sonnet` has sufficient budget for the stage
2. If yes: **downgrade to sonnet** for this stage, log a warning
3. If no (both exhausted): **pause task to 12-hold** with reason `budget_exhausted`

The downgrade is **per-stage, not per-task**. A task might run its `research` stage on opus, get downgraded to sonnet for `impl` when opus budget runs low, and return to opus for a later stage if budget resets.

```
Pipeline decides to run "impl" stage
  → resolveModel("impl", config) → "opus" (preferred)
  → checkBudget("opus") → OVER_LIMIT
  → checkBudget("sonnet") → OK
  → run stage with model="sonnet", log: "Downgraded impl from opus to sonnet (opus daily budget at 87%)"
```

### Budget Tracking

#### Data Source

Token usage is already logged per-stage in `completedStages[]` within `run-state.json`:

```json
{
  "stage": "impl",
  "costUsd": 3.65,
  "turns": 60
}
```

And `inputTokens` / `outputTokens` are captured in `AgentRunResult` (added in recent work) but **not yet persisted to `completedStages` or daily logs**. This spec adds that.

#### New Fields in CompletedStage

```typescript
interface CompletedStage {
  stage: string;
  completedAt: string;
  outputFile: string;
  costUsd: number;
  turns: number;
  inputTokens: number;    // NEW
  outputTokens: number;   // NEW
  model: string;          // NEW — which model actually ran
}
```

#### Aggregation

New module: `src/core/budget.ts`

```typescript
export interface BudgetStatus {
  model: string;
  weeklyUsed: number;
  weeklyLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  sessionUsed: number;
  sessionLimit: number;
  isOverLimit: boolean;
  effectiveMultiplier: number;  // 1.0 or peak_hours.multiplier
}

export function checkBudget(model: string, config: BudgetConfig): BudgetStatus;
export function resolveModelForStage(stage: string, config: ResolvedConfig): string;
```

**Aggregation strategy:**

- **Weekly**: Sum `inputTokens + outputTokens` from all daily JSONL logs in the current ISO week (Mon–Sun)
- **Daily**: Sum from today's JSONL log
- **Session**: Sum from stages completed in the current pipeline watcher session (tracked in memory, reset on `shkmn start`)
- **Per-task**: Sum from the current task's `completedStages[]` in run-state.json

Each limit is adjusted: `effectiveLimit = limit * (isPeakHour ? peakMultiplier : 1.0) * (1 - safetyMargin)`

### Budget Enforcement Points

Budget is checked at **two points**:

1. **Before stage starts** (`pipeline.ts`, before calling `runAgent()`)
   - Check per-task limit: has this task already consumed too many tokens?
   - Check session/daily/weekly limits for the resolved model
   - If over limit: attempt downgrade. If both models over limit: pause to hold.

2. **After stage completes** (`pipeline.ts`, after `runAgent()` returns)
   - Update aggregates with actual tokens consumed
   - If the completed stage pushed us over a limit: log a warning, but don't retroactively fail the stage (work is already done)
   - If the next stage would exceed limits: pause before starting it

Budget is NOT checked mid-stage (the SDK doesn't provide a hook for this). The `per_task_token_limit` serves as a soft cap — if a single stage exceeds it, the pipeline logs a warning and pauses before the next stage.

### Hold and Resume Flow

When budget is exhausted:

1. Pipeline sets `run-state.json`:
   ```json
   {
     "status": "hold",
     "holdReason": "budget_exhausted",
     "holdDetail": "opus daily budget at 92% (920K/1M tokens). sonnet daily budget at 88% (2.64M/3M tokens).",
     "pausedAtStage": "impl"
   }
   ```

2. Task moves to `12-hold/`

3. Notification emitted:
   - Console: `[budget] Task "add-stats-command" paused at impl — opus daily budget at 92%, sonnet at 88%`
   - Slack: `:pause_button: *Budget hold* add-stats-command paused at impl — daily budgets near limit`

4. Resume via existing `shkmn resume <slug>` — budget is re-checked on resume. If still over limit, task stays in hold with an updated message.

### New RunState Fields

```typescript
interface RunState {
  // ... existing fields ...
  holdReason?: "budget_exhausted" | "approval_required" | "user_paused";  // NEW
  holdDetail?: string;                                                     // NEW
}
```

### Daily Log Entry Update

The daily interaction JSONL entries currently log `costUsd` (previously mislabeled as `tokensUsed`). Add actual token counts:

```json
{
  "timestamp": "2026-04-06T...",
  "type": "agent_completed",
  "slug": "task-name",
  "stage": "impl",
  "model": "opus",
  "costUsd": 3.65,
  "inputTokens": 45000,
  "outputTokens": 12000,
  "durationSeconds": 1800
}
```

---

## Files Changed

### New Files

- **`src/core/budget.ts`** — Budget checking, model resolution, aggregation logic
- **`src/config/budget-schema.ts`** — Zod schema for `usage-budget.json`

### Modified Files

- **`src/core/agent-runner.ts`**
  - Add `model` to `query()` options
  - Accept `model` from `AgentRunOptions`

- **`src/core/types.ts`**
  - Add `model` to `AgentRunOptions`
  - Add `inputTokens`, `outputTokens`, `model` to `CompletedStage`
  - Add `holdReason`, `holdDetail` to `RunState`

- **`src/core/pipeline.ts`**
  - Before each stage: call `resolveModelForStage()` which checks budget and handles downgrade
  - After each stage: persist token counts to `completedStages` and daily log
  - On budget exhaustion: pause to hold with `holdReason: "budget_exhausted"`

- **`src/core/interactions.ts`**
  - Add `model`, `inputTokens`, `outputTokens` to daily log entries

- **`src/config/defaults.ts`**
  - Add `defaultModelPerStage` map
  - Add `budgetConfigPath` to pipeline config

- **`src/config/loader.ts`**
  - Load and validate `usage-budget.json`
  - Merge `modelPerStage` overrides from config

- **`src/config/schema.ts`**
  - Add `modelPerStage` to agents schema

- **`src/commands/status.ts`**
  - Show `holdReason` and `holdDetail` for held tasks

- **`src/commands/resume.ts`**
  - Re-check budget on resume; if still over, re-hold with updated message

- **`src/commands/stats.ts`**
  - Include model and token breakdown in stats output

---

## Impact Analysis

### Token Savings from Model Defaults Alone

Based on the analyzed pipeline run, shifting mechanical stages to sonnet:

| Stage | Current Model | Proposed Model | Est. Token Savings (opus) |
|---|---|---|---|
| questions | opus | sonnet | ~$0.46 of opus budget freed |
| structure | opus | sonnet | ~$0.42 of opus budget freed |
| validate | opus | sonnet | ~$2.46 of opus budget freed |
| review | opus | sonnet | ~$0.77 of opus budget freed |
| pr | opus | sonnet | ~$0.59 of opus budget freed |
| **Total** | | | **~$4.70 opus budget freed per run** |

Combined with Spec 5a (fewer retry cycles), the opus budget per task drops from ~$16.32 to ~$3-4 (only research + design + plan + impl on opus).

### Budget Protection

With the proposed defaults:
- Opus daily limit: 1M tokens → approximately 3-4 full pipeline runs per day
- Sonnet daily limit: 3M tokens → mechanical stages and downgraded runs have ample room
- Safety margin at 85% prevents hard API lockouts
- Peak hour halving avoids contention during high-demand windows

### Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Sonnet produces lower quality for impl stage | Medium | Only triggers on opus budget exhaustion. Per-stage defaults keep impl on opus normally. |
| Token aggregation from JSONL is slow for large history | Low | Only aggregate current week's logs. JSONL files are date-partitioned. |
| Budget config out of sync with actual API limits | Medium | Document that `usage-budget.json` should be updated when plan tier changes. Add `shkmn doctor` check. |
| Resume into still-exhausted budget loops | Low | Re-check on resume, re-hold if still over. Log clearly. |
| SDK doesn't accept model parameter | Medium | Verify Claude Agent SDK `query()` supports `model` option. If not, may need SDK update or workaround via environment variable. |

---

## Testing Plan

1. **Unit tests for budget.ts** — Test `checkBudget()` with various usage levels, test peak hour multiplier, test safety margin calculation, test per-task limit
2. **Unit tests for model resolution** — Test `resolveModelForStage()` with default map, config overrides, and downgrade logic
3. **Unit tests for pipeline integration** — Mock budget checker, verify task pauses to hold on budget exhaustion, verify downgrade logs
4. **Integration test** — Run a task with artificially low budget, verify it pauses at the right stage, verify resume works after budget resets
5. **Stats command test** — Verify token and model columns appear in `shkmn stats` output

---

## Open Questions

1. **SDK model parameter**: Need to verify the Claude Agent SDK's `query()` function accepts a `model` option. If it uses `ANTHROPIC_MODEL` env var or similar, the downgrade mechanism would set that instead.
2. **Auto-resume on budget reset**: Should the watcher automatically resume budget-held tasks when the daily/weekly window resets? Deferred to follow-up, but the `holdReason` field enables it.
3. **Budget sharing across concurrent tasks**: When 3 tasks run concurrently, they share the same daily/weekly budget. The pre-stage check is a point-in-time snapshot — two tasks could both pass the check and then collectively exceed the limit. The safety margin (15%) provides buffer for this race condition.
