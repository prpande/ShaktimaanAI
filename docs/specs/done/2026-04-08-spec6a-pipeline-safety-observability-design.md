# Spec 6a: Pipeline Safety & Observability — Design

**Date:** 2026-04-08
**Status:** Draft
**Scope:** 8 fixes addressing critical pipeline safety bugs and observability gaps found by the pipeline diagnostics audit

## Context

The pipeline diagnostics skill (`/pipeline-diagnostics`) audited the live runtime and found 7 ERRORS and 6 WARNINGS. This spec addresses the safety-critical and observability issues. Cleanup/hygiene fixes are in Spec 6b.

The most severe issue: Task `i-would-like-to-implement-the-spec-4-described-in-20260408150650` ran 7 review→impl cycles ($16.18 total), hit budget exhaustion, was approved by the user (which incorrectly advanced it past an incomplete review stage to validate), and then failed with an unparseable validate verdict. Multiple safety mechanisms failed simultaneously.

## Fix 1: Budget-Reset on Resume

**Diagnostic finding:** Budget-resume deadlock — `resume()` re-checks per-task token limits using `completedStages`, which already exceed the limit. Task is permanently stuck.

**Root cause:** `aggregateTaskTokens` in `budget.ts` sums ALL tokens in `completedStages` with no way to reset the per-task counter after a user-approved resume.

**Design:**

Add `budgetResetAtIndex` field to `RunState`:

```typescript
// In types.ts RunState interface:
budgetResetAtIndex?: number;  // Index into completedStages; only count tokens from here onward
```

Modify `aggregateTaskTokens` in `budget.ts` to accept a start index:

```typescript
export function aggregateTaskTokens(
  completedStages: CompletedStage[],
  model: string,
  startIndex: number = 0,
): number {
  let total = 0;
  for (let i = startIndex; i < completedStages.length; i++) {
    const stage = completedStages[i];
    if (stage.model !== model) continue;
    total += (stage.inputTokens ?? 0) + (stage.outputTokens ?? 0);
  }
  return total;
}
```

In `pipeline.ts`, when building `BudgetCheckContext` for `processStage`, pass `budgetResetAtIndex` through to the budget check. In `resume()`, when resuming from `budget_exhausted`, set:

```typescript
state.budgetResetAtIndex = state.completedStages.length;
```

This gives the task a fresh per-task budget window while preserving full cost history for reporting.

**Files:** `src/core/types.ts`, `src/core/budget.ts`, `src/core/pipeline.ts`

## Fix 2: Approve Guard — Incomplete Stage Detection

**Diagnostic finding:** `approveAndResume()` advanced a budget-held task from review to validate, even though review never completed. The validate agent ran on incomplete code and produced an unparseable verdict.

**Root cause:** `approveAndResume()` unconditionally calls `getNextStage(currentStage)` and advances. It doesn't check whether the current stage actually completed.

**Design:**

In `approveAndResume()`, add stage-completion detection:

```typescript
async approveAndResume(slug: string, feedback?: string): Promise<void> {
  const holdDir = join(runtimeDir, "12-hold", slug);
  if (!existsSync(holdDir)) throw new Error(`Task "${slug}" not found in hold`);

  const state = readRunState(holdDir);

  // Guard: if held for budget/pause, always resume at current stage (don't advance).
  // Budget holds mean the stage was interrupted mid-execution. User pauses are similar.
  // Only approval_required holds (review gate) should advance — the stage completed.
  if (state.holdReason === "budget_exhausted" || state.holdReason === "user_paused") {
    {
      // Current stage was interrupted — resume it, don't advance
      // Reset budget for the task so it can actually run
      state.budgetResetAtIndex = state.completedStages.length;
      delete state.holdReason;
      delete state.holdDetail;
      delete state.pausedAtStage;
      state.status = "running";
      writeRunState(holdDir, state);

      const stageDir = STAGE_DIR_MAP[state.currentStage];
      const nextDir = moveTaskDir(runtimeDir, slug, "12-hold", join(stageDir, "pending"));
      activeRuns.set(slug, state);
      await processStage(slug, nextDir);
      return;
    }
  }

  // Original behavior: advance to next stage (for approval_required holds)
  // ... existing code ...
}
```

For `holdReason === "approval_required"` (review gate), behavior is unchanged — the current stage completed successfully and the user is approving to proceed.

For `holdReason === undefined` (legacy tasks held before Fix 5 was applied), treat as `approval_required` for backwards compatibility.

