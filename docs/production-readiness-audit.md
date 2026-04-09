# Production-Readiness Audit — ShaktimaanAI

**Date:** 2026-04-09  
**Auditor:** Senior Architecture Review  
**Scope:** Full repository — source, tests, config, agents, docs, build, CLI, dependencies  
**Test status at time of audit:** ✅ 656/656 tests passing (46 test files)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Assessment](#2-architecture-assessment)
3. [Critical Bugs (P0)](#3-critical-bugs-p0)
4. [High-Severity Bugs (P1)](#4-high-severity-bugs-p1)
5. [Medium-Severity Bugs (P2)](#5-medium-severity-bugs-p2)
6. [Security Vulnerabilities](#6-security-vulnerabilities)
7. [Edge Cases & Runtime Failure Scenarios](#7-edge-cases--runtime-failure-scenarios)
8. [Agent Prompt Safety & Correctness](#8-agent-prompt-safety--correctness)
9. [Dead Code & Type Gaps](#9-dead-code--type-gaps)
10. [Code Quality & Maintainability](#10-code-quality--maintainability)
11. [Testing Gaps](#11-testing-gaps)
12. [Platform & OS Compatibility](#12-platform--os-compatibility)
13. [Customer Experience (Installation & CLI)](#13-customer-experience-installation--cli)
14. [Configuration & Documentation Gaps](#14-configuration--documentation-gaps)
15. [Dependency Health](#15-dependency-health)
16. [Consolidated Issue Index](#16-consolidated-issue-index)
17. [Recommended Fix Priority & Roadmap](#17-recommended-fix-priority--roadmap)

---

## 1. Executive Summary

ShaktimaanAI is a well-structured agentic development pipeline with clean separation of concerns, strict TypeScript configuration, Zod-validated boundaries, and substantial test coverage (46 test files, 656 passing tests). The directory-based state machine is sound, and the pipeline's alignment → execution → verification flow is architecturally solid.

However, the codebase has **several critical and high-severity bugs that will cause data loss, silent failures, or blocked operations in production**. The most impactful issues are:

- **Worktree cleanup is permanently broken** — cancelled/completed tasks leak git branches and worktree directories indefinitely (§3.1, §3.2)
- **Recovery blocks startup** for up to 2 hours per interrupted task, serializing sequentially (§3.3)
- **Slack-created tasks target the wrong repository** — every Slack-routed task runs agents against the daemon's CWD instead of the target repo (§4.3)
- **The PR agent can auto-commit secrets** — `git add -A && git commit` in a dirty worktree can bundle `.env` files, tokens, or local config into a public PR (§6.3)
- **No CI/CD pipeline exists** — no GitHub Actions, no Docker, no automated quality gates

The codebase is approximately **85% production-ready**. The remaining 15% consists of the bugs documented here, missing operational tooling (CI/CD, linting, monitoring), and platform-specific edge cases (particularly Windows).

---

## 2. Architecture Assessment

### 2.1 Strengths

| Area | Assessment |
|------|-----------|
| **State machine** | Directory-based task lifecycle (`00-inbox` → `10-complete`/`11-failed`/`12-hold`) is crash-recoverable and inspectable. Excellent design choice for a long-running daemon. |
| **Pipeline composition** | `createPipeline` factory pattern with dependency injection is testable and allows full mocking. |
| **Agent isolation** | Git worktrees per task prevent cross-contamination. Branch naming (`shkmn/<slug>`) is disciplined. |
| **Budget management** | Multi-tier budget tracking (daily/weekly/session/per-task) with peak-hour multipliers and model downgrading is sophisticated and well-tested. |
| **Retry/review loop** | The `impl ↔ review ↔ validate` retry loop with issue tracking (hashes, recurrence caps) prevents infinite loops while allowing genuine fixes. |
| **Configuration** | Zod schemas provide compile-time and runtime validation. Defaults are comprehensive. |
| **Test coverage** | 46 test files covering core, config, commands, surfaces, and task parsing. All 656 tests pass. |

### 2.2 Architectural Risks

| Area | Risk |
|------|------|
| **`createPipeline` complexity** | ~700 lines with deeply nested closures. `processStage` alone is ~300 lines. Refactoring into `stage-runner.ts` would improve maintainability without behavioral changes. |
| **`previousOutput` accumulation** | All prior `.md` artifacts are concatenated for every stage. In a full 9-stage run, the `pr` agent receives questions + research + design + structure + plan + impl + review + validate outputs. This grows unbounded and inflates token costs. |
| **Single-process daemon** | No clustering, no health endpoint, no watchdog. A crash requires manual `shkmn start` to recover. |
| **No idempotency guarantees** | File operations (`moveTaskDir`, `writeRunState`) are not atomic. A crash between state write and directory move can leave tasks in inconsistent states. |
| **No observability** | No metrics, no structured logging to external systems, no health checks beyond PID file. |

---

## 3. Critical Bugs (P0)

These bugs cause data loss, permanent resource leaks, or system-level failures. They must be fixed before any production deployment.

### 3.1 Wrong `repoPath` in `recordCompletionIfWorktree` — worktree cleanup permanently broken

**File:** `src/core/pipeline.ts`, line ~318  
**Impact:** Every completed task leaks a git worktree directory and a `shkmn/<slug>` branch in the target repository. Over time, repositories accumulate hundreds of stale branches and worktree directories that are never cleaned up.

```typescript
recordWorktreeCompletion(manifestPath, {
  slug: state.slug,
  repoPath: state.worktreePath,    // BUG: should be the original repo path
  worktreePath: state.worktreePath,
  completedAt: new Date().toISOString(),
});
```

`cleanupExpired` calls `removeWorktree(entry.repoPath, ...)` which runs `git worktree remove` with `cwd: repoPath`. Since `repoPath` is the worktree path (not the original repo), git operations silently fail.

**Fix:** Capture and store the original repo path from task metadata or resolved alias.

---

### 3.2 `cancel` doesn't record worktree completion — cancelled tasks leak permanently

**File:** `src/core/pipeline.ts`, lines 906–926  
**Impact:** Cancelled tasks never have their worktree manifest entry written. `cleanupExpired` cannot find them. Git worktrees and branches are orphaned permanently.

**Fix:** Call `recordCompletionIfWorktree(state)` inside `cancel` after reading run state, matching the pattern in `failTask` and `processStage` completion paths.

---

### 3.3 `runRecovery` blocks startup for up to 2 hours per interrupted task

**File:** `src/core/recovery.ts`, lines 149–205  
**Impact:** Recovery processes tasks sequentially with a 2-hour timeout each. 5 interrupted tasks = 10 hours before the daemon becomes operational. The file watcher doesn't start until recovery completes. Additionally, `setTimeout` handles are never cleared when promises settle first, keeping the event loop alive for 2 hours per task after recovery.

```typescript
for (const item of items) {
  await Promise.race([
    pipeline.resumeRun(item.slug, stageSubdir),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(...), RECOVERY_TIMEOUT_MS), // 2 hours
    ),
  ]);
}
```

**Fix:** Use `Promise.allSettled` for concurrent recovery. Clear timeout handles on settlement. Alternatively, make recovery non-blocking — fire-and-forget with the pipeline's own retry/deferral mechanisms.

---

## 4. High-Severity Bugs (P1)

These bugs cause incorrect behavior, silent data loss, or degraded functionality for specific workflows.

### 4.1 `approveAndResume` doesn't emit `task_completed` notification for last-stage approvals

**File:** `src/core/pipeline.ts`, lines 864–869  
**Impact:** When a held task's current stage is the last stage, approval completes the task but never notifies Slack or console. Teams get no signal that work finished.

```typescript
if (nextStage === null) {
  state.status = "complete";
  writeRunState(holdDir, state);
  moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
  return; // BUG: no notification emitted
}
```

**Fix:** Add `emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() })` before `return`.

---

### 4.2 `stop.ts` deletes PID file even when process is still running

**File:** `src/commands/stop.ts`, lines 49–53  
**Impact:** If SIGTERM fails to stop the process within 3 seconds, the PID file is deleted anyway. Subsequent `shkmn stop` or `shkmn status` commands report "not running" while the process continues. Manual cleanup is the only recourse.

**Fix:** Move `unlinkSync(pidFile)` inside the `if (!alive)` branch.

---

### 4.3 Slack `route_pipeline` hardcodes `repo` to `process.cwd()`

**File:** `src/core/watcher.ts`, line 290  
**Impact:** Every task created via Slack gets the daemon's runtime directory as its repo path instead of the target repository. Agents will run in the wrong directory and fail to find the codebase.

```typescript
createTask({
  source: "slack",
  content: text,
  repo: process.cwd(),  // daemon CWD, not target repo
  ...
});
```

**Fix:** Parse repo from `triageResult.enrichedContext`, or fall back to `config.repos.root`/`invocationCwd`.

---

### 4.4 `modifyStages` doesn't validate `currentStage` remains in new stage list

**File:** `src/core/pipeline.ts`, lines 1025–1048  
**Impact:** If a user removes the currently-executing stage from the stage list, `getNextStage` returns `null` (current stage not found). The task silently stalls — it can never advance.

**Fix:** Validate that `newStages` includes `state.currentStage`, or reject the modification.

---

### 4.5 `retryFeedbackFiles` lexicographic sort breaks at 10+ retries

**File:** `src/core/pipeline.ts`, lines 94–101  
**Impact:** At retry 10+, lexicographic sort orders `...-10.md < ...-2.md`. The `impl` agent receives stale feedback before newer feedback, potentially regressing to an already-fixed state.

**Fix:** Sort `retryFeedbackFiles` by numeric suffix extraction before merging.

---

## 5. Medium-Severity Bugs (P2)

### 5.1 `logs -f` follow mode doesn't handle log rotation or truncation

**File:** `src/commands/logs.ts`  
**Impact:** If a log file is rotated or truncated (common for long-running daemons), `lastSize` tracking breaks. Reads produce garbage or skip content. `parseInt(opts.lines, 10) || 50` treats `--lines 0` as 50.

**Fix:** Handle `newSize < lastSize` by resetting. Validate `--lines` as a positive integer.

---

### 5.2 `status` command shows `NaN` for invalid timestamps

**File:** `src/commands/status.ts`  
**Impact:** Invalid `startedAt` values produce `NaN` in elapsed time display.

**Fix:** Guard `formatElapsed` against non-date inputs.

---

### 5.3 `holdReason` type has values that are never assigned

**File:** `src/core/types.ts`  
**Impact:** `"approval_required"` and `"user_paused"` are in the type union but never set. `status.ts` checks for `"user_paused"` to display `[paused]`, but it's never assigned — the tag never appears.

**Fix:** Either assign these values in the appropriate code paths, or remove them and derive "paused" from `pausedAtStage !== undefined`.

---

### 5.4 `config set` bypasses Zod validation

**File:** `src/commands/config.ts`  
**Impact:** `setConfigValue` writes directly to JSON without re-validating against the Zod schema. Users can introduce invalid config that passes `set` but crashes `start`.

**Fix:** Re-validate the full config through `configSchema.parse()` after mutation, before writing.

---

### 5.5 `activeRuns` not updated when deferred tasks are retried

**File:** `src/core/pipeline.ts`, lines 336–359  
**Impact:** Tasks restarted via `retryDeferredTasks` are invisible to `getActiveRuns()` until they complete or fail. `shkmn status` won't show them.

---

### 5.6 `processedTs` pruning doesn't preserve chronological order

**File:** `src/core/watcher.ts`, lines 68–73  
**Impact:** After restart, the "last 500" entries may not be the 500 most recent Slack messages. Previously-processed messages could be re-processed.

**Fix:** Sort by Slack `ts` value (numeric epoch) before pruning.

---

### 5.7 `console-notifier` always logs all events — `shouldNotify` guard is effectively dead

**File:** `src/surfaces/console-notifier.ts`  
**Impact:** `shouldNotify("stages", event)` always returns `true` at `"stages"` level, making the notification level configuration ineffective.

---

## 6. Security Vulnerabilities

### 6.1 Shell injection via `execSync` template literals in `worktree.ts`

**File:** `src/core/worktree.ts`  
**Severity:** Moderate  
**Impact:** While slugs are sanitized to `[a-z0-9-]`, `baseBranch` (from external sources) is not sanitized. Values containing `"` or backticks enable command injection.

```typescript
execSync(`git worktree add -b "${branchName}" "${worktreePath}" ${baseRef}`, ...);
```

**Fix:** Replace `execSync` with `spawnSync` and pass arguments as an array.

---

### 6.2 `loadAgentPrompt` path traversal via stage name

**File:** `src/core/agent-config.ts`  
**Severity:** Moderate  
**Impact:** Stage names from task files are embedded directly in file paths. Crafted names containing `../` can read `.md` files outside the agents directory. The `.md` suffix limits exploitation, but task files, logs, and documentation are readable.

```typescript
const filePath = join(agentDir, `${stage}.md`);
```

**Fix:** Validate stage name against an allowlist (keys of `DEFAULT_STAGE_TOOLS`) or use `basename(stage)`.

---

### 6.3 `pr.md` agent auto-commits dirty worktree — can publish secrets

**File:** `agents/pr.md`  
**Severity:** High  
**Impact:** The PR agent runs `git add -A && git commit` on any dirty working tree. If the worktree contains `.env` files, tokens, local config, or debug artifacts, they are bundled into the commit and published in the PR. This is the **highest-risk single-step hazard** in the pipeline.

**Fix:** Add `.env`, `*.local`, and common secret patterns to the worktree's `.gitignore`. Alternatively, the PR agent prompt should explicitly exclude sensitive patterns from `git add`.

---

### 6.4 Transitive CVE in `@anthropic-ai/sdk`

**Package:** `@anthropic-ai/sdk 0.79.0–0.80.0` via `@anthropic-ai/claude-agent-sdk`  
**Advisory:** [GHSA-5474-4w2j-mq4c](https://github.com/advisories/GHSA-5474-4w2j-mq4c)  
**Impact:** Memory Tool Path Validation Allows Sandbox Escape to Sibling Directories.

---

### 6.5 Vulnerable dev dependencies (Vite, Hono)

| Package | Advisory | Severity |
|---------|----------|----------|
| `vite 8.0.0–8.0.4` | GHSA-4w7w-66w2-5vf9 — Path traversal | High |
| `vite 8.0.0–8.0.4` | GHSA-p9ff-h696-f583 — WebSocket file read | High |
| `@hono/node-server <1.19.13` | GHSA-92pp-h63x-v22m — Middleware bypass | Moderate |

**Fix:** `npm audit fix` for non-breaking; evaluate breaking changes for `claude-agent-sdk`.

---

### 6.6 No secrets/PII guardrails in agent prompts

**Impact:** No agent prompt systematically forbids putting tokens, API keys, or customer data into artifacts, PR bodies, Slack messages, or log files. The `quick-execute` agent has the broadest permissions and weakest guardrails.

**Fix:** Add a universal preamble to all agent prompts: "Never include API keys, tokens, passwords, or personally identifiable information in any output, commit, PR body, or Slack message."

---

## 7. Edge Cases & Runtime Failure Scenarios

### 7.1 Concurrent `shkmn start` race condition

Two simultaneous `start` commands can both pass the stale-PID check window and launch competing daemons. Both write PID files; one overwrites the other. The loser's process runs without a valid PID file.

**Fix:** Use advisory file locking (`flock`/`lockfile`) on the PID file.

---

### 7.2 `moveTaskDir` race with chokidar watcher

`moveTaskDir` (synchronous) can race with chokidar's inode polling on the same directory. On Windows, `EBUSY`/`EPERM` errors are retried with a **spin-wait busy loop** (up to 1600ms of CPU burn between retries). This is acknowledged in comments but burns CPU.

**Fix:** If the pipeline can tolerate async directory moves, replace with `await new Promise(r => setTimeout(r, delayMs))`.

---

### 7.3 Task file arrives during recovery

If a new `.task` file appears in `00-inbox` while `runRecovery` is still running (which can take hours per §3.3), the watcher is not yet started. The task sits unprocessed until recovery completes.

---

### 7.4 `peak_hours` budget config doesn't validate time semantics

**File:** `src/config/budget-schema.ts`  
`start` and `end` times are strings with no validation that `start < end` or handling of cross-midnight ranges (e.g., `start: "22:00"`, `end: "06:00"`).

---

### 7.5 Empty `.task` file processing

If a `.task` file is created with no content (empty file or only whitespace), `parseTask` produces a `TaskMeta` with empty sections. The pipeline will attempt to run agents with no meaningful input.

---

### 7.6 Tilde (`~`) not expanded in user-provided paths

**File:** `src/commands/init.ts`  
If a user types `~/.shkmn/runtime` during the init wizard, the literal string `~` is stored. On Linux/macOS, `createRuntimeDirs("~/.shkmn/runtime")` may create a directory literally named `~` under CWD.

---

### 7.7 Slack message deduplication is not persistent across restarts

**File:** `src/core/watcher.ts`  
`processedTs` is a `Set` in memory. If the daemon restarts, previously-processed Slack messages may be re-processed until the cursor file catches up. Combined with §5.6, pruning order is unreliable.

---

### 7.8 Dynamic Slack notifier import can reject silently

**File:** `src/commands/start.ts`  
The dynamic `import()` for the Slack notifier module is not wrapped in try/catch. If the module fails to load (missing dependency, syntax error), the unhandled rejection can crash startup.

---

## 8. Agent Prompt Safety & Correctness

### 8.1 Cross-cutting prompt issues

| Issue | Affected Prompts | Severity |
|-------|-----------------|----------|
| **No universal secrets/PII prohibition** | All 12 prompts | High |
| **Bash-flavored commands on Windows** | `impl.md`, `validate.md`, `pr.md` — `ls`, `2>/dev/null`, heredocs | Medium |
| **No output size limits** | All prompts — agents can produce unbounded output inflating token costs | Medium |
| **`previousOutput` may include all artifacts, not just prior stage** | `review.md`, `validate.md`, `pr.md` — labels like "Review Output" are misleading | Medium |

### 8.2 `pr.md` — auto-commit of dirty worktree (see §6.3)

The PR agent's `git add -A` is the most dangerous single instruction. It should be replaced with a targeted `git add` of only tracked/expected files, or preceded by a `.gitignore` check.

### 8.3 `quick-execute.md` — broadest permissions, weakest guardrails

This agent has full Read/Write/Edit/Bash/Web/Slack/Notion/ADO access with minimal constraints. It can clone repositories, send Slack messages, modify Notion pages, and write arbitrary files. No scope limits, no secret handling rules, no PR safety.

**Fix:** Add explicit guardrails: no credential access, no `git push --force`, no deletion of production resources, output size cap.

### 8.4 `research.md` — Slack/Notion search without scope limits

The research agent can search any Slack channel and Notion workspace. No channel/page restrictions. Risk of exfiltrating sensitive threads or summarizing confidential information into task artifacts.

**Fix:** Add scope constraints (specific channels, specific Notion databases) or require explicit user opt-in.

### 8.5 `slack-io.md` — keyword approval false positives

Approval keywords ("approved", "lgtm", "go ahead") in casual Slack conversation can false-positive and resume pipeline execution. No confirmation step.

### 8.6 `plan.md` — embeds full code in plan output

The plan agent is instructed to include complete code snippets. This produces extremely large plan artifacts that are then fed to the `impl` agent (which may rubber-stamp incorrect code) and accumulate in `previousOutput`.

### 8.7 `validate.md` — demands full test output

"Do NOT truncate" can produce massive artifacts for projects with large test suites, consuming significant context budget for subsequent stages.

### 8.8 Documentation order inconsistency

| Source | Stage order |
|--------|-------------|
| `CLAUDE.md` (diagram) | `impl ↔ validate → review → pr` |
| `CLAUDE.md` (text) | `impl → review → validate → pr` |
| `README.md` (diagram) | Ambiguous (validate adjacent to impl) |
| Code (`defaultStages`) | `impl → review → validate → pr` |
| `quick-triage.md` | `impl → review → validate → pr` |

The code is internally consistent. All documentation should be corrected to match.

---

## 9. Dead Code & Type Gaps

### 9.1 `PipelineStage` union type is incomplete

**File:** `src/core/types.ts`  
Missing: `"quick"`, `"quick-triage"`, `"quick-execute"`, `"slack-io"`. These are used in `DEFAULT_STAGE_TOOLS`, `STAGE_CONTEXT_RULES`, and `maxTurns` but typed as plain `string`.

### 9.2 `heartbeatTimeoutMinutes` configured but never implemented

**Files:** `src/config/defaults.ts`, `schema.ts`, `loader.ts`  
Defined, validated, merged — but never read by any runtime code. A configuration promise that isn't delivered.

### 9.3 `history` command is permanently stubbed (exits code 1)

**File:** `src/commands/history.ts`  
Registered in CLI, documented in QUICKSTART.md, but always exits with failure code. `--count` option is declared but never used.

### 9.4 `task --full` flag declared but never used

**File:** `src/commands/task.ts`  
The `--full` option is defined but has no effect on behavior.

### 9.5 `06-impl/active` directory created but never used

**File:** `src/runtime/dirs.ts`  
Created by `init` and checked by `doctor`, but no pipeline code uses it. Leftover from a previous design.

### 9.6 `DIR_STAGE_MAP` imported only for re-export

**File:** `src/core/pipeline.ts`  
Imported and re-exported for backwards compatibility but never referenced internally. Needs a comment explaining the re-export.

### 9.7 Deprecated `STAGE_DIRS` export still present

**File:** `src/runtime/dirs.ts`  
Marked `@deprecated` but not removed. No tracking issue or target version.

---

## 10. Code Quality & Maintainability

### 10.1 `createPipeline` is ~700 lines with deeply nested closures

**File:** `src/core/pipeline.ts`  
`processStage` (~300 lines) should be extracted to a separate `stage-runner.ts` module.

### 10.2 No linter or formatter configured

No ESLint, Prettier, or equivalent. Style is enforced only by convention. The inconsistent `node:` import prefixes (§10.3) would be caught automatically.

**Fix:** Add `eslint` with `@typescript-eslint/eslint-plugin`. Add to `package.json` scripts.

### 10.3 Inconsistent `node:` import prefix in 3 files

| File | Issue |
|------|-------|
| `src/core/slug-resolver.ts` | `import * as fs from "fs"` |
| `src/core/interactions.ts` | `import { ... } from "fs"` |
| `src/core/logger.ts` | `import { ... } from "fs"` |

All should use `"node:fs"` and `"node:path"`.

### 10.4 `loadThreadMap` duplicated across two files

**Files:** `src/surfaces/slack-notifier.ts` and `src/core/slack-queue.ts`  
Byte-for-byte identical. If the thread-map format changes, both must be updated.

**Fix:** Remove the private copy in `slack-notifier.ts`; import from `slack-queue.ts`.

### 10.5 `readFileSync` not wrapped in try/catch in config loaders

**File:** `src/config/loader.ts`  
Both `loadConfig` and `loadBudgetConfig` read files outside try/catch. Permission or race-condition errors produce raw stack traces instead of user-friendly messages.

### 10.6 `timeoutHandle` should be `const`

**File:** `src/core/agent-runner.ts`  
Declared `let` but assigned exactly once.

### 10.7 CLI version hardcoded

**File:** `src/cli.ts`  
Version is hardcoded `0.1.0` and can drift from `package.json`.

**Fix:** Import version from `package.json` or read it dynamically.

### 10.8 Build script is an opaque inline one-liner

**File:** `package.json`  
The copy-agents step uses a long inline `node -e "..."` one-liner with CommonJS `require` in an ESM package.

**Note:** A `scripts/copy-agents.js` file exists but is not referenced by the build script in `package.json`.

### 10.9 `djb2` hash has non-trivial collision risk

**File:** `src/core/retry.ts`  
32-bit hash for issue tracking. At ~10,000 unique findings, birthday collision probability is ~1%.

**Fix:** Use `crypto.createHash('sha256')` truncated to 16 hex characters.

### 10.10 `gatherRecentCommits` has no output size cap

**File:** `src/core/repo-context.ts`  
`git log --oneline -15` limits line count but not individual message length. Repos with verbose commit messages inflate agent context.

### 10.11 `Slack-notifier` swallows all append errors

**File:** `src/surfaces/slack-notifier.ts`  
All file append errors are silently swallowed. Notifications can be silently lost.

### 10.12 `loadCursor` does no shape validation

**File:** `src/surfaces/slack-surface.ts`  
`JSON.parse` without Zod or schema check. Corrupt cursor files cause unpredictable behavior.

### 10.13 `stats` date validation accepts invalid calendar dates

**File:** `src/commands/stats.ts`  
Date options validated with regex only — `2026-02-31` passes validation but isn't a real date.

---

## 11. Testing Gaps

### 11.1 Test coverage by module

| Module | Test file exists | Notes |
|--------|-----------------|-------|
| `core/pipeline.ts` | ✅ `pipeline.test.ts`, `pipeline-control.test.ts`, `pipeline-budget.test.ts` | Most comprehensive |
| `core/agent-runner.ts` | ✅ `agent-runner.test.ts` | |
| `core/watcher.ts` | ✅ `watcher.test.ts` | |
| `core/recovery.ts` | ✅ `recovery.test.ts` | |
| `core/worktree.ts` | ✅ `worktree.test.ts` | |
| `core/retry.ts` | ✅ `retry.test.ts` | |
| `core/registry.ts` | ✅ `registry.test.ts` | |
| `core/budget.ts` | ✅ `budget.test.ts` | |
| `core/astra-triage.ts` | ✅ `astra-triage.test.ts`, `astra-integration.test.ts` | |
| `config/*` | ✅ 6 test files | |
| `commands/*` | ✅ 7 test files | |
| `surfaces/*` | ✅ 5 test files | |
| `task/parser.ts` | ✅ `parser.test.ts` | |
| `runtime/dirs.ts` | ✅ `dirs.test.ts` | |

### 11.2 Missing test scenarios

| Area | Missing tests |
|------|---------------|
| **Worktree cleanup** | No test for `cleanupExpired` with real manifest entries; the `repoPath` bug (§3.1) was not caught |
| **Cancel worktree leak** | No test verifying `cancel` calls `recordCompletionIfWorktree` |
| **Recovery concurrency** | No test for parallel recovery behavior or timeout cleanup |
| **modifyStages validation** | No test for removing `currentStage` from the stage list |
| **Slack task repo resolution** | No test verifying `route_pipeline` uses the correct repo path |
| **Windows-specific paths** | No platform-conditional tests for path handling, `EBUSY` retries, or tilde expansion |
| **Integration/E2E tests** | No end-to-end test running a task through the full pipeline |
| **Agent prompt loading** | No test for path traversal in `loadAgentPrompt` with crafted stage names |

### 11.3 No CI/CD pipeline

No GitHub Actions, Azure Pipelines, or Dockerfile. Tests run only locally via `npm test`. No automated quality gates before merge.

**Fix:** Add a minimal CI workflow:
```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm audit --audit-level=moderate
```

### 11.4 No test coverage reporting

`vitest.config.ts` has no coverage configuration. There's no visibility into which code paths are tested.

**Fix:** Add `coverage: { provider: 'v8', reporter: ['text', 'lcov'] }` to vitest config.

---

## 12. Platform & OS Compatibility

### 12.1 Windows-specific issues

| Issue | Location | Impact |
|-------|----------|--------|
| **Bash idioms in agent prompts** | `impl.md`, `validate.md`, `pr.md` | `ls`, `2>/dev/null`, heredocs may fail on Windows |
| **`SIGTERM` behavior** | `commands/stop.ts` | Node.js on Windows doesn't handle `SIGTERM` the same way; process may not terminate |
| **Tilde expansion** | `commands/init.ts` | `~` is not expanded on Windows; literal `~` directory created |
| **File locking** | `core/pipeline.ts` | `EBUSY`/`EPERM` retries with spin-wait are Windows-specific workarounds |
| **Path separators** | Various | Most paths use `path.join` (correct), but string interpolation in some shell commands assumes `/` |

### 12.2 Node.js version requirements

`package.json` specifies `node >= 20` but doesn't use `engines` field to enforce it. Users on Node 18 will get confusing errors from ESM features.

**Fix:** Add `"engines": { "node": ">=20.0.0" }` to `package.json`.

---

## 13. Customer Experience (Installation & CLI)

### 13.1 `shkmn init` — `.env` template omits `SLACK_WEBHOOK_URL`

**Files:** `src/commands/init.ts` vs `src/commands/doctor.ts`  
`doctor` requires `SLACK_WEBHOOK_URL` in its `REQUIRED_ENV_KEYS` check, but `init` doesn't include it in the `.env` template. Users who run `init` → `doctor` immediately get a failing check.

**Fix:** Align the `.env` template with `REQUIRED_ENV_KEYS`.

---

### 13.2 `shkmn doctor --fix` has limited scope

`--fix` creates runtime directories and merges default config. It does NOT:
- Fix missing `.env` keys
- Download missing agent prompt files
- Fix path issues
- Resolve dependency vulnerabilities

Users expect `--fix` to resolve all reported issues. The gap should be documented or the scope expanded.

---

### 13.3 CLI stubs create false expectations

| Command | Issue |
|---------|-------|
| `shkmn history` | Always exits with code 1; `--count` option has no effect |
| `shkmn task --full` | Flag declared but ignored |

Users who discover these via `--help` will be confused by non-functional features.

**Fix:** Remove stubs until implemented, or change exit code to 0 with a clear "coming soon" message.

---

### 13.4 Error messages for common failures are not user-friendly

| Scenario | Current behavior | Expected |
|----------|-----------------|----------|
| Config file has invalid JSON | Raw `SyntaxError` stack trace | "Config file at X contains invalid JSON: [specific error]" |
| Config file has wrong permissions | Raw `EACCES` error | "Cannot read config file at X: permission denied" |
| `runtimeDir` doesn't exist | Fails when first task is processed | Fail fast at `shkmn start` with clear message |
| Agent prompts missing | `ENOENT` when stage runs | Fail at `shkmn start` or `shkmn doctor` |

---

### 13.5 No `--version` flag reads from `package.json`

Version is hardcoded. If the package is updated but the hardcoded string isn't, users see stale version info.

---

## 14. Configuration & Documentation Gaps

### 14.1 Documentation accuracy

| Document | Issue |
|----------|-------|
| `CLAUDE.md` diagram | Shows `impl ↔ validate → review → pr`; code implements `impl → review → validate → pr` |
| `README.md` diagram | Ambiguous — validate appears adjacent to impl |
| `QUICKSTART.md` | References `shkmn history` which is stubbed |
| `.env.example` | Missing inline comments for each key explaining purpose |

### 14.2 Missing documentation

| Topic | Status |
|-------|--------|
| **API/module documentation** | None — no JSDoc, no API reference |
| **Troubleshooting guide** | Minimal in QUICKSTART; no comprehensive guide |
| **Architecture decision records** | None |
| **Monitoring/alerting setup** | None |
| **Upgrade/migration guide** | None |
| **Security model documentation** | None — tool permissions, agent sandboxing, and secret handling are undocumented |
| **Contributing guide** | None |
| **Changelog** | None |

### 14.3 Config schema documentation

The Zod schema in `schema.ts` is the only documentation for configuration options. There's no human-readable reference for all config keys, their types, defaults, and effects.

**Fix:** Generate a configuration reference doc from the Zod schema, or maintain a manual reference in `docs/`.

---

## 15. Dependency Health

### 15.1 Direct dependencies

| Package | Version | Purpose | Health |
|---------|---------|---------|--------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.91` | Agent execution | ⚠️ Transitive CVE (§6.4) |
| `@clack/prompts` | `^0.10.1` | Interactive CLI prompts | ✅ |
| `chokidar` | `^4.0.3` | File watching | ✅ |
| `commander` | `^13.1.0` | CLI framework | ✅ |
| `dotenv` | `^16.4.7` | `.env` loading | ✅ |
| `zod` | `^4.3.6` | Schema validation | ⚠️ v4 is newer — verify API compatibility |

### 15.2 Dev dependency concerns

| Package | Issue |
|---------|-------|
| `vite` | Two High CVEs (§6.5) |
| `@hono/node-server` | Moderate CVE (§6.5) |

### 15.3 Missing recommended dependencies

| Need | Recommendation |
|------|---------------|
| Structured logging | `pino` or `winston` for JSON-structured, level-aware logging |
| Process management | `pm2` or systemd unit for daemon reliability |
| Health monitoring | HTTP health endpoint for uptime monitoring |

---

## 16. Consolidated Issue Index

### By severity

| # | File | Category | Severity | Title |
|---|------|----------|----------|-------|
| 3.1 | `pipeline.ts` | Bug | **P0** | Wrong `repoPath` — worktree cleanup permanently broken |
| 3.2 | `pipeline.ts` | Bug | **P0** | `cancel` leaks worktrees permanently |
| 3.3 | `recovery.ts` | Bug | **P0** | Sequential recovery blocks startup for hours |
| 6.3 | `agents/pr.md` | Security | **P0** | Auto-commit can publish secrets in PR |
| 4.1 | `pipeline.ts` | Bug | **P1** | Missing `task_completed` notification on approval |
| 4.2 | `stop.ts` | Bug | **P1** | PID file deleted while process still running |
| 4.3 | `watcher.ts` | Bug | **P1** | Slack tasks target wrong repository |
| 4.4 | `pipeline.ts` | Bug | **P1** | `modifyStages` doesn't validate `currentStage` |
| 4.5 | `pipeline.ts` | Bug | **P1** | Retry feedback sort breaks at 10+ retries |
| 6.1 | `worktree.ts` | Security | **P1** | Shell injection via `execSync` |
| 6.2 | `agent-config.ts` | Security | **P1** | Path traversal in `loadAgentPrompt` |
| 6.6 | Agent prompts | Security | **P1** | No secrets/PII guardrails |
| 5.1 | `logs.ts` | Bug | **P2** | Follow mode breaks on log rotation |
| 5.2 | `status.ts` | Bug | **P2** | NaN display for invalid timestamps |
| 5.3 | `types.ts` | Bug | **P2** | `holdReason` values never assigned |
| 5.4 | `config.ts` | Bug | **P2** | `config set` bypasses Zod validation |
| 5.5 | `pipeline.ts` | Bug | **P2** | Deferred tasks invisible in status |
| 5.6 | `watcher.ts` | Bug | **P2** | Pruning doesn't preserve chronological order |
| 5.7 | `console-notifier.ts` | Bug | **P2** | Notification level guard is dead code |
| 6.4 | Dependencies | Security | **P2** | Transitive CVE in SDK |
| 6.5 | Dependencies | Security | **P2** | Vite/Hono CVEs (dev only) |
| 8.3 | `quick-execute.md` | Safety | **P2** | Broadest permissions, weakest guardrails |
| 8.4 | `research.md` | Safety | **P2** | Slack/Notion search without scope |
| 9.1 | `types.ts` | Type gap | **P2** | `PipelineStage` union incomplete |
| 9.2 | `defaults.ts` | Dead code | **P3** | `heartbeatTimeoutMinutes` unimplemented |
| 9.3 | `history.ts` | Dead code | **P3** | Stubbed command exits code 1 |
| 9.4 | `task.ts` | Dead code | **P3** | `--full` flag unused |
| 9.5 | `dirs.ts` | Dead code | **P3** | `06-impl/active` unused |
| 9.6 | `pipeline.ts` | Dead code | **P3** | `DIR_STAGE_MAP` imported only for re-export |
| 9.7 | `dirs.ts` | Dead code | **P3** | Deprecated `STAGE_DIRS` not removed |
| 10.1 | `pipeline.ts` | Quality | **P2** | `createPipeline` is ~700 lines |
| 10.2 | — | Quality | **P2** | No linter or formatter |
| 10.3 | 3 files | Quality | **P3** | Inconsistent `node:` prefix |
| 10.4 | 2 files | Quality | **P3** | Duplicated `loadThreadMap` |
| 10.5 | `loader.ts` | Quality | **P2** | Unguarded `readFileSync` |
| 10.6 | `agent-runner.ts` | Quality | **P3** | `let` should be `const` |
| 10.7 | `cli.ts` | Quality | **P3** | Hardcoded version |
| 10.8 | `package.json` | Quality | **P3** | Opaque inline build script |
| 10.9 | `retry.ts` | Quality | **P3** | djb2 collision risk |
| 10.10 | `repo-context.ts` | Quality | **P3** | No git output size cap |
| 10.11 | `slack-notifier.ts` | Quality | **P3** | Silent error swallowing |
| 10.12 | `slack-surface.ts` | Quality | **P3** | No cursor shape validation |
| 10.13 | `stats.ts` | Quality | **P3** | Invalid calendar dates accepted |
| 11.3 | — | Infra | **P1** | No CI/CD pipeline |
| 11.4 | — | Infra | **P2** | No test coverage reporting |
| 12.2 | `package.json` | Compat | **P2** | No `engines` field |

---

## 17. Recommended Fix Priority & Roadmap

### Phase 1: Critical (Week 1) — Must fix before any production use

1. **Fix worktree cleanup** (§3.1) — correct `repoPath` in `recordCompletionIfWorktree`
2. **Fix cancel worktree leak** (§3.2) — call `recordCompletionIfWorktree` in `cancel`
3. **Fix sequential recovery** (§3.3) — parallelize with `Promise.allSettled`, clear timeouts
4. **Fix PR auto-commit safety** (§6.3) — add `.gitignore` enforcement or targeted `git add`
5. **Fix Slack repo targeting** (§4.3) — resolve repo from triage context or config
6. **Add secrets guardrails to agent prompts** (§6.6) — universal preamble
7. **Fix shell injection** (§6.1) — replace `execSync` with `spawnSync` arrays
8. **Fix path traversal** (§6.2) — allowlist validation for stage names

### Phase 2: High (Week 2) — Required for reliable operation

9. **Add CI/CD pipeline** (§11.3) — GitHub Actions with build, test, audit
10. **Fix `approveAndResume` notification** (§4.1)
11. **Fix `stop.ts` PID handling** (§4.2)
12. **Fix `modifyStages` validation** (§4.4)
13. **Fix retry feedback sort** (§4.5)
14. **Add ESLint** (§10.2) — catch inconsistencies automatically
15. **Add test coverage reporting** (§11.4)
16. **Fix `config set` validation** (§5.4)
17. **Complete `PipelineStage` type** (§9.1)

### Phase 3: Medium (Week 3-4) — Improved reliability and UX

18. Fix remaining P2 bugs (§5.1–5.7)
19. Add `engines` field to `package.json` (§12.2)
20. Align `.env` template with doctor checks (§13.1)
21. Fix documentation stage-order inconsistency (§8.8)
22. Refactor `createPipeline` (§10.1)
23. Add missing test scenarios (§11.2)
24. Improve error messages (§13.4)
25. Add `quick-execute` guardrails (§8.3)
26. Resolve dependency CVEs (§6.4, §6.5)

### Phase 4: Polish (Ongoing) — Production hardening

27. Remove dead code (§9.2–9.7)
28. Fix all P3 quality items (§10.3–10.13)
29. Add structured logging with `pino`
30. Add health endpoint for monitoring
31. Add process management (pm2 or systemd)
32. Write comprehensive documentation (§14.2)
33. Add E2E integration tests
34. Implement `shkmn history`
35. Add configuration reference documentation

---

*End of audit. Total findings: 50+ across bugs, security, edge cases, safety, quality, testing, platform, UX, config, and dependencies.*
