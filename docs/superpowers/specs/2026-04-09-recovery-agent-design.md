# Recovery Agent (Chiranjeevi) — Design

**Date:** 2026-04-09
**Status:** Draft
**Scope:** Self-healing failure recovery — automated diagnosis of failed tasks, GitHub issue filing, startup-based re-entry, watchdog service, and CLI/Slack control surfaces

## Context

When a task fails in the ShaktimaanAI pipeline, it moves to `11-failed/` and stays there permanently. The only current mechanism is a one-shot Slack notification at failure time. Failed tasks require manual investigation — reading run-state, JSONL stream logs, and artifacts to understand why they failed, then manually fixing the pipeline and re-running.

Many failures are caused by pipeline instrumentation issues (wrong tool permissions, insufficient timeouts, bad prompt templates, verdict parsing mismatches) rather than fundamentally impossible tasks. These should be auto-diagnosed, reported, and automatically recovered once the fix is in — leaving `11-failed/` as a graveyard only for truly terminal failures.

### Failure Categories

Based on analysis of the pipeline's failure paths in `pipeline.ts`, `retry.ts`, and `agent-runner.ts`:

1. **Pipeline instrumentation bugs** — wrong tool permissions in `defaults.ts`, insufficient timeouts, bad context rules, prompt template issues, verdict parsing mismatches
2. **Retry exhaustion from pipeline issues** — validate/review loops hit caps because of misconfigured models, missing context, or incorrect prompts (not because the task is hard)
3. **Agent SDK errors** — timeout, abort, no result message — often caused by timeout settings or tool permission issues
4. **Truly terminal failures** — task itself is impossible, out of scope, ambiguous beyond resolution, or caused by external factors (API outage, repo access revoked)

Categories 1–3 are fixable pipeline issues. Category 4 is terminal. The recovery agent's job is to classify and report, not to fix.

## Design Principles

- **The recovery agent diagnoses and reports — it does not write fixes.** Fix authoring is the maintainer's responsibility.
- **Privacy first.** GitHub issues contain only pipeline internals. User task content, repo context, and code never leave the user's machine.
- **Re-entry is automatic on startup.** No special commands needed to recover tasks — just merge the fix and restart the pipeline.
- **Configurable participation.** Users can opt out of the recovery agent entirely, or run diagnosis locally without filing GitHub issues.
- **Conservative re-entry.** When uncertain about which stage to re-enter at, pick an earlier stage. Re-running extra stages is cheap; re-entering too late causes another failure cycle.

## 1. Recovery Agent Identity

**Display name:** Chiranjeevi (the immortal/undying)
**Code identifier:** `recovery`
**Model:** Opus — requires deep reasoning for source code analysis and root cause diagnosis
**Timeout:** 30 minutes
**Tool permissions:** `Read`, `Glob`, `Grep`, `Bash` (for `gh` commands) — no `Write` or `Edit`. The agent reads pipeline source and creates GitHub issues but never modifies code. Run-state updates happen via the pipeline's own state functions, not direct file writes by the agent.

## 2. Trigger

The recovery agent is invoked inline in `failTask()` in `pipeline.ts`, after:
1. The task has been moved to `11-failed/`
2. The Slack failure notification has been sent
3. Run-state has been written with the error

The task is safely in `11-failed/` before the agent starts. If the recovery agent itself fails, times out, or hits the budget cap, the task remains in `11-failed/` unanalyzed — it will be retried on next startup (see Section 5).

The recovery agent registers itself in the agent registry (`src/core/registry.ts`) like any other agent, so pipeline drain logic naturally includes it.

## 3. Diagnostic Flow

### Step 1 — Gather Evidence

- Read `run-state.json` from the failed task directory: `error`, `currentStage`, `completedStages`, `validateFailCount`, `reviewRetryCount`, `reviewIssues`, `retryAttempts`
- Read the JSONL stream log for the failed stage: `artifacts/{stage}-output-stream.jsonl`
- Read the failed stage's output artifact (including retry outputs: `{stage}-output-r{n}.md`)
- Read retry feedback files: `artifacts/retry-feedback-{stage}-{n}.md`