Also update `resume()` to apply budget reset (Fix 1) when resuming from budget hold:

```typescript
if (state.holdReason === "budget_exhausted") {
  state.budgetResetAtIndex = state.completedStages.length;
  // ... existing budget re-check with reset index ...
}
```

**Files:** `src/core/pipeline.ts` (`approveAndResume`, `resume`)

## Fix 3: Review Counter Hard-Cap

**Diagnostic finding:** `issueHash` produced different hashes for semantically identical issues across 7 review iterations. `maxRecurrenceHardCap` never fired. 33 unique issues accumulated.

**Root cause:** `issueHash` depends on LLM output text stability, which is unreliable. Content-based dedup is a poor safety mechanism for LLM-generated reviews.

**Design:**

Add `maxReviewRetries` to config:

```typescript
// In defaults.ts DEFAULT_CONFIG.agents:
maxReviewRetries: 5,

// In schema.ts agents schema:
maxReviewRetries: z.number().int().min(1).default(5),
```

In `decideAfterReview` in `retry.ts`, add a counter-based check as the FIRST guard before any per-issue analysis:

```typescript
export function decideAfterReview(
  outcome: StageOutcome,
  previousIssues: ReviewIssue[],
  currentIteration: number,
  suggestionRetryUsed: boolean,
  enforceSuggestions: boolean,
  maxReviewRetries: number = 5,   // NEW parameter
): RetryDecision {
  // Hard cap: counter-based, independent of issue tracking
  if (currentIteration > maxReviewRetries) {
    return {
      action: "fail",
      reason: `Review retry limit (${maxReviewRetries}) exceeded — ${currentIteration} iterations without approval`,
    };
  }

  // ... existing verdict-based logic unchanged ...
}
```

Update the call site in `pipeline.ts` to pass `config.agents.maxReviewRetries`.

Keep `issueHash` and per-issue recurrence tracking for informational purposes (the diagnostic report uses it). It just no longer gates the fail decision alone.

**Files:** `src/config/defaults.ts`, `src/config/schema.ts`, `src/core/retry.ts`, `src/core/pipeline.ts`

## Fix 4: Log agent_completed for Retried Stages

**Diagnostic finding:** When review/validate returns a retry verdict, the `continue` at pipeline.ts:685 skips the `appendDailyLogEntry` block. 7 review stage runs were invisible to daily budget aggregation and monitoring.

**Root cause:** The completion-logging block at pipeline.ts:728 only executes on `decision.action === "continue"`. Retry and fail paths bypass it.

**Design:**

Add an `appendDailyLogEntry` call inside the retry block (between verdict decision and the `continue` statement), before line 685:

```typescript
if (decision.action === "retry") {
  // Log completion even for retried stages — critical for budget accuracy
  try {
    appendDailyLogEntry(interactionsDir, {
      timestamp: new Date().toISOString(),
      type: "agent_completed",
      slug,
      stage,
      agentName: config.agents.names[stage] ?? stage,
      model: runOptions.model ?? "",
      durationSeconds: Math.round(result.durationMs / 1000),
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      artifactPath: `${stage}-output${outputSuffix}.md`,
      agentStreamLog: result.streamLogPath ?? "",
      success: true,
      verdict,
      retryAction: decision.action,
    });
  } catch { /* swallow */ }

  // ... existing retry logic (write feedback, update counters, move to impl) ...
  continue;
}
```

Also add similar logging in the `decision.action === "fail"` block (currently at line 628-639) — failed stages should also log their token usage.

**Files:** `src/core/pipeline.ts` (retry block and fail block inside verdict handling)

## Fix 5: holdReason for Review Gate

**Diagnostic finding:** Review gate hold at pipeline.ts:753-763 sets `status: "hold"` but never sets `holdReason`. Tasks 1 and 3 have undefined holdReason.

**Design:**

One-line fix in the review gate block:

```typescript
if (isReviewGate(stage, state.reviewAfter)) {
  state.status = "hold";
  state.holdReason = "approval_required";  // NEW
  writeRunState(doneDir, state);
  // ...
}
```

**Files:** `src/core/pipeline.ts`

## Fix 6: failTask Clears Stale Hold Metadata

**Diagnostic finding:** Task 2 has `holdReason: "budget_exhausted"` despite being in `status: "failed"`. Stale metadata confuses recovery and status tooling.

**Design:**

