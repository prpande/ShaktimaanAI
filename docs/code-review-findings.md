# Code Review Findings — ShaktimaanAI Repository Audit

**Date:** 2026-04-08  
**Reviewer:** Copilot  
**Scope:** Full repository — all TypeScript source modules, tests, config, and dependency chain  
**Test status at time of review:** ✅ 628/628 tests passing

---

## Summary

The codebase is well-structured with clean separation of concerns, strict TypeScript configuration, Zod-validated configuration boundaries, and thorough test coverage. The directory-based state machine approach is sound and all 628 tests pass.

The following issues were identified across four categories: **bugs**, **security**, **dead code / type gaps**, and **code quality**.

---

## 1. Bugs

### 1.1 Wrong `repoPath` in `recordCompletionIfWorktree` — breaks worktree cleanup

**File:** `src/core/pipeline.ts`, line ~318  
**Severity:** High

`recordCompletionIfWorktree` records `state.worktreePath` in both the `repoPath` and `worktreePath` fields of the manifest entry:

```typescript
recordWorktreeCompletion(manifestPath, {
  slug: state.slug,
  repoPath: state.worktreePath,    // ← BUG: should be the original repo path
  worktreePath: state.worktreePath,
  completedAt: new Date().toISOString(),
});
```

`cleanupExpired` (in `src/core/worktree.ts`) later calls `removeWorktree(entry.repoPath, entry.worktreePath, slug)`, which runs `git worktree remove` and `git branch -D` with `cwd: repoPath`. Because `repoPath` is the worktree path (not the original repo), all git operations run from the wrong working directory and silently fail. Expired worktrees are never actually removed.

**Fix:** Capture the original repo path from `taskMeta.repo` (or the resolved alias path) and store it separately from `worktreePath`.

---

### 1.2 CLAUDE.md spec diagram shows wrong stage order

**File:** `CLAUDE.md`  
**Severity:** Low (documentation only)

The spec states:

> **Execution (TDD)** — impl has write access:  
> `impl ↔ validate → review → pr`

However, the code implements: `impl → review → validate → pr`. This is confirmed by:

- `STAGE_CONTEXT_RULES.validate.previousOutputLabel = "Review Output"` — validate reads review's output
- `STAGE_CONTEXT_RULES.review.previousOutputLabel = "Implementation Output"` — review reads impl's output
- The `defaultStages` array order: `[..., "impl", "review", "validate", "pr"]`

The code is internally consistent. The spec diagram needs correcting.

---

## 2. Security

### 2.1 Known CVE in `@anthropic-ai/sdk` (transitive dependency)

**Package:** `@anthropic-ai/sdk 0.79.0–0.80.0` via `@anthropic-ai/claude-agent-sdk >=0.2.91`  
**Advisory:** [GHSA-5474-4w2j-mq4c](https://github.com/advisories/GHSA-5474-4w2j-mq4c)  
**Severity:** Moderate  

> "Claude SDK for TypeScript: Memory Tool Path Validation Allows Sandbox Escape to Sibling Directories"

`npm audit` reports this vulnerability. The fix (`npm audit fix --force`) would downgrade to `@anthropic-ai/claude-agent-sdk@0.2.90`, which is flagged as a breaking change. Evaluate whether the fix is safe to apply before doing so.

---

### 2.2 Shell injection surface in `worktree.ts`

**File:** `src/core/worktree.ts`  
**Severity:** Moderate

Slug-derived strings are interpolated directly into `execSync` shell command strings:

```typescript
execSync(
  `git worktree add -b "${branchName}" "${worktreePath}" ${baseRef}`,
  { cwd: repoPath, stdio: "pipe" },
);

execSync(`git worktree remove --force "${worktreePath}"`, ...);
execSync(`git branch -D "${branchName}"`, ...);
```

Slugs are currently sanitized to kebab-case (only `[a-z0-9-]`), so exploitation via slugs is unlikely in practice. However, `baseBranch` (passed in from external sources in some call paths) is not sanitized before interpolation into the command string. A value containing `"` or a backtick would allow command injection.

**Fix:** Replace template-literal `execSync` calls with `spawnSync` and pass arguments as an array, which avoids shell interpretation entirely.

---

### 2.3 Vulnerable dev dependencies (Vite, Hono)

**Severity:** High (Vite) / Moderate (Hono) — dev dependencies only

`npm audit` reports:

| Package | Advisory | Severity |
|---|---|---|
| `vite 8.0.0–8.0.4` | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) — Path traversal in optimized deps | High |
| `vite 8.0.0–8.0.4` | [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583) — Arbitrary file read via dev server WebSocket | High |
| `@hono/node-server <1.19.13` | [GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m) — Middleware bypass | Moderate |
| `hono <=4.12.11` | Multiple advisories | Moderate |

