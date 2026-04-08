---
description: Audit the ShaktimaanAI pipeline runtime — reads logs, artifacts, and state files, compares against expected behavior, and produces a diagnostic report with spec-referenced findings.
argument-hint: "[optional: task slug to focus on]"
---

# Pipeline Diagnostics

You are a diagnostic coordinator for the ShaktimaanAI pipeline. Your job is to audit the runtime directory, compare everything against expected behavior, and produce a comprehensive report.

## Step 1: Resolve Configuration

Read the pipeline config to find the runtime directory. The CLI resolves config in this order:

1. `$SHKMN_CONFIG` environment variable (if set and file exists)
2. `./shkmn.config.json` (current working directory)
3. `~/.shkmn/runtime/shkmn.config.json`

Read `pipeline.runtimeDir` from the first config file found. If none exist, default to `~/.shkmn/runtime/`.

Also resolve the ShaktimaanAI repo root. Check `repos.aliases` in config, or use the current working directory if it contains `src/core/pipeline.ts`.

## Step 2: Read Baselines from Source Code

Read each of these files from the ShaktimaanAI repo and extract the specified constants. These define expected behavior — they may change as the codebase evolves.

| File | Extract |
|------|---------|
| `src/core/stage-map.ts` | `PIPELINE_STAGES` array (ordered stage names), `STAGE_DIR_MAP` (stage→directory), `ALL_STAGE_DIRS`, `STAGES_WITH_PENDING_DONE` |
| `src/config/defaults.ts` | `DEFAULT_STAGE_TOOLS` (per-stage tool permissions), `STAGE_ARTIFACT_RULES` (artifact passing rules per stage), `STAGE_CONTEXT_RULES`, `DEFAULT_CONFIG` object (all defaults: timeouts, models, maxTurns, retry limits, Slack config, worktree config, budget), `DEFAULT_AGENT_NAMES`, `DEFAULT_BUDGET_CONFIG` |
| `src/core/retry.ts` | `VALIDATE_VERDICTS` array, `REVIEW_VERDICTS` array, verdict regex pattern (`/\*\*verdict:\*\*\s*([A-Z_]+)/i`), `maxRecurrenceHardCap` value (the constant used in `decideAfterReview`) |
| `src/core/types.ts` | `RunState` interface fields, `holdReason` union type values, `CompletedStage` interface fields, `AstraTriageResult` interface |
| `src/core/watcher.ts` | Dedup cap (the number in the `processedTs.size > N` check), control file schema operations |
| `src/core/astra-triage.ts` | `triageResultSchema` field definitions |
| `shkmn.config.json` | Full config — user overrides for all defaults above |
| `docs/superpowers/specs/*.md` | List all spec files. Read key specs: system design, slack-io-agent, astra-quick-triage, pipeline-review-loop-optimization, token-budget-awareness. Extract behavioral contracts from each. |

Compile these into a structured baselines summary. You will pass relevant portions to each sub-agent.

## Step 3: Discover Runtime State

Scan the runtime directory and build an inventory:

1. **Tasks**: For each directory in `{runtimeDir}/{00-inbox through 12-hold}`, find all `run-state.json` files. Record: slug, current location (which stage dir + pending/done), status, currentStage.
2. **Daily JSONL logs**: List `{runtimeDir}/interactions/*.jsonl` files. Read all of them — they contain `agent_started`, `agent_completed`, `agent_failed`, `stage_transition`, `budget_hold` events.
3. **System log**: Read `{runtimeDir}/logs/heimdall.log` (if exists).
4. **Task logs**: List `{runtimeDir}/logs/*.log` (excluding heimdall.log).
5. **Slack files**: Check existence and read `slack-outbox.jsonl`, `slack-inbox.jsonl`, `slack-sent.jsonl`, `slack-threads.json`, `slack-processed.json`, `slack-cursor.json`, `slack-io-output-stream.jsonl`.
6. **Astra responses**: List `{runtimeDir}/astra-responses/` contents.
7. **Worktree manifest**: Read `{runtimeDir}/worktree-manifest.json` if it exists.
8. **PID file**: Read `{runtimeDir}/shkmn.pid` if it exists.
9. **Stream logs**: For each task found in step 1, list `artifacts/*-stream.jsonl` files.

