# Pipeline Diagnostics Skill — Design Spec

**Date:** 2026-04-08
**Status:** Draft
**Scope:** Claude Code skill for point-in-time diagnostic analysis of the ShaktimaanAI pipeline runtime

## Purpose

A Claude Code skill (`/pipeline-diagnostics`) that reads all logs, artifacts, and state files in the pipeline runtime directory, compares them against the expected behavior defined in the codebase and spec documents, and produces a comprehensive diagnostic report with spec-referenced findings and actionable next steps.

This is a **read-only, point-in-time audit** — not continuous monitoring. A separate follow-up skill may provide real-time monitoring later.

## Scope

The skill audits **all pipeline activity**, not just individual tasks:

- Task pipeline runs (stages, retries, artifacts, state transitions)
- Slack agent (Narada) message lifecycle (inbox, outbox, sent, threads, dedup)
- Astra/Quick agent (triage responses, quick-execute outputs)
- Infrastructure (Heimdall watcher, worktrees, budget, concurrency, directory structure)

## Invocation

```
/pipeline-diagnostics              # Full runtime audit, all tasks
/pipeline-diagnostics <slug>       # Focus Task Pipeline agent on one task; other agents still audit full scope
```

## Architecture

### Coordinator + 4 Parallel Sub-agents

```
User invokes /pipeline-diagnostics
        |
        v
+---------------------+
|   Coordinator        |  <- Reads baselines dynamically from repo + config
|   (main agent)       |  <- Discovers runtime state
|                      |  <- Dispatches sub-agents with baselines + runtime data
+-----+---+---+---+---+
      |   |   |   |
      v   v   v   v      <- Parallel sub-agents
   +----++----++-----++-----+
   |Task||Slack||Astra||Infra|
   |Pipe||Agent||Quick||     |
   |line||    ||     ||     |
   +--+-++--+-++--+--++--+--+
      |     |    |      |
      v     v    v      v
   Findings with spec references
      |     |    |      |
      +-----+----+------+
              |
              v
+---------------------+
|   Coordinator        |  <- Merges findings
|   writes report      |  <- Sorts by severity
|   + next steps       |  <- Saves to diagnostics/
+---------------------+
```

### Coordinator Flow

#### Step 1: Resolve Baselines (dynamic — read fresh every run)

The coordinator reads current source files from the ShaktimaanAI repo to build the expected behavior model. This ensures the skill stays accurate as the codebase evolves.

| Source file | What to extract |
|-------------|----------------|
| `src/core/stage-map.ts` | `PIPELINE_STAGES`, `STAGE_DIR_MAP`, `ALL_STAGE_DIRS`, `STAGES_WITH_PENDING_DONE` |
| `src/config/defaults.ts` | `DEFAULT_STAGE_TOOLS`, `STAGE_ARTIFACT_RULES`, `STAGE_CONTEXT_RULES`, `DEFAULT_CONFIG` (timeouts, models, maxTurns, retry limits, Slack config, worktree config, budget defaults), `DEFAULT_AGENT_NAMES` |
| `src/core/retry.ts` | `VALIDATE_VERDICTS`, `REVIEW_VERDICTS`, `maxRecurrenceHardCap` (3), verdict regex pattern |
| `src/core/types.ts` | `RunState` interface fields, `holdReason` union values, `CompletedStage` fields |
| `src/core/watcher.ts` | Dedup cap (500), Slack polling logic, control file schema |
| `src/core/astra-triage.ts` | `triageResultSchema` fields |
| `shkmn.config.json` | User overrides for all defaults above |
| `docs/superpowers/specs/*.md` | Behavioral contracts for review loop, Slack IO, Astra triage, budget awareness |

The repo root is resolved from `shkmn.config.json` `repos.aliases` or the cwd where the skill is invoked.

#### Step 2: Discover Runtime State

| What | Where |
|------|-------|
| Active/held/failed/complete tasks | `{runtimeDir}/{00-12}/` — scan for `run-state.json` |
| Daily activity logs | `{runtimeDir}/interactions/*.jsonl` |
| System log | `{runtimeDir}/logs/heimdall.log` |
| Task logs | `{runtimeDir}/logs/{slug}.log` |
| Slack queue files | `{runtimeDir}/slack-*.jsonl`, `slack-*.json` |
| Astra responses | `{runtimeDir}/astra-responses/` |
| Stream logs | `{taskDir}/artifacts/*-stream.jsonl` |
| Worktree manifest | `{runtimeDir}/worktree-manifest.json` (if exists) |
| PID file | `{runtimeDir}/shkmn.pid` |