These affect dev dependencies only (Vite is the test runner; Hono is pulled in transitively). `npm audit fix` can resolve the non-breaking ones without affecting production code.

---

## 3. Dead Code / Type Gaps

### 3.1 `heartbeatTimeoutMinutes` is configured but never implemented

**Files:** `src/config/defaults.ts`, `src/config/schema.ts`, `src/config/loader.ts`  
**Severity:** Medium

`heartbeatTimeoutMinutes: 10` is defined in `DEFAULT_CONFIG`, validated in `configSchema`, and merged in `resolveConfig`. However, it is not referenced anywhere in `src/core/pipeline.ts`, `src/core/agent-runner.ts`, or `src/core/watcher.ts`. No heartbeat monitoring exists in the codebase.

This is a configuration promise that is not delivered — users setting this value will have no effect.

---

### 3.2 `PipelineStage` union type is incomplete

**File:** `src/core/types.ts`  
**Severity:** Medium

```typescript
export type PipelineStage =
  | "questions" | "research" | "design" | "structure" | "plan"
  | "impl" | "review" | "validate" | "pr";
```

The system also supports `"quick"`, `"quick-triage"`, `"quick-execute"`, and `"slack-io"` stages, which are present in `DEFAULT_STAGE_TOOLS`, `STAGE_CONTEXT_RULES`, and `DEFAULT_CONFIG.agents.maxTurns`. These are not included in the `PipelineStage` union, creating a type safety gap where these stage names are typed as plain `string` rather than being validated by the type system.

---

### 3.3 `DIR_STAGE_MAP` imported but unused inside `pipeline.ts`

**File:** `src/core/pipeline.ts`, line 9  
**Severity:** Low

```typescript
import { STAGE_DIR_MAP, DIR_STAGE_MAP, STAGES_WITH_PENDING_DONE } from "./stage-map.js";
export { STAGE_DIR_MAP, DIR_STAGE_MAP }; // re-exported for backwards compat
```

`DIR_STAGE_MAP` is never referenced internally — it is only imported to be re-exported. The re-export for backwards compatibility is acceptable, but should have a comment making this explicit so future maintainers do not remove it thinking it is an unused import.

---

## 4. Code Quality

### 4.1 `previousOutput` accumulates all artifacts, not just the prior stage's output

**File:** `src/core/pipeline.ts`, lines 408–413  
**Severity:** Medium

```typescript
const files = readdirSync(artifactsDir).filter(f => f.endsWith(".md")).sort();
for (const file of files) {
  previousOutput += readFileSync(join(artifactsDir, file), "utf-8") + "\n";
}
```

Every stage receives **all** prior artifact `.md` files concatenated together, not just the immediately preceding stage's output. `STAGE_CONTEXT_RULES.previousOutputLabel` labels like `"Review Output"` (for the `pr` stage) suggest the design intent was to pass only the prior stage's output. In a full 9-stage run this grows unbounded, inflating token usage per stage and potentially exceeding context limits for later stages.

---

### 4.2 Inconsistent `node:` import prefix in three files

**Severity:** Low

The codebase uses the `node:` protocol prefix consistently for built-in modules (e.g., `"node:fs"`, `"node:path"`) throughout all files **except** three:

| File | Bare imports |
|---|---|
| `src/core/slug-resolver.ts` | `import * as fs from "fs"` / `import * as path from "path"` |
| `src/core/interactions.ts` | `import { ... } from "fs"` / `from "path"` |
| `src/core/logger.ts` | `import { ... } from "fs"` / `from "path"` |

All three should be updated to use `"node:fs"` and `"node:path"` for consistency.

---

### 4.3 `timeoutHandle` declared `let` but assigned only once

**File:** `src/core/agent-runner.ts`  
**Severity:** Low

```typescript
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
timeoutHandle = setTimeout(() => { ... }, timeoutMs);
```