If a slug argument was provided, note it for the Task Pipeline agent to focus on.

## Step 4: Dispatch Sub-agents

Launch these 4 agents in parallel using the Agent tool. Each agent receives its checklist, the relevant baselines, and the paths to runtime files it needs to read.

**IMPORTANT:** All 4 Agent tool calls must be in a single message so they run in parallel.

### Sub-agent 1: Task Pipeline Diagnostics

Prompt the agent with:
- The task inventory (slugs, locations, statuses)
- The baselines: PIPELINE_STAGES, timeoutsMinutes, models, VALIDATE_VERDICTS, REVIEW_VERDICTS, verdict regex, maxValidateRetries, maxRecurrenceHardCap, STAGE_ARTIFACT_RULES, holdReason values, DEFAULT_BUDGET_CONFIG cost thresholds
- The daily JSONL entries filtered to task-related types (agent_started, agent_completed, agent_failed, stage_transition)
- If a slug was specified, instruct it to focus on that task but still validate daily log consistency for all tasks
- The full checklist T1–T13 with instructions for each check (see Appendix A below)

### Sub-agent 2: Slack Agent Diagnostics

Prompt the agent with:
- Paths to all slack-* files
- The baselines: outboundPrefix, pollIntervalActiveSec, pollIntervalIdleSec, dedup cap (from watcher.ts baselines)
- The daily JSONL entries filtered to slack-io type events
- The full checklist S1–S8 with instructions for each check (see Appendix B below)

### Sub-agent 3: Astra/Quick Agent Diagnostics

Prompt the agent with:
- Path to astra-responses/ directory
- Path to slack-processed.json
- The baselines: triageResultSchema fields, MCP_TOOL_PREFIXES mapping
- The daily JSONL entries filtered to quick-triage and quick-execute events
- The full checklist A1, A3–A6 with instructions for each check (see Appendix C below)

### Sub-agent 4: Infrastructure Diagnostics

Prompt the agent with:
- Paths to heimdall.log, shkmn.pid, worktrees/, worktree-manifest.json
- The baselines: ALL_STAGE_DIRS, STAGES_WITH_PENDING_DONE, maxConcurrentTotal, worktree retentionDays, DEFAULT_CONFIG vs shkmn.config.json diff, DEFAULT_BUDGET_CONFIG
- The daily JSONL entries (all types, for concurrency analysis)
- The full checklist I1–I8 with instructions for each check (see Appendix D below)

### Sub-agent Output Format

Instruct each sub-agent to return its findings as a structured markdown section with this format per check:

```
### {ID}: {Check Name} [{PASS|ERROR|WARNING|INFO}]

{If PASS: "No issues found."}

{If finding:}
**Finding:** {description}
**Spec reference:** {file:line or doc section}
**Evidence:** {actual data}
**Severity:** {ERROR|WARNING|INFO}
**Suggestion:** {concrete next step}
```

## Step 5: Merge and Write Report

After all 4 sub-agents return:

1. Collect all findings sections.
2. Count severities: total ERRORS, WARNINGS, INFO.
3. Identify the highest-severity finding for the executive summary.
4. Compile the actionable next steps list (ERROR items first, then WARNING, skip INFO unless fewer than 3 total findings).
5. Assemble the full report in this structure:

```markdown
# Pipeline Diagnostic Report
**Generated:** {current ISO timestamp}
**Runtime:** {runtimeDir}
**Repo:** {repoRoot}
**Scope:** Full runtime audit | Focused on {slug}

## Executive Summary
- {n} ERRORS, {n} WARNINGS, {n} INFO findings
- Critical: {one-line summary of highest-severity finding, or "No critical issues" if 0 errors}

## Task Pipeline
{Sub-agent 1 output — all T1-T13 sections}

## Slack Agent
{Sub-agent 2 output — all S1-S8 sections}

## Astra/Quick Agent
{Sub-agent 3 output — all A1,A3-A6 sections}

## Infrastructure
{Sub-agent 4 output — all I1-I8 sections}

## Actionable Next Steps
{Numbered list, ERROR first, with concrete commands/file paths}
```