#### Step 3: Dispatch 4 Sub-agents (parallel)

Each sub-agent receives:
- Its checklist of checks to run
- The extracted baselines relevant to its checks
- Paths to the runtime files it needs to read

Sub-agents read runtime files directly (they need file access). They do NOT read source code — baselines are passed to them by the coordinator.

#### Step 4: Merge & Report

- Collect findings arrays from all sub-agents
- Sort by severity: ERROR > WARNING > INFO
- Generate executive summary (counts by severity, worst finding)
- Generate actionable next steps (ERROR first, with concrete commands/investigations)
- Write to `{runtimeDir}/diagnostics/{YYYY-MM-DDTHH-mm-ss}-diagnostic.md`

## Sub-agent Checklists

### Finding Format

Every finding produced by a sub-agent must include:

```typescript
interface DiagnosticFinding {
  checkId: string;        // e.g., "T1", "S3", "I6"
  checkName: string;      // e.g., "Stage Order Compliance"
  severity: "ERROR" | "WARNING" | "INFO";
  description: string;    // What was found
  specReference: string;  // File:line or doc section that defines expected behavior
  evidence: string;       // Actual data that triggered the finding
  suggestion?: string;    // Concrete next step to resolve (for ERROR/WARNING)
}
```

### Task Pipeline Agent (13 checks)

**Input:** run-state.json files, artifacts/, stream JSONLs, daily JSONL (task entries), task logs, baselines.

| ID | Check | What to validate | Severity if violated |
|----|-------|-----------------|---------------------|
| T1 | Stage order compliance | `run-state.json` `.stages` array matches `PIPELINE_STAGES` order (subset allowed, reorder not) | ERROR |
| T2 | Stage completeness | Every entry in `completedStages` has an `outputFile` and that file exists in `artifacts/` | ERROR |
| T3 | Duration vs timeout | Each stage's `durationSeconds` (from daily JSONL `agent_completed`) vs configured `timeoutsMinutes`. Flag >80% of timeout as WARNING, >100% as ERROR | WARNING/ERROR |
| T4 | Model compliance | `model` in `completedStages` matches configured `agents.models[stage]`. Downgrades are INFO if logged, ERROR if unexplained | INFO/ERROR |
| T5 | Verdict format | Review/validate stage output artifacts contain valid verdict strings per `VALIDATE_VERDICTS` / `REVIEW_VERDICTS`. Unknown verdict = ERROR | ERROR |
| T6 | Retry budget compliance | `validateFailCount` <= `maxValidateRetries`, review issue recurrence < `maxRecurrenceHardCap` (3). Exceeded = ERROR | ERROR |
| T7 | Retry feedback loop | Every retry (retryAttempts > 0) has a corresponding `retry-feedback-{stage}-{n}.md` file. Missing = WARNING | WARNING |
| T8 | Hold reason validity | If `status === "hold"`, `holdReason` is one of the valid union values and `holdDetail` is non-empty | ERROR |
| T9 | Cost anomalies | Single stage cost > $2 = WARNING, > $5 = ERROR. Total task cost > $10 = WARNING | WARNING/ERROR |
| T10 | JSONL stream integrity | Stream log has a terminal `result` entry. Every `tool_use` has a matching `tool_result` (by `id`). Truncated = ERROR | ERROR |
| T11 | Artifact context rules | For each completed stage, verify the artifacts passed to it matched `STAGE_ARTIFACT_RULES`. Check that `all_prior` stages got all prior outputs, `specific` stages got only their named files, `none` stages got nothing | WARNING |
| T12 | State transition consistency | `completedStages[].completedAt` timestamps are monotonically increasing. `updatedAt` >= all stage completion timestamps. `startedAt` <= first stage completion | ERROR |
| T13 | Daily log cross-reference | Every `agent_started` entry in interactions JSONL has a matching `agent_completed` or `agent_failed` entry for the same slug+stage. Orphaned starts = ERROR (agent may have crashed without recording) | ERROR |