`timeoutHandle` is set exactly once and never reassigned. It should be declared `const` to communicate immutability and let TypeScript infer that the value is always assigned.

---

### 4.4 Spin-wait busy loop in `moveTaskDir`

**File:** `src/core/pipeline.ts`, line ~131  
**Severity:** Low

```typescript
const start = Date.now();
while (Date.now() - start < delayMs) { /* spin wait — sync context */ }
```

This is commented as intentional (Windows EBUSY/EPERM retry in a synchronous context), but burns CPU for up to 1600ms between retries. If the pipeline can be refactored to make `moveTaskDir` async, `await new Promise(r => setTimeout(r, delayMs))` would be far more efficient.

---

### 4.5 No linter or formatter configured

**Severity:** Medium

There is no ESLint, Prettier, or equivalent tooling configured or run as part of the build or test pipeline. Style and quality are enforced only by convention. The inconsistent import prefixes (§4.2) and similar minor issues would be caught automatically with a linter in CI.

Recommended: add `eslint` with `@typescript-eslint/eslint-plugin` and configure it in `package.json` scripts alongside `npm test`.

---

### 4.6 `createPipeline` is ~700 lines with deeply nested closures

**File:** `src/core/pipeline.ts`  
**Severity:** Medium

The `createPipeline` factory function is approximately 700 lines long and contains all of: state transitions, worktree management, budget enforcement, retry decision-making, deferred task queuing, and all 9 control operations (`cancel`, `skip`, `pause`, etc.).

The `processStage` inner function is itself ~300 lines with deeply nested branches. Extracting at minimum `processStage` into a separate `stage-runner.ts` module would improve readability, testability, and maintainability without changing any observable behaviour.

---

### 4.7 Deprecated `STAGE_DIRS` export not removed

**File:** `src/runtime/dirs.ts`  
**Severity:** Low

```typescript
/** @deprecated Use ALL_STAGE_DIRS from stage-map.ts instead */
export const STAGE_DIRS = ALL_STAGE_DIRS;
```

The deprecated alias is still exported. If no external consumers depend on it, it should be removed. If removal is not yet possible, a tracking issue or TODO comment with a target version would help ensure it does not persist indefinitely.

---

## Issue Index

| # | File | Category | Severity | Title |
|---|---|---|---|---|
| 1.1 | `src/core/pipeline.ts` | Bug | **High** | Wrong `repoPath` in `recordCompletionIfWorktree` breaks worktree cleanup |
| 1.2 | `CLAUDE.md` | Bug | Low | Spec diagram shows wrong stage order |
| 2.1 | `package.json` (transitive) | Security | Moderate | CVE GHSA-5474-4w2j-mq4c in `@anthropic-ai/sdk` |
| 2.2 | `src/core/worktree.ts` | Security | Moderate | Shell injection surface via `execSync` template literals |
| 2.3 | `package.json` (dev) | Security | High/Moderate | Vite and Hono vulnerable versions |
| 3.1 | `src/config/defaults.ts` et al. | Dead code | Medium | `heartbeatTimeoutMinutes` configured but never implemented |
| 3.2 | `src/core/types.ts` | Type gap | Medium | `PipelineStage` union missing `quick*`/`slack-io` variants |
| 3.3 | `src/core/pipeline.ts` | Dead code | Low | `DIR_STAGE_MAP` imported but unused internally |
| 4.1 | `src/core/pipeline.ts` | Quality | Medium | `previousOutput` accumulates all artifacts, not only the prior stage's |
| 4.2 | Multiple | Quality | Low | Inconsistent `node:` import prefix in 3 files |
| 4.3 | `src/core/agent-runner.ts` | Quality | Low | `timeoutHandle` should be `const` |
| 4.4 | `src/core/pipeline.ts` | Quality | Low | Spin-wait busy loop in `moveTaskDir` |
| 4.5 | — | Quality | Medium | No linter or formatter configured |
| 4.6 | `src/core/pipeline.ts` | Quality | Medium | `createPipeline` is ~700 lines, `processStage` deeply nested |
| 4.7 | `src/runtime/dirs.ts` | Quality | Low | Deprecated `STAGE_DIRS` export not removed |

---

# Round 2 Findings

**Date:** 2026-04-08  
**Reviewer:** Copilot (extended pass)  
**Scope:** Full re-read of every source file; cross-reference with test suite; runtime behaviour analysis  
**Test status at time of review:** ✅ 656/656 tests passing