6. Create the diagnostics directory if it doesn't exist: `{runtimeDir}/diagnostics/`
7. Write the report to `{runtimeDir}/diagnostics/{YYYY-MM-DDTHH-mm-ss}-diagnostic.md`
8. Display a summary to the user: severity counts + any ERROR findings + path to the saved report.

---

## Appendix A: Task Pipeline Checklist (T1–T13)

For each task found in the runtime directory, run these checks. Read the task's `run-state.json`, its `artifacts/` directory, its stream JSONL logs, and the corresponding daily JSONL entries.

**T1 — Stage Order Compliance:**
Read `run-state.json` `.stages` array. Verify it is a valid subsequence of `PIPELINE_STAGES` (elements in the same relative order, skipping allowed, reordering not). If stages are out of order relative to PIPELINE_STAGES, report ERROR.

**T2 — Stage Completeness:**
For each entry in `completedStages`, verify `outputFile` is set and the file exists at `artifacts/{outputFile}`. Missing artifact file = ERROR. Missing `outputFile` field = ERROR.

**T3 — Duration vs Timeout:**
For each completed stage, find the matching `agent_completed` entry in daily JSONL (match by slug + stage). Compare `durationSeconds` against the configured timeout: `timeoutsMinutes[stage] * 60`. Duration > 80% of timeout = WARNING. Duration > timeout = ERROR. If no matching daily JSONL entry found, note as WARNING ("missing daily log entry — see T13").

**T4 — Model Compliance:**
For each `completedStages` entry, compare `model` field against configured `agents.models[stage]`. If different: check daily JSONL for a `budget_hold` or downgrade log near that stage's timestamp. If downgrade is logged = INFO. If no explanation found = ERROR.

**T5 — Verdict Format:**
For stages "validate" and "review" only: read the output artifact file. Apply the verdict regex (`/\*\*verdict:\*\*\s*([A-Z_]+)/i`). For validate: result must be in VALIDATE_VERDICTS. For review: result must be in REVIEW_VERDICTS. Unknown or missing verdict = ERROR. Only check the latest retry artifact for each stage (highest `-rN` suffix).

**T6 — Retry Budget Compliance:**
Read `validateFailCount` from run-state. Must be <= `maxValidateRetries`. Read `reviewIssues` — any issue where `(lastSeen - firstSeen + 1) >= maxRecurrenceHardCap` should have triggered a failure. If task is still running despite exceeded limits = ERROR.

**T7 — Retry Feedback Loop:**
For each stage in `retryAttempts` where count > 0: verify `artifacts/retry-feedback-{stage}-{n}.md` exists for n = 1 through retryAttempts[stage]. Missing feedback file = WARNING.

**T8 — Hold Reason Validity:**
If `status === "hold"`: verify `holdReason` is one of the valid values from the baselines. Verify `holdDetail` is non-empty. Missing or invalid holdReason = ERROR. Empty holdDetail = WARNING.

**T9 — Cost Anomalies:**
For each `completedStages` entry: `costUsd > 2.0` = WARNING, `> 5.0` = ERROR. Sum all `costUsd` across completedStages: total `> 10.0` = WARNING, `> 20.0` = ERROR.

**T10 — JSONL Stream Integrity:**
For each `*-stream.jsonl` file in artifacts: read the last line. It should be a JSON object with `"type": "result"`. If not = ERROR (stream truncated). Also scan for `tool_use` entries and verify each has a matching `tool_result` with the same `id`. Unmatched tool_use = WARNING.