### Slack Agent (8 checks)

**Input:** slack-*.jsonl, slack-*.json, slack-io-output-stream.jsonl, daily JSONL (slack-io entries), baselines.

| ID | Check | What to validate | Severity if violated |
|----|-------|-----------------|---------------------|
| S1 | Outbox drain | Every `slack-outbox.jsonl` entry has a matching `id` in `slack-sent.jsonl`, or was added < 5 minutes ago (still pending). Stale unset entries = WARNING | WARNING |
| S2 | Thread continuity | Every slug in `slack-threads.json` maps to either a task directory that exists, or an `astra-*` key for quick responses. Orphaned thread mappings = INFO | INFO |
| S3 | Dedup integrity | `slack-processed.json` has <= 500 entries, no duplicate timestamps. Exceeding cap or duplicates = WARNING | WARNING |
| S4 | Inbox processing | `slack-inbox.jsonl` should be empty after a poll cycle (cleared at watcher.ts:314). Non-empty = WARNING (processing may have failed). Cross-reference with daily JSONL for evidence of processing | WARNING |
| S5 | Message format compliance | Sample outbound messages in `slack-sent.jsonl` contain the configured `outboundPrefix`. Missing prefix = WARNING | WARNING |
| S6 | Polling cadence | Time gaps between consecutive `agent_started` entries for `slack-io` stage in daily JSONL. Gap > 2x configured `pollIntervalActiveSec` or `pollIntervalIdleSec` = WARNING | WARNING |
| S7 | Slack IO stream health | `slack-io-output-stream.jsonl` exists, is non-empty, has no entries with error indicators. Terminal entry should be a `result` type | ERROR |
| S8 | Cursor progression | `slack-cursor.json` `channelTs` and `dmTs` values are advancing over time (compare against daily JSONL timestamps). Stuck cursor = WARNING | WARNING |

### Astra/Quick Agent (5 checks)

**Input:** astra-responses/, slack-processed.json, daily JSONL (quick-triage/quick-execute entries), baselines.

| ID | Check | What to validate | Severity if violated |
|----|-------|-----------------|---------------------|
| A1 | Response format | `astra-responses/triage-output.md` exists. Quick-execute outputs (`astra-responses/{ts}.md`) exist and are non-empty. Missing outputs = WARNING | WARNING |
| A3 | Task creation linkage | For each `route_pipeline` action (inferred from daily JSONL: task `agent_started` events shortly after a triage), verify a corresponding task slug exists in stage directories | WARNING |
| A4 | Quick execution completion | For each quick-execute agent run in daily JSONL (`stage: "quick-execute"`), verify a corresponding output file exists in `astra-responses/` and an outbox entry was created for the Slack reply | WARNING |
| A5 | MCP server suggestions | If `run-state.json` has `requiredMcpServers`, check that the stream JSONL for that task shows tool_use entries matching those MCP prefixes (via `MCP_TOOL_PREFIXES` mapping) | INFO |
| A6 | Duplicate triage detection | Check `slack-processed.json` for integrity — no duplicate timestamps. Check daily JSONL for multiple triage runs with suspiciously similar messages within a short window (< 60s) | WARNING |

### Infrastructure Agent (8 checks)

**Input:** heimdall.log, shkmn.pid, worktrees/, worktree-manifest.json, shkmn.config.json, daily JSONL, stage directories, baselines.