---

## 5. Bugs (Round 2)

### 5.1 `approveAndResume` doesn't emit `task_completed` when last-stage task is approved

**File:** `src/core/pipeline.ts`, lines 864–869  
**Severity:** High

When a task's `currentStage` is the last stage in its pipeline (i.e. `getNextStage` returns `null`), `approveAndResume` marks it complete and moves it to `10-complete` but returns immediately without emitting a notification:

```typescript
if (nextStage === null) {
  state.status = "complete";
  writeRunState(holdDir, state);
  moveTaskDir(runtimeDir, slug, "12-hold", "10-complete");
  activeRuns.set(slug, readRunState(join(runtimeDir, "10-complete", slug)));
  return; // ← BUG: no emitNotify({ type: "task_completed", ... })
}
```

The equivalent path inside `processStage` (line 778) correctly emits `task_completed`. The missing notification means Slack and console notifiers are never told the task is done, leaving the team with no signal that work finished.

**Fix:** Add `emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() })` before the `return`.

---

### 5.2 `cancel` doesn't record worktree completion — cancelled-task worktrees are never cleaned up

**File:** `src/core/pipeline.ts`, lines 906–926  
**Severity:** High

`cancel` aborts the agent, moves the task to `11-failed`, and deletes it from `activeRuns`, but it never calls `recordCompletionIfWorktree`. This means the worktree manifest entry is never written. `cleanupExpired` in `worktree.ts` only cleans up entries that exist in the manifest; a cancelled task's git worktree and branch (`shkmn/<slug>`) are orphaned permanently.

Over time this silently accumulates stale `shkmn/*` branches and worktree directories in every target repository.

**Fix:** Call `recordCompletionIfWorktree(state)` inside `cancel` after reading the run state, mirroring the pattern used in `failTask` and the completion paths in `processStage`.

---

### 5.3 `runRecovery` processes tasks sequentially — recovery blocks for up to 2 hours per task

**File:** `src/core/recovery.ts`, lines 149–205  
**Severity:** High

The recovery loop iterates tasks one at a time with `await` and a 2-hour timeout per task:

```typescript
for (const item of items) {
  try {
    await Promise.race([
      pipeline.resumeRun(item.slug, stageSubdir),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(...), RECOVERY_TIMEOUT_MS), // 2 hours
      ),
    ]);
```

If the system crashes with 5 tasks in `pending/`, recovery can take up to 10 hours to complete. Each task should be recovered concurrently (fire-and-forget with independent timeouts), matching how `processStage` normally operates.

Additionally, the `setTimeout` handles inside each `Promise.race` are never cleared with `clearTimeout` when the pipeline resolves first. This leaves N hanging timer handles that fire 2 hours later and call `reject` on an already-settled promise — a harmless no-op but a resource leak.

**Fix:** Fan out all recovery items with `Promise.allSettled` and clear each timeout handle when its corresponding pipeline promise settles.

---

### 5.4 `stop.ts` deletes the PID file even when the process is still running

**File:** `src/commands/stop.ts`, lines 49–53  
**Severity:** Medium

After sending SIGTERM and waiting up to 3 seconds, `stop.ts` unconditionally calls `unlinkSync(pidFile)` regardless of the `alive` flag:

```typescript
unlinkSync(pidFile);       // ← always deletes

if (alive) {
  console.warn(`Warning: ShaktimaanAI (PID ${pid}) may still be running after SIGTERM.`);
```

If the process is still alive, the PID file is gone. Any subsequent `shkmn stop` or `shkmn status` command will report "not running" while the process continues to run. The workaround (`SIGKILL` escalation or manual cleanup) cannot use the normal PID path.

**Fix:** Move `unlinkSync(pidFile)` inside the `if (!alive)` branch so the PID file is only deleted on confirmed termination.

---

### 5.5 Slack `route_pipeline` always sets `repo` to `process.cwd()`

**File:** `src/core/watcher.ts`, line 290  
**Severity:** Medium

When Astra classifies a Slack message as `route_pipeline`, the task is created with:

```typescript
createTask(
  {
    source: "slack",
    content: text,
    repo: process.cwd(),  // ← hardcoded CWD
    ...
  },
```

`process.cwd()` at runtime is the directory where the `shkmn start` daemon was invoked — which is the pipeline runtime directory, not the target repository. Any task created via Slack will have the wrong repo path, so agents will attempt to run in the wrong directory and fail to find the target codebase.