**T11 — Artifact Context Rules:**
For each completed stage, check which artifact files exist in the artifacts directory at the time that stage ran (use completedStages timestamps to determine ordering). Compare against `STAGE_ARTIFACT_RULES[stage]`: mode `none` should have received no prior artifacts (check the stage's stream JSONL for whether prior output was passed), mode `specific` should only reference the named files, mode `all_prior` should reference all prior stage outputs. Mismatches = WARNING.

**T12 — State Transition Consistency:**
Read `completedStages[].completedAt` timestamps. They must be monotonically increasing (each >= previous). `startedAt` must be <= first completedStage timestamp. `updatedAt` must be >= last completedStage timestamp. Any violation = ERROR.

**T13 — Daily Log Cross-Reference:**
For each `agent_started` entry in daily JSONL matching this task's slug: find a corresponding `agent_completed` or `agent_failed` entry with the same slug + stage. Orphaned `agent_started` (no completion) = ERROR unless the task is currently running that stage.

## Appendix B: Slack Agent Checklist (S1–S8)

**S1 — Outbox Drain:**
Read `slack-outbox.jsonl` and `slack-sent.jsonl`. For each outbox entry, search sent entries for a matching `id`. If no match and the outbox entry's `addedAt` is > 5 minutes old = WARNING. Count stale entries.

**S2 — Thread Continuity:**
Read `slack-threads.json`. For each key: if it starts with `astra-` it's a quick-response thread (valid). Otherwise treat it as a task slug — verify a task directory exists somewhere in the runtime stage directories or 10-complete/11-failed/12-hold. Orphaned thread = INFO.

**S3 — Dedup Integrity:**
Read `slack-processed.json` (JSON array of timestamp strings). Count entries — must be <= the dedup cap from baselines (extracted from `watcher.ts`). Check for duplicate values. Exceeding the cap = WARNING (cap logic may be broken). Duplicates = WARNING.

**S4 — Inbox Processing:**
Read `slack-inbox.jsonl`. If non-empty = WARNING ("inbox has unprocessed entries — Narada may not have completed last poll cycle"). List the entries.

**S5 — Message Format Compliance:**
Read `slack-sent.jsonl`. For each entry with a `text` field (if present), check if it contains the configured `outboundPrefix`. Sample up to 10 entries. Missing prefix in any = WARNING.

**S6 — Polling Cadence:**
From daily JSONL, extract all `agent_started` entries where `stage === "slack-io"`. Sort by timestamp. Compute gaps between consecutive entries. Compare each gap against `2 * pollIntervalActiveSec` (for gaps during active tasks) or `2 * pollIntervalIdleSec` (otherwise). Gap exceeding threshold = WARNING. Report the largest gap.

**S7 — Slack IO Stream Health:**
Read `{runtimeDir}/slack-io-output-stream.jsonl`. Verify it exists and is non-empty. Check last line for `"type": "result"`. Scan for any entries containing `"error"` keys. Missing or empty file = ERROR. Error entries = WARNING. No terminal result = WARNING.

**S8 — Cursor Progression:**
Read `slack-cursor.json`. Extract `channelTs` and `dmTs`. Compare against the earliest and latest timestamps in today's daily JSONL. If cursor timestamps are older than the earliest daily JSONL entry = WARNING ("cursor appears stuck"). If cursor.json doesn't exist = INFO.

## Appendix C: Astra/Quick Agent Checklist (A1, A3–A6)

**A1 — Response Format:**
Check `{runtimeDir}/astra-responses/` directory. Verify `triage-output.md` exists and is non-empty. List all other `.md` files — these are quick-execute outputs. Verify each is non-empty. Also check for corresponding `*-stream.jsonl` files. Missing triage output = WARNING. Empty quick-execute outputs = WARNING.

**A3 — Task Creation Linkage:**
From daily JSONL, find all `agent_started` events where `stage` is one of the pipeline stages (questions, research, etc.) — these represent pipeline tasks. For each, verify the slug exists as a directory in one of the stage directories or terminal directories (10-complete, 11-failed, 12-hold). Missing task directory = WARNING.

**A4 — Quick Execution Completion:**
From daily JSONL, find all `agent_completed` entries where `stage === "quick-execute"`. For each, extract the slug (format: `astra-exec-{ts}`). Verify a corresponding output file exists in `astra-responses/` (the `{ts}.md` file where ts matches). Also check `slack-outbox.jsonl` or `slack-sent.jsonl` for an entry with a matching slug or timestamp. Missing output = WARNING. Missing outbox entry = WARNING.

**A5 — MCP Server Suggestions:**
For each task with `requiredMcpServers` in its `run-state.json`: read the task's stream JSONL files. Search for `tool_use` entries. Check if any tool names match the MCP prefixes from `MCP_TOOL_PREFIXES` mapping (e.g., `requiredMcpServers: ["slack"]` should show tool_use entries starting with `mcp__claude_ai_Slack__`). Suggested MCP tools never used = INFO.

**A6 — Duplicate Triage Detection:**
Read `slack-processed.json`. Check for duplicate timestamp values. Also check daily JSONL for multiple `agent_started` entries with `stage === "quick-triage"` within a 60-second window. Duplicates in processed set = WARNING. Rapid-fire triage runs = INFO (may be legitimate for different messages).

## Appendix D: Infrastructure Checklist (I1–I8)

**I1 — Heimdall Uptime:**
Read `{runtimeDir}/logs/heimdall.log`. Parse each line's timestamp (format: `[YYYY-MM-DDTHH:mm:ss.sssZ]`). Compute gaps between consecutive log entries. Gap > `heartbeatTimeoutMinutes` (from baselines, default 10) in minutes = WARNING. No log file or empty = ERROR.

**I2 — PID File Validity:**
Read `{runtimeDir}/shkmn.pid`. Verify contents is a numeric PID. Run `ps -p {pid}` (or equivalent) to check if process is running. If PID file exists but process is dead = INFO ("stale PID file — pipeline may have crashed"). If no PID file = INFO.

**I3 — Worktree Lifecycle:**
For each task that has `completedStages` including "impl" or later: verify `worktreePath` is set in run-state. If set, check if the directory exists at that path. Read `worktree-manifest.json` if it exists — completed/failed tasks should have a manifest entry. Worktree directories in `{runtimeDir}/worktrees/` that don't correspond to any active task = WARNING ("orphaned worktree").

**I4 — Config vs Defaults Divergence:**
Read `shkmn.config.json`. Compare key fields against `DEFAULT_CONFIG` from baselines. Report every override as INFO with the default value and configured value. If `shkmn.config.json` is missing required top-level keys (pipeline, repos, agents) = ERROR.

**I5 — Budget State Consistency:**
Read all daily JSONL entries. For each model (sonnet, opus, haiku), sum `inputTokens + outputTokens` from `agent_completed` entries for today. Compare against `DEFAULT_BUDGET_CONFIG` (or usage-budget.json if it exists) daily limits (accounting for safety margin and peak hours). Then find all `budget_hold` entries in daily JSONL. For each hold, verify the model was actually over limit at that timestamp by re-summing tokens up to that point. Incorrect hold (under limit but held) = ERROR. Missed hold (over limit but no hold recorded) = WARNING.

**I6 — Concurrent Agent Limit:**
From daily JSONL, build a timeline: each `agent_started` increments concurrent count, each `agent_completed`/`agent_failed` decrements. Track the peak concurrent count and when it occurred. Peak > `maxConcurrentTotal` = ERROR. Report the exact timestamps and agent names at peak.

**I7 — Directory Structure Integrity:**
Verify all directories in `ALL_STAGE_DIRS` exist under runtimeDir. For each directory in `STAGES_WITH_PENDING_DONE`, verify `pending/` and `done/` subdirectories exist. Scan all task directories — for each `run-state.json`, verify the task's physical location matches its status (e.g., status "complete" should be in 10-complete, status "running" should be in a stage's pending/). Location/status mismatch = ERROR.

**I8 — EBUSY / File Lock Errors:**
Read `{runtimeDir}/logs/heimdall.log` and all task log files. Search for lines containing "EBUSY" or "EPERM". Classify each: if the log shows retry succeeded = INFO. If the log shows fallback to copy+delete = WARNING. If the log shows an unresolved error = ERROR. Report count and worst-case.