| ID | Check | What to validate | Severity if violated |
|----|-------|-----------------|---------------------|
| I1 | Heimdall uptime | Parse `heimdall.log` timestamps. Gaps > configured `heartbeatTimeoutMinutes` (default 10) = WARNING. No log entries at all = ERROR | WARNING/ERROR |
| I2 | PID file validity | `shkmn.pid` exists and contains a numeric PID. If pipeline is expected to be running, verify the process exists (best-effort) | INFO |
| I3 | Worktree lifecycle | Tasks that reached `impl` or later should have `worktreePath` in run-state. If `worktree-manifest.json` exists, completed/failed tasks should have cleanup entries. Worktree dirs in `worktrees/` without active tasks = WARNING | WARNING |
| I4 | Config vs defaults divergence | Diff `shkmn.config.json` values against `DEFAULT_CONFIG`. Report all overrides as INFO (awareness, not errors). Flag missing required fields as ERROR | INFO/ERROR |
| I5 | Budget state consistency | Re-compute budget status from daily JSONL token usage. Verify that any `budget_hold` events in daily JSONL were correctly triggered (model was actually over limit at that timestamp). Incorrect holds = ERROR, missed holds = WARNING | WARNING/ERROR |
| I6 | Concurrent agent limit | Reconstruct concurrent agent count from daily JSONL `agent_started`/`agent_completed` timestamps. Peak concurrent > `maxConcurrentTotal` = ERROR | ERROR |
| I7 | Directory structure integrity | All directories in `ALL_STAGE_DIRS` exist. Stage dirs in `STAGES_WITH_PENDING_DONE` have `pending/` and `done/` subdirs. No task dirs in locations inconsistent with their `run-state.json` status (e.g., task in `06-impl/pending/` but status is `"complete"`) = ERROR | ERROR |
| I8 | EBUSY / file lock errors | Scan `heimdall.log` and task logs for EBUSY/EPERM error patterns. Occurrences that resolved via retry = INFO. Occurrences that fell through to copy+delete fallback = WARNING. Unresolved = ERROR | INFO/WARNING/ERROR |

## Report Format

Output file: `{runtimeDir}/diagnostics/{YYYY-MM-DDTHH-mm-ss}-diagnostic.md`

```markdown
# Pipeline Diagnostic Report
**Generated:** {timestamp}
**Runtime:** {runtimeDir}
**Repo:** {repoRoot}
**Scope:** Full runtime audit | Focused on {slug}

## Executive Summary
- {n} ERRORS, {n} WARNINGS, {n} INFO findings
- Critical: {one-line summary of highest-severity finding}

## Task Pipeline

### T1: Stage Order Compliance [PASS]
No issues found.

### T3: Duration vs Timeout [WARNING]
**Finding:** Stage "design" took 274s (4.6min) for slug "i-would-like-to-..."
**Spec reference:** `src/config/defaults.ts:218` — design timeout: 30min
**Evidence:** Daily JSONL agent_completed durationSeconds=274
**Severity:** INFO — within timeout but notable

## Slack Agent
{... same pattern per check ...}

## Astra/Quick Agent
{... same pattern per check ...}

## Infrastructure
{... same pattern per check ...}

## Actionable Next Steps
1. **[ERROR] T10:** Stream log truncated for design stage — check 
   heimdall.log for crash indicators. Command: 
   `tail -20 {runtimeDir}/logs/heimdall.log`
2. **[WARNING] S6:** 12-min polling gap — check if Narada was blocked. 
   Command: `grep "slack-io" {runtimeDir}/interactions/2026-04-08.jsonl`
3. ...
```

## Key Design Decisions

1. **Dynamic baselines, not hardcoded.** The coordinator reads source files on every invocation. This prevents the skill from going stale as the codebase changes.

2. **Sub-agents don't read source code.** The coordinator extracts baselines and passes them as structured context. Sub-agents only read runtime files. This keeps sub-agents focused and reduces redundant file reads.

3. **Full report every time.** Even clean checks appear in the report (as PASS). This makes the report auditable and confirms coverage.

4. **Severity is check-specific, not uniform.** Each check defines its own severity thresholds. A missing artifact is an ERROR; a cost anomaly is a WARNING. This prevents alert fatigue.

5. **Actionable next steps are concrete.** Not "investigate further" but specific commands, file paths, and log lines to check.

6. **Report persisted to disk.** Written to `{runtimeDir}/diagnostics/` with timestamps, creating a historical audit trail.

7. **Astra triage results are not persisted as structured JSON** (only markdown output survives). The skill works with what exists on disk, not what should theoretically exist.

## Limitations & Future Work

- **No continuous monitoring.** This is a point-in-time snapshot. A follow-up `/pipeline-monitor` skill could poll continuously.
- **No automated remediation.** The skill reports and suggests; it does not fix. Future work could add auto-retry or auto-approve for specific finding patterns.
- **Historical comparison is limited** to available daily JSONL files. Cost anomaly detection (T9) uses absolute thresholds rather than historical percentiles until more data accumulates.
- **Triage classification accuracy (removed A2)** cannot be validated post-hoc without ground truth labels.