Astra's triage result carries `enrichedContext` and the original Slack message may reference a specific repo, but this information is not forwarded to `createTask`.

**Fix:** Either parse the repo path from `triageResult.enrichedContext`, or leave `repo` undefined when Astra doesn't provide an explicit repo reference, so the pipeline falls back to the `repos.root` or `invocationCwd` chain.

---

### 5.6 `modifyStages` doesn't validate that `currentStage` remains in the new stage list

**File:** `src/core/pipeline.ts`, lines 1025–1048  
**Severity:** Medium

`modifyStages` accepts an arbitrary list of valid stage names and replaces `state.stages` with them. It does not check whether `state.currentStage` is present in the new list:

```typescript
state.stages = newStages;
writeRunState(found.dir, state);
```

If the user removes the stage the task is currently executing, `getNextStage` will return `null` (current stage not found), effectively stalling the task — it can never advance because there is no "next" stage from an unknown current position. The pipeline will silently stop progressing.

**Fix:** Validate that `newStages` contains `state.currentStage`, or document and enforce that the current stage must be retained.

---

### 5.7 `retryFeedbackFiles` are sorted lexicographically — ordering breaks at 10+ retries

**File:** `src/core/pipeline.ts`, lines 94–101  
**Severity:** Low

In `collectArtifacts`, retry feedback files are collected and then sorted alongside output files:

```typescript
const outputFiles = [
  ...Array.from(latestPerStage.values()).map(({ file }) => file),
  ...retryFeedbackFiles,  // e.g., ["retry-feedback-review-1.md", "retry-feedback-review-2.md", ...]
].sort();
```

Lexicographic sort works correctly for single-digit retry counts (1–9). At retry 10 the sort order becomes `...-10.md < ...-2.md < ...-3.md` (string comparison). The `impl` agent receives stale feedback before newer feedback, which could cause it to regress to an already-fixed state.

**Fix:** Sort `retryFeedbackFiles` by extracting the numeric suffix before merging, similar to how `latestByPrefix` already uses `parseRetryNum`.

---

## 6. Security (Round 2)

### 6.1 `loadAgentPrompt` is vulnerable to path traversal via stage name

**File:** `src/core/agent-config.ts`, lines 9–20  
**Severity:** Moderate

The agent prompt is loaded by directly embedding the stage name in a file path:

```typescript
const filePath = join(agentDir, `${stage}.md`);
return readFileSync(filePath, "utf-8");
```

Stage names originate from task files (the `## Pipeline Config → stages:` section), which are written by Slack users via `createTask`. If a user submits `stages: ../../etc/passwd` (or any path traversal sequence), `join` will not block it — `join("/agents", "../../etc/passwd.md")` resolves to `/etc/passwd.md` on POSIX systems.

While the `.md` suffix makes reading system files with no extension ineffective, a crafted stage name could read other `.md` files outside the agents directory (e.g., task files, log files, documentation).

`normalizeStages` filters stages against `CANONICAL_ORDER`, which does provide protection for the standard pipeline path. However, the `quick`, `quick-triage`, `quick-execute`, and `slack-io` stages are not in `CANONICAL_ORDER` and are passed through without sanitization, and `modifyStages` accepts any name from `STAGE_DIR_MAP` keys plus `"quick"`. `loadAgentPrompt` is called for all of these.

**Fix:** Validate the stage name against an allowlist (all keys of `DEFAULT_STAGE_TOOLS`) before constructing the file path. Alternatively, use `basename(stage)` to strip any directory component.

---

## 7. Dead Code / Type Gaps (Round 2)

### 7.1 `holdReason` type contains two values that are never assigned

**File:** `src/core/types.ts`, line 56  
**Severity:** Low

```typescript
holdReason?: "budget_exhausted" | "approval_required" | "user_paused";
```

Searching the entire codebase, `holdReason` is only ever assigned `"budget_exhausted"` (in `processStage`, line 537). The values `"approval_required"` and `"user_paused"` are never set anywhere.

`status.ts` displays `[paused]` when `holdReason === "user_paused"` (line 67), but user-paused tasks never have this value set — the `pause` function sets `pausedAtStage` but not `holdReason`. The `[paused]` tag will therefore never appear in the status output.