### Step 2 — Gather Pipeline Context

Read relevant pipeline source files based on the failed stage:

| Always read | Conditionally read |
|---|---|
| `src/config/defaults.ts` (tool permissions, context rules, timeouts, models) | `src/core/retry.ts` — if verdict-related failure |
| `src/core/pipeline.ts` (stage routing, error handling) | `src/core/agent-runner.ts` — if agent execution error |
| `agents/{stage}.md` (prompt template for the failed stage) | `src/core/stage-map.ts` — if context/artifact issue |

### Step 3 — Classify

The agent produces a structured classification:

- **`terminal`** — The task itself is fundamentally flawed (impossible requirement, out of scope, ambiguous beyond resolution) or the failure is caused by external factors completely outside the pipeline (API outage, repo access revoked, etc.)
- **`fixable`** — The failure was caused by something in the pipeline: wrong tool permissions, insufficient timeout, bad prompt instructions, incorrect context rules, verdict parsing mismatch, missing error handling, etc.

### Step 4 — Determine Re-entry Point

For fixable failures, the agent identifies the earliest stage affected by the issue:

| Issue type | Re-entry point |
|---|---|
| Context rule fix for `design` | `design` |
| Timeout increase for `impl` | `impl` |
| Tool permission fix for `review` | `review` |
| Prompt template fix for `validate` | `validate` |
| Cross-cutting config change | Earliest affected stage |

When uncertain, the agent picks an earlier stage (conservative).

The re-entry stage is written to `run-state.json` as `recoveryReEntryStage`.

## 4. Actions After Classification

### Terminal Failure

1. Tag `run-state.json`: set `terminalFailure: true`, write `recoveryDiagnosis` with full diagnosis
2. Write `artifacts/recovery-diagnosis.md` with complete analysis (stays local)
3. Post follow-up message in the Slack failure thread: "Analyzed — terminal failure. {diagnosis summary}"
4. Task stays in `11-failed/`

### Fixable Failure

1. Write full diagnosis to `run-state.json` (`recoveryDiagnosis`, `recoveryReEntryStage`) and `artifacts/recovery-diagnosis.md`
2. **If `recovery.fileGithubIssues: true`:**
   - Search existing open issues with `recovery-agent` label for similar root cause (`gh issue list --label recovery-agent --state open`)
   - If match found: add comment to existing issue ("Also affecting task `{sanitized-hash}`"), store that issue's URL/number in run-state
   - If no match: file new GitHub issue (see Section 7 for privacy rules)
   - Store `recoveryIssueUrl` and `recoveryIssueNumber` in `run-state.json`
3. Move task from `11-failed/` to `12-hold/` with `holdReason: "awaiting_fix"` and `recoveryReEntryStage`
4. Post to Slack failure thread: "Diagnosed pipeline issue. {issue link if filed}. Task moved to hold. Will auto-recover when fix is in."

### Recovery Agent Failure (agent itself errors/times out/budget exhausted)

- Task stays in `11-failed/` with no `terminalFailure` flag and no `recoveryIssueUrl`
- No partial state written — task is cleanly "unanalyzed"
- Retried automatically on next startup (see Section 5)

## 5. Startup Recovery Scan

Extended in `recovery.ts`. Runs on every pipeline startup, before the existing recovery scan.

### Phase 1 — Unanalyzed Failures

Scan `11-failed/` for tasks where `run-state.json` has neither `terminalFailure: true` nor `recoveryIssueUrl` nor `recoveryDiagnosis`. These are tasks the recovery agent never completed analysis on.

Action: Re-invoke the recovery agent on each (same diagnostic flow as Section 3). Subject to budget constraints — if daily budget is exhausted, remaining unanalyzed tasks wait for next startup.

### Phase 2 — Held Tasks with GitHub Issues

Only when `recovery.fileGithubIssues: true`.

Scan `12-hold/` for tasks with `holdReason: "awaiting_fix"` that have a `recoveryIssueNumber`.