In `failTask()`, clear hold-related fields before writing state:

```typescript
function failTask(slug, stage, taskDir, state, errorMsg, fromSubdir) {
  state.status = "failed";
  state.error = errorMsg;
  delete state.holdReason;
  delete state.holdDetail;
  delete state.pausedAtStage;
  writeRunState(taskDir, state);
  // ... existing move and notify logic ...
}
```

**Files:** `src/core/pipeline.ts` (`failTask`)

## Fix 7: Slack-io Daily JSONL Logging

**Diagnostic finding:** `pollSlack()` calls `runner()` directly for Narada, bypassing interaction logging. Slack-io costs invisible to budget and monitoring.

**Design:**

After each `runner()` call in `pollSlack()`, emit a daily log entry:

```typescript
// After the Narada runner call in pollSlack():
const naradaResult = await runner({ stage: "slack-io", ... });

try {
  appendDailyLogEntry(join(runtimeDir, "interactions"), {
    timestamp: new Date().toISOString(),
    type: "agent_completed",
    slug: "slack-io-poll",
    stage: "slack-io",
    agentName: config.agents.names["slackIO"] ?? "Narada",
    model: config.agents.models?.["slack-io"] ?? "haiku",
    durationSeconds: Math.round(naradaResult.durationMs / 1000),
    costUsd: naradaResult.costUsd,
    inputTokens: naradaResult.inputTokens,
    outputTokens: naradaResult.outputTokens,
    success: naradaResult.success,
  });
} catch { /* swallow */ }
```

The runner call currently doesn't capture the result — store it:

```typescript
const naradaResult = await runner({ ... });  // was: await runner({ ... })
```

**Files:** `src/core/watcher.ts` (`pollSlack`)

## Fix 8: Triage Output Persistence + Thread Tracking

**Diagnostic finding:** (a) `triage-output.md` never written because quick-triage has Write disallowed — no audit trail for triage decisions. (b) `astra-*` thread entries never saved — follow-up reply tracking broken.

**Design:**

**(a) Persist triage result in watcher:**

After `parseTriageResult` succeeds in the watcher's `pollSlack()` function, write the parsed result to a per-invocation JSON file. This is done by the watcher (Node.js code), not the agent — Write permissions are irrelevant.

```typescript
// In watcher.ts, after runAstraTriage returns successfully:
if (triageResult) {
  const triageFile = join(runtimeDir, "astra-responses", `triage-${entry.ts.replace(".", "-")}.json`);
  try {
    writeFileSync(triageFile, JSON.stringify(triageResult, null, 2), "utf-8");
  } catch { /* swallow */ }
}
```

**(b) Fix thread tracking for answer actions:**

In the `answer` handler in watcher.ts, move `saveThreadMap` to execute regardless of `executeResult.success` — the thread should be tracked even if the execute failed (so retry detection works):

```typescript
case "answer": {
  try {
    // ... existing quick-execute logic ...

    // Track thread BEFORE checking success — always register the thread
    const answerThreadTs = entry.thread_ts ?? entry.ts;
    const threadMap = loadThreadMap(runtimeDir);
    threadMap[`astra-${entry.ts.replace(".", "-")}`] = answerThreadTs;
    saveThreadMap(runtimeDir, threadMap);

    if (executeResult.success && executeResult.output) {
      // ... outbox entry ...
    } else {
      // ... error notification ...
    }
  } catch (err) {
    // ... error handling ...
  }
  break;
}
```

**Files:** `src/core/watcher.ts` (`pollSlack` answer handler)

## Testing Strategy

Each fix has a corresponding test:

1. **Budget reset:** Test `aggregateTaskTokens` with startIndex > 0. Test `resume()` resets index and budget check passes.
2. **Approve guard:** Test `approveAndResume` with budget-held task where currentStage not in completedStages — should resume at same stage.
3. **Review hard-cap:** Test `decideAfterReview` with `currentIteration > maxReviewRetries` — should return fail.
4. **Retry logging:** Test that daily JSONL gets `agent_completed` entries for retried stages (mock `appendDailyLogEntry`).
5. **holdReason:** Test review gate sets `holdReason = "approval_required"`.
6. **failTask cleanup:** Test failed task has no holdReason/holdDetail/pausedAtStage.
7. **Slack-io logging:** Test `pollSlack` emits daily log entry after Narada run.
8. **Triage persistence:** Test triage JSON file written after parse. Test thread map saved for answer actions.