**Fix:** Either remove the two unused union members and update `status.ts` to derive "paused" from `pausedAtStage !== undefined`, or actually assign these values in the `pause` and review-gate code paths.

---

### 7.2 `history` command is permanently stubbed and exits with code 1

**File:** `src/commands/history.ts`  
**Severity:** Low

```typescript
.action(() => {
  console.log("shkmn history — not yet implemented (Spec 5: History & Reporting)");
  process.exit(1);  // ← always failure
});
```

The command is registered in the CLI and `EXPECTED_AGENT_FILES` includes no history prompt (unrelated), but every invocation of `shkmn history` exits with code `1`. Tools and CI scripts that call this command will treat it as a failure even though the intent is "not yet implemented". A non-zero exit code for a missing feature is misleading; the stub should use `process.exit(0)` or the command should simply not be registered until it is implemented.

---

### 7.3 `06-impl/active` directory is created by `dirs.ts` but never used

**File:** `src/runtime/dirs.ts`, line 21  
**Severity:** Low

```typescript
if (stage === "06-impl") {
  dirs.push(join(runtimeDir, stage, "active"));
}
```

The `06-impl/active` directory is created on `shkmn init` and verified by `shkmn doctor`, but no code in the pipeline moves tasks into or reads from `06-impl/active`. The only impl subdirectories used at runtime are `06-impl/pending` and `06-impl/done`. This directory appears to be a leftover from a previous design.

---

## 8. Code Quality (Round 2)

### 8.1 `loadConfig` and `loadBudgetConfig` — `readFileSync` not inside `try/catch`

**File:** `src/config/loader.ts`, lines 18–19 and 125–126  
**Severity:** Medium

Both functions use a two-step pattern where `raw` is declared, then assigned via `readFileSync` *outside* any try/catch:

```typescript
let raw: string;
raw = readFileSync(configPath, "utf-8");  // ← not wrapped
```

If the file becomes unreadable after the call-site existence check (e.g., a race with file deletion, or a permissions error), Node will throw an `EACCES`/`ENOENT` error with a raw stack trace instead of a user-friendly message. Every other file read in the codebase either wraps the call in try/catch or accepts that the error will propagate. The inconsistency is confusing and the user experience on a permissions error is poor.

**Fix:** Wrap the `readFileSync` in a try/catch and re-throw as a descriptive `Error` with the file path, matching the pattern used in the error branch below.

---

### 8.2 `loadThreadMap` is duplicated in `slack-notifier.ts` and `slack-queue.ts`

**Files:** `src/surfaces/slack-notifier.ts` line 58; `src/core/slack-queue.ts` line 82  
**Severity:** Low

`slack-notifier.ts` defines a private `loadThreadMap` function that is byte-for-byte identical to the exported `loadThreadMap` in `slack-queue.ts`. The notifier imports from `slack-queue.ts` for other operations but doesn't use the exported `loadThreadMap`. If the thread-map format ever changes, both copies need to be updated.

**Fix:** Remove the private copy in `slack-notifier.ts` and import `loadThreadMap` from `../core/slack-queue.js`.

---

### 8.3 `processedTs` pruning does not preserve chronological order

**File:** `src/core/watcher.ts`, lines 68–73  
**Severity:** Low

When the processed-timestamp set exceeds 500 entries, the oldest entries are pruned:

```typescript
if (processedTs.size > 500) {
  const arr = Array.from(processedTs);
  processedTs = new Set(arr.slice(arr.length - 500));  // keep last 500 inserted
}
```

Because Slack timestamps are floating-point epoch strings, not insertion-order timestamps, the "last 500 inserted" are the 500 most recently received messages — which is the correct intent. However, after a process restart, `processedTs` is reloaded from disk and re-inserted in file-write order, not reception order. A message that was received long ago but written near the end of the JSON array could re-survive a prune cycle when it should have been evicted.

A more robust approach would be to key the set on the Slack `ts` value and prune the 500 with the largest (most recent) numeric values.

---

### 8.4 `activeRuns` not updated when deferred tasks are retried

**File:** `src/core/pipeline.ts`, lines 336–359  
**Severity:** Low

`retryDeferredTasks` restarts tasks by calling `processStage(slug, taskDir)` directly. Neither `retryDeferredTasks` nor `processStage` adds the slug to `activeRuns` on entry. The callers `startRun` and `resumeRun` each call `activeRuns.set(slug, state)` before calling `processStage`, but deferred-task retries bypass this path.