For each:
- Check issue status: `gh issue view <number> --json state,stateReason`
- **Closed as completed** → auto-recover (see Section 6 re-entry mechanics)
- **Closed as not planned** → terminal: move from `12-hold/` to `11-failed/`, set `terminalFailure: true`, notify Slack: "Task `{slug}` moved to failed — issue {link} closed as not planned."
- **Still open** → leave in `12-hold/`, log

### Phase 3 — Held Tasks without GitHub Issues

Only when `recovery.fileGithubIssues: false`.

Tasks with `holdReason: "awaiting_fix"` but no `recoveryIssueNumber` — these require manual re-entry via CLI or Slack (see Section 8).

### Ordering

Phase 1 → Phase 2 → Phase 3 → existing `scanForRecovery()` (pending/done/inbox dirs)

## 6. Re-entry Mechanics

When a task is recovered (via startup scan or manual command), the following steps execute:

1. **Archive downstream artifacts**: Move all artifacts for the re-entry stage and downstream stages to `artifacts/pre-recovery/`. Preserves forensic trail without confusing downstream agents with stale outputs.
2. **Move task directory**: From `12-hold/{slug}/` to `{recoveryReEntryStage}/pending/{slug}/`
3. **Reset run-state**:
   - Clear `error`
   - Set `status` to `"running"`
   - Set `currentStage` to the re-entry stage
   - Clear `validateFailCount`, `reviewRetryCount`, `reviewIssues` for the re-entry stage and all downstream stages
   - Clear `retryAttempts` for the re-entry stage and downstream
   - Preserve `completedStages` entries upstream of re-entry (no wasted re-work)
   - Clear `holdReason`, `recoveryIssueUrl`, `recoveryIssueNumber`, `recoveryReEntryStage`
4. **Notify Slack**: "Task `{slug}` auto-recovered into `{stage}` — issue {link} resolved." (or "manually re-entered" for manual triggers)
5. The existing recovery scan picks up the task in `{stage}/pending/` and resumes normal pipeline execution.

## 7. Privacy — GitHub Issue Content Rules

GitHub issues filed by the recovery agent contain **only pipeline-internal information**:

### Included (safe)