As a result, tasks that were deferred due to concurrency limits and are now re-scheduled are invisible to `getActiveRuns()` until they complete or fail (when the relevant `activeRuns.set` or `activeRuns.delete` calls are made inside `processStage`). `shkmn status` will not show them while they run through the capacity-check path.

---

### 8.5 `doctor.ts` — `checkConfig` and `checkRuntimeDirs` return `fixable: true` on passing checks

**File:** `src/commands/doctor.ts`, lines 113 and 165  
**Severity:** Low

```typescript
// checkConfig, passing case:
return { name, passed: true, message: "Valid", fixable: true };

// checkRuntimeDirs, passing case:
return { name, passed: true, message: "All directories present", fixable: true };
```

The `fixable` flag is only meaningful when `passed === false` (the fix phase filters `!c.passed && c.fixable`). Setting `fixable: true` on a passing check is semantically incorrect and misleading for any caller that inspects the result object directly (e.g., in tests or future tooling). These should be `fixable: false` when the check passes.

---

### 8.6 `build` script is an opaque inline Node.js one-liner

**File:** `package.json`, `scripts.build`  
**Severity:** Low

The build script calls `tsup` and then runs a long inline `node -e "..."` one-liner that copies `agents/*.md` files to `dist/agents/`. The inline script:

- Is not syntax-highlighted or linted
- Is difficult to read in diffs
- Will fail silently if `agents/` is empty (no `.md` files) because `fs.readdirSync` returns an empty array with no error
- Uses CommonJS `require('fs')` / `require('path')` inside an ESM-typed package (works at runtime via `node -e` but is inconsistent)

**Fix:** Move the post-build copy step into a small dedicated script file (e.g., `scripts/copy-agents.js`) and reference it from `package.json` as `"build": "tsup && node scripts/copy-agents.js"`.

---

### 8.7 `recover.ts` — sequential recovery blocks startup for potentially hours

**File:** `src/core/recovery.ts` (see §5.3)  
**Additional quality note:** Beyond the correctness concern, running recovery sequentially means the `shkmn start` command does not return control to the shell and does not start the file watcher until all recovery is complete. If a task is in a bad state and always times out, every subsequent startup will be blocked for 2 hours before the daemon becomes operational. Recovery should be non-blocking: fire and forget each item, let the pipeline's own retry/deference mechanisms handle capacity.

---

### 8.8 `checkAuthCommand` in `doctor.ts` interprets any non-zero exit as a credentials failure

**File:** `src/commands/doctor.ts`, lines 76–93  
**Severity:** Low

```typescript
function checkAuthCommand(name: string, command: string, toolLabel: string): CheckResult {
  try {
    execSync(command, { ... });
    return { ..., passed: true, message: "Authenticated" };
  } catch (err) {
    if (isTimeoutError(err)) { ... }
    if (isNotInstalledError(err)) { ... }
    return { ..., passed: false, message: (err as Error).message };  // anything else → auth fail
  }
}
```

Commands like `gh auth status` and `az account show` can fail for reasons other than auth failure — network timeouts that don't set `killed: true`, temporary API errors, or rate-limits. All of these are reported as "authentication failure" without distinguishing the root cause, leading developers to incorrectly assume they need to re-authenticate.

**Fix:** Parse the exit code and stderr to distinguish "not authenticated" from "network error" or "rate limited", or add a catch-all message that distinguishes "auth check failed" from "not authenticated".

---

### 8.9 `djb2` hash in `issueHash` — collision risk for similar findings

**File:** `src/core/retry.ts`, lines 26–40  
**Severity:** Low

`issueHash` derives a stable 32-bit hash from a review finding to track the "same" issue across review iterations. With a 32-bit djb2 hash and a large number of unique findings (hundreds per review cycle across many tasks), the birthday probability of a collision is non-trivial (~1% at ~10,000 unique descriptions). A hash collision would merge two distinct findings into one, causing:

- One finding to be considered "recurring" when it actually first appeared
- The other finding's description to be silently lost in `reviewIssues`

**Fix:** Use a 64-bit or higher hash, or use a cryptographic digest (e.g., `crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)`) for a much lower collision probability.

---

### 8.10 `gatherRecentCommits` in `repo-context.ts` has no size cap on output

**File:** `src/core/repo-context.ts`, lines 359–372  
**Severity:** Low

```typescript
const output = execSync("git log --oneline -15", { ... }).trim();
```

`git log --oneline -15` is limited to 15 lines, but individual commit messages are not length-constrained. A repository with very long commit messages (e.g., commit messages that include full patch bodies) would include all that text verbatim in the repo context injected into every agent's prompt — potentially consuming significant context budget.

**Fix:** Truncate the git output to a reasonable maximum (e.g., 500 characters) before including it in the context.

---

### 8.11 `loadConfig` reads the entire config before checking if `runtimeDir` is set

**File:** `src/config/loader.ts` → `src/config/schema.ts`  
**Severity:** Low

The `configSchema` only requires `pipeline.runtimeDir` to be non-empty (`z.string().min(1, ...)`). However, several callers (e.g., `doctor.ts`) proceed to use `config.pipeline.runtimeDir` as a directory path without checking whether it resolves to a real, writable path. If a user sets `runtimeDir` to a value like `"/nonexistent"`, the pipeline will start, create the watcher, and only fail when the first task is processed — rather than failing fast during `shkmn start` or `shkmn doctor`.

**Fix:** Add a check in `loadConfig` or the `start` command that verifies `runtimeDir` is an absolute path and, optionally, that it already exists (since `shkmn init` creates it).

---

## Extended Issue Index

| # | File | Category | Severity | Title |
|---|---|---|---|---|
| 5.1 | `src/core/pipeline.ts` | Bug | **High** | `approveAndResume` doesn't emit `task_completed` when last-stage task is approved |
| 5.2 | `src/core/pipeline.ts` | Bug | **High** | `cancel` doesn't record worktree — cancelled-task worktrees never cleaned up |
| 5.3 | `src/core/recovery.ts` | Bug | **High** | `runRecovery` processes tasks sequentially — blocks startup for up to 2h per task |
| 5.4 | `src/commands/stop.ts` | Bug | Medium | PID file deleted even when process is still running |
| 5.5 | `src/core/watcher.ts` | Bug | Medium | Slack `route_pipeline` always sets `repo` to `process.cwd()` |
| 5.6 | `src/core/pipeline.ts` | Bug | Medium | `modifyStages` doesn't check that `currentStage` remains in new stage list |
| 5.7 | `src/core/pipeline.ts` | Bug | Low | `retryFeedbackFiles` lexicographic sort breaks at 10+ retries |
| 6.1 | `src/core/agent-config.ts` | Security | Moderate | `loadAgentPrompt` path traversal via crafted stage name |
| 7.1 | `src/core/types.ts` | Dead code | Low | `holdReason` type has two values (`approval_required`, `user_paused`) never assigned |
| 7.2 | `src/commands/history.ts` | Dead code | Low | `history` command is permanently stubbed and always exits code 1 |
| 7.3 | `src/runtime/dirs.ts` | Dead code | Low | `06-impl/active` directory created but never used by pipeline |
| 8.1 | `src/config/loader.ts` | Quality | Medium | `readFileSync` not inside try/catch in `loadConfig` and `loadBudgetConfig` |
| 8.2 | `src/surfaces/slack-notifier.ts` | Quality | Low | `loadThreadMap` duplicated from `slack-queue.ts` |
| 8.3 | `src/core/watcher.ts` | Quality | Low | `processedTs` pruning does not preserve chronological order |
| 8.4 | `src/core/pipeline.ts` | Quality | Low | `activeRuns` not updated when deferred tasks are retried |
| 8.5 | `src/commands/doctor.ts` | Quality | Low | Passing checks incorrectly return `fixable: true` |
| 8.6 | `package.json` | Quality | Low | Build script is an opaque inline one-liner |
| 8.7 | `src/core/recovery.ts` | Quality | Medium | Sequential recovery blocks watcher startup |
| 8.8 | `src/commands/doctor.ts` | Quality | Low | Non-auth failures reported as authentication failures |
| 8.9 | `src/core/retry.ts` | Quality | Low | 32-bit djb2 hash in `issueHash` has non-trivial collision risk |
| 8.10 | `src/core/repo-context.ts` | Quality | Low | `gatherRecentCommits` has no output size cap |
| 8.11 | `src/config/loader.ts` | Quality | Low | `runtimeDir` not validated as a real absolute path on load |