- Failed stage name (e.g., "review", "validate")
- Pipeline error message (from the pipeline's own error handling, not agent output)
- Affected pipeline source file (e.g., "tool permission config in defaults.ts")
- Retry counts, timeout values, model assignments
- Verdict parsing outcome (e.g., "unknown verdict", "NEEDS_FIXES exceeded retries")
- Agent configuration: model, timeout, tool permissions for the failed stage

### Excluded (never sent)

- Task content (the `.task` file body — user's requirements and descriptions)
- Task slug (could reveal project names) — replaced with a sanitized hash
- Repository context / repo summary
- Artifact content (stage outputs containing analysis of user's code)
- File paths from user's repository
- JSONL stream log content (contains agent conversation with user's code context)
- Any content derived from or referencing user's codebase

The full diagnosis in `run-state.json` and `artifacts/recovery-diagnosis.md` stays on the user's machine and can contain complete context.

## 8. CLI & Slack Commands

### CLI

| Command | Behavior |
|---|---|
| `shkmn recover` | List all tasks in `12-hold/` with `holdReason: "awaiting_fix"`. Show: slug, diagnosis summary, issue link (if any), issue state, re-entry stage. |
| `shkmn recover <slug>` | Detailed status for one task: full diagnosis, issue link, issue state, re-entry stage, archived artifacts. |
| `shkmn recover <slug> --reenter` | Manually move task back to the diagnosed re-entry stage. Executes the re-entry mechanics from Section 6. Works regardless of config — always available as an override. |

### Slack

| Trigger | Behavior |
|---|---|
| Thread reply: `recover` or `@shkmn recover` | **`fileGithubIssues: true`**: Reply with status (issue state, re-entry stage). **`fileGithubIssues: false`**: Trigger re-entry (same as `--reenter`). |
| Standalone: `@shkmn recover <slug>` | Same behavior as thread reply, using provided slug. |
| Thread reply or standalone (always) | Works as manual override for re-entry when `fileGithubIssues: true` — skips waiting for issue closure. |

Narada (slack-io agent) routes these commands. Thread replies extract the slug from thread context. Standalone commands require an explicit slug.

**Error responses:**
- Task not in `12-hold/`: "Task `{slug}` is not awaiting a fix. Current location: `{actual directory}`."
- No slug provided in standalone: "Usage: `@shkmn recover <slug>`"

## 9. Watchdog Service

### Purpose

Keep the pipeline alive and up-to-date. A pure shell script (no Node.js, no pipeline imports) that cannot be broken by pipeline code bugs.

### Setup

`shkmn service install` generates `~/.shkmn/shkmn-watchdog.sh` and registers it as a Windows Task Scheduler job.

### Watchdog Logic

```
1. Read PID from ~/.shkmn/shkmn.pid
2. Check if PID is a running process
3. If running → exit
4. If not running:
   a. Source mode:  git pull origin master && npm run build
      Package mode: npm update -g shaktimaanai
   b. shkmn run  (writes PID file on startup)
   c. Log restart event to ~/.shkmn/watchdog.log with timestamp
```

### Crash Loop Protection

Track consecutive failed starts (pipeline exits within 60 seconds of starting):
- After 3 consecutive crash-starts → enter backoff mode: increase check interval to 30 minutes
- Post Slack notification: "Pipeline crash loop detected — backing off. Check `~/.shkmn/watchdog.log`."
- Reset to normal interval on first successful start (pipeline runs > 60 seconds)

### PID File Contract

- `shkmn run` writes PID to `~/.shkmn/shkmn.pid` on startup
- `shkmn run` deletes PID file on graceful shutdown (SIGINT, SIGTERM)
- Watchdog validates PID is alive (handles stale PID from crash — process no longer exists)

### Commands

| Command | Behavior |
|---|---|
| `shkmn service install` | Generate watchdog script, register scheduled task (every N minutes from config) |
| `shkmn service uninstall` | Remove scheduled task, delete watchdog script |
| `shkmn service status` | Show: registered or not, last run time, last restart event, current interval, crash loop state |
| `shkmn service logs` | Tail `~/.shkmn/watchdog.log` |

## 10. Configuration

New section in `shkmn.config.json` (validated by Zod schema in `src/config/schema.ts`):

```json
{
  "recovery": {
    "enabled": true,
    "fileGithubIssues": true,
    "githubRepo": "prpande/ShaktimaanAI"
  },
  "service": {
    "mode": "source",
    "repoPath": "/c/src/ShaktimaanAI",
    "checkIntervalMinutes": 5
  }
}
```

### `recovery` section

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` disables the recovery agent entirely. Failed tasks go to `11-failed/` with no analysis. |
| `fileGithubIssues` | boolean | `true` (source) / `false` (package) | Whether to file GitHub issues for fixable failures. When `false`, diagnosis is local-only. |
| `githubRepo` | string | `"prpande/ShaktimaanAI"` | Repository to file issues against. Only used when `fileGithubIssues: true`. |

### `service` section

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"source"` \| `"package"` | `"source"` | Determines watchdog update strategy: `git pull + build` vs `npm update`. |
| `repoPath` | string | — | Path to the ShaktimaanAI repo clone. Required in source mode. |
| `checkIntervalMinutes` | number | `5` | How often the watchdog checks if the pipeline is alive. |

## 11. Run-State Extensions

New fields added to the `RunState` interface in `src/core/types.ts`:

```typescript
// Recovery agent output
terminalFailure?: boolean;           // true if recovery agent classified as terminal
recoveryDiagnosis?: string;          // Summary of recovery agent's analysis
recoveryReEntryStage?: string;       // Stage to re-enter at after fix
recoveryIssueUrl?: string;           // GitHub issue URL (if filed)
recoveryIssueNumber?: number;        // GitHub issue number (if filed)
```

These fields are set by the recovery agent and read by the startup scan and CLI/Slack commands.

## 12. New Files

| File | Purpose |
|---|---|
| `src/core/recovery-agent.ts` | Recovery agent invocation, diagnostic flow, classification logic, issue filing |
| `src/commands/recover.ts` | `shkmn recover` CLI command handler |
| `src/commands/service.ts` | `shkmn service install/uninstall/status/logs` CLI command handler |
| `agents/recovery.md` | Prompt template for the Chiranjeevi recovery agent |
| `templates/shkmn-watchdog.sh` | Watchdog shell script template (interpolated with config values at install time) |

## 13. Modified Files

| File | Change |
|---|---|
| `src/core/pipeline.ts` | Add recovery agent invocation in `failTask()`, gated by `recovery.enabled` config |
| `src/core/recovery.ts` | Add Phase 1/2/3 startup scans before existing `scanForRecovery()` |
| `src/core/types.ts` | Add `RunState` fields (Section 11), add `holdReason: "awaiting_fix"` to union |
| `src/config/schema.ts` | Add Zod schema for `recovery` and `service` config sections |
| `src/config/defaults.ts` | Add `recovery` stage to tool permissions, context rules, model/timeout defaults |
| `src/commands/index.ts` | Register `recover` and `service` commands |
| `src/core/slack-notifier.ts` | Add formatting for recovery diagnosis Slack messages (thread follow-ups) |

## 14. Self-Healing Loop (End-to-End)

The complete loop for a fixable pipeline failure:

```
1. Task fails at stage X
   ↓
2. failTask() moves task to 11-failed/, sends Slack notification
   ↓
3. Recovery agent (Chiranjeevi) invoked inline
   ↓
4. Diagnoses root cause, classifies as fixable
   ↓
5. Files GitHub issue (if configured), moves task to 12-hold/
   ↓
6. Posts diagnosis + issue link to Slack failure thread
   ↓
7. Maintainer picks up issue, writes fix, merges to master
   ↓
8. Pipeline stops (crash, manual stop, or natural shutdown)
   ↓
9. Watchdog detects pipeline is down (within 5 minutes)
   ↓
10. Watchdog: git pull → npm run build → shkmn run
    ↓
11. Startup scan: checks 12-hold/, sees issue is closed
    ↓
12. Archives downstream artifacts, moves task to {reEntryStage}/pending/
    ↓
13. Pipeline resumes task at the correct stage with fresh code
    ↓
14. Task completes successfully
```

For the `fileGithubIssues: false` path, steps 7–11 are replaced by: maintainer fixes + releases new version → watchdog updates package → human triggers `shkmn recover <slug> --reenter` or Slack `recover` → pipeline resumes.

## 15. Budget

The recovery agent uses the pipeline's existing daily budget system. No separate per-analysis cap.

- If daily budget is exhausted mid-analysis: the recovery agent stops, task stays in `11-failed/` unanalyzed
- On next startup with fresh budget: the Phase 1 unanalyzed scan picks it up
- Recovery agent cost is tracked in `interactions/` like any other agent (duration, cost, tokens, turns)

## 16. Edge Cases

| Scenario | Behavior |
|---|---|
| Recovery agent itself fails | Task stays in `11-failed/` unanalyzed. Phase 1 startup scan retries. |
| Budget exhausted mid-analysis | Same as agent failure — unanalyzed, retried on next startup. |
| Same bug causes multiple failures | Dedup: search existing open `recovery-agent` issues before filing. Link additional tasks as comments. |
| Stale downstream artifacts on re-entry | Archived to `artifacts/pre-recovery/` before re-entry. |
| `gh` CLI not available | If `fileGithubIssues: true` but `gh` is missing/unauthed: log warning, fall back to local-only diagnosis. Task still moves to `12-hold/` but without issue link — requires manual re-entry. |
| Watchdog crash loop | After 3 consecutive crash-starts within 60s: backoff to 30 min, Slack notification. |
| Issue closed then reopened | Task already recovered on closure. If it fails again at the same stage, recovery agent diagnoses again and files a new issue. |
| Pipeline draining while recovery agent runs | Recovery agent is registered in agent registry. Drain waits for it to complete. |
| Re-entry stage diagnosis is wrong | Task fails again, recovery agent diagnoses again with more context. Conservative default mitigates. |
