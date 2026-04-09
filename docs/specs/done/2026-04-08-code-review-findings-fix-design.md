# Code Review Findings Fix — Design Spec

**Date:** 2026-04-08
**Scope:** Address all 25 open Copilot code review findings across bugs, security, dead code, and quality
**Source:** `docs/code-review-findings.md` (Round 1 + Round 2)
**Already fixed:** 4.1 (artifact accumulation), 4.2 (partial — 2 of 3 files), 5.4 (PID file deletion)

---

## Approach

Severity-first ordering. All fixes are code changes (no dependency upgrades for CVEs — those are flagged separately). Each tier should pass `npm test` before moving to the next.

---

## Tier 1: High-Severity Bugs

### F-1.1 Wrong `repoPath` in `recordCompletionIfWorktree`

**File:** `src/core/pipeline.ts`
**Problem:** `recordCompletionIfWorktree` stores `state.worktreePath` in both `repoPath` and `worktreePath` fields. `cleanupExpired` later runs `git worktree remove` from the wrong cwd, so expired worktrees are never cleaned up.
**Fix:** Add a `repoRoot` field to `RunState` (in `types.ts`). Populate it during `startRun`/`resumeRun` from `taskMeta.repo` (the resolved repo path). Use `state.repoRoot` as the `repoPath` argument to `recordWorktreeCompletion`. Update tests to verify the manifest entry has distinct `repoPath` and `worktreePath`.

### F-5.1 `approveAndResume` missing `task_completed` notification

**File:** `src/core/pipeline.ts`
**Problem:** When a held task at its last stage is approved, it moves to `10-complete` but never emits `task_completed`.
**Fix:** Add `emitNotify({ type: "task_completed", slug, timestamp: new Date().toISOString() })` before the `return` in the `nextStage === null` branch of `approveAndResume`. Add a test that approves a last-stage task and asserts the notification fires.

### F-5.2 `cancel` skips worktree recording

**File:** `src/core/pipeline.ts`
**Problem:** Cancelled tasks never call `recordCompletionIfWorktree`, so their git worktrees and `shkmn/*` branches are orphaned permanently.
**Fix:** Call `recordCompletionIfWorktree(state)` inside `cancel` after reading the run state, mirroring the pattern used in `failTask` and `processStage` completion paths. Add a test that cancels a worktree-backed task and asserts the manifest entry is written.

### F-5.3 Sequential recovery with leaked timers

**File:** `src/core/recovery.ts`
**Problem:** Recovery iterates tasks sequentially with `for...of` + `await`, blocking startup for up to 2h per task. `setTimeout` handles inside `Promise.race` are never cleared.
**Fix:**
1. Fan out recovery items with `Promise.allSettled` instead of sequential `for...of`.
2. Store each `setTimeout` handle and `clearTimeout` it when the pipeline promise settles.
3. Add a test verifying concurrent recovery and timer cleanup.

---

## Tier 2: Moderate Security

### F-2.2 Shell injection in `worktree.ts`

**File:** `src/core/worktree.ts`
**Problem:** `execSync` with template literals interpolates slug-derived strings and `baseBranch` directly into shell command strings. A crafted `baseBranch` with backticks or `"` allows command injection.
**Fix:** Replace all `execSync` template-literal calls with `execFileSync("git", [...args], { cwd, stdio })`. This passes arguments as an array, bypassing shell interpretation entirely. Verify all 5 call sites in the file. Add a test with a branch name containing shell metacharacters to confirm no injection.

### F-6.1 Path traversal in `loadAgentPrompt`

**File:** `src/core/agent-config.ts`
**Problem:** Stage name is interpolated directly into `join(agentDir, \`${stage}.md\`)` with no validation. A crafted stage name like `../../etc/passwd` resolves outside the agents directory.
**Fix:** Validate the stage name against an allowlist (all keys of `DEFAULT_STAGE_TOOLS`) before constructing the file path. Throw an error for any stage not in the list. Add a test confirming traversal attempts are rejected.

---

## Tier 3: Medium-Severity

### F-3.1 Remove unused `heartbeatTimeoutMinutes`

**Files:** `src/config/defaults.ts`, `src/config/schema.ts`, `src/config/loader.ts`
**Problem:** Config key is defined, validated, and merged but never consumed by any runtime code.
**Fix:** Remove `heartbeatTimeoutMinutes` from `DEFAULT_CONFIG`, `configSchema`, and the merge logic in `resolveConfig`. Update any tests that reference it.

### F-3.2 Incomplete `PipelineStage` union type

**File:** `src/core/types.ts`
**Problem:** `PipelineStage` union is missing `"quick"`, `"quick-triage"`, `"quick-execute"`, and `"slack-io"`.
**Fix:** Add the four missing stage names to the union type. Audit call sites to confirm they accept the expanded type without breakage.

### F-5.5 Slack `route_pipeline` hardcodes `repo` to `process.cwd()`

**File:** `src/core/watcher.ts`
**Problem:** Tasks created via Slack always get the daemon's cwd as `repo`, which is wrong.
**Fix:** Set `repo` to `triageResult.enrichedContext?.repo` if available, otherwise leave `repo` as `undefined` so the pipeline falls back to the `repos.root` or `invocationCwd` chain. Add a test.

### F-5.6 `modifyStages` doesn't validate `currentStage`

**File:** `src/core/pipeline.ts`
**Problem:** If `modifyStages` removes the stage a task is currently executing, the task silently stalls.
**Fix:** Check that `newStages.includes(state.currentStage)` before applying. Throw an error if the current stage would be removed. Add a test.

### F-8.1 `readFileSync` unwrapped in config loaders

**File:** `src/config/loader.ts`
**Problem:** `readFileSync` calls in `loadConfig` and `loadBudgetConfig` are not inside try/catch, producing raw stack traces on permission errors.
**Fix:** Wrap each `readFileSync` in try/catch and re-throw as a descriptive `Error` including the file path. Match the pattern used in the error branch below.

---

## Tier 4: Low-Severity

### F-1.2 CLAUDE.md stage order diagram

**File:** `CLAUDE.md`
**Fix:** Change `impl ↔ validate → review → pr` to `impl → review → validate → pr`.

### F-3.3 `DIR_STAGE_MAP` re-export comment

**File:** `src/core/pipeline.ts`
**Fix:** Add comment: `// Re-exported for external consumers; not used internally in this module.`

### F-4.2 Bare imports in `slug-resolver.ts`

**File:** `src/core/slug-resolver.ts`
**Fix:** Change `import * as fs from "fs"` → `import * as fs from "node:fs"`, same for `path`.

### F-4.3 `timeoutHandle` should be `const`

**File:** `src/core/agent-runner.ts`
**Fix:** Merge declaration and assignment into `const timeoutHandle = setTimeout(...)`.

### F-4.4 Spin-wait in `moveTaskDir`

**File:** `src/core/pipeline.ts`
**Decision:** `moveTaskDir` is called from synchronous contexts in the pipeline. Converting to async would require cascading changes through the call chain. Fix: keep synchronous but add a comment explaining why, and note it as a future refactor candidate. This is the pragmatic choice — the spin-wait runs for at most 1.6s in a rare Windows EBUSY retry path.

### F-4.5 Add ESLint

**Files:** `package.json`, new `.eslintrc.cjs` or `eslint.config.js`
**Fix:** Add `eslint` + `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`. Configure with recommended rules. Add `"lint": "eslint src/"` to `package.json` scripts. Do NOT auto-fix the entire codebase in this PR — just add the config and script so it can be run incrementally.

### F-4.6 Extract `processStage` from `createPipeline`

**File:** `src/core/pipeline.ts` → new `src/core/stage-runner.ts`
**Fix:** Extract the `processStage` inner function (~300 lines) into a separate module. It receives the dependencies it needs (config, state helpers, emitNotify, etc.) as parameters. `createPipeline` calls into it. No behavioral change. Existing tests continue to pass via the same public API.

### F-4.7 Remove deprecated `STAGE_DIRS` export

**File:** `src/runtime/dirs.ts`
**Fix:** Remove the `export const STAGE_DIRS = ALL_STAGE_DIRS` line and the `@deprecated` comment. Grep for any consumers first — if none, delete.

### F-5.7 Retry feedback sort breaks at 10+

**File:** `src/core/pipeline.ts`
**Fix:** Sort `retryFeedbackFiles` by extracting the numeric suffix (parse the trailing number before `.md`) and comparing numerically, similar to `parseRetryNum`.

### F-7.1 `holdReason` unused union members

**Files:** `src/core/types.ts`, `src/core/pipeline.ts`
**Fix:** Assign `holdReason = "user_paused"` in the `pause` function and `holdReason = "approval_required"` in the review-gate hold path. This makes `status.ts` display logic work correctly.

### F-7.2 `history` command exits code 1

**File:** `src/commands/history.ts`
**Fix:** Change `process.exit(1)` to `process.exit(0)`, or better: just log and return without exiting (let commander handle exit).

### F-7.3 `06-impl/active` directory unused

**File:** `src/runtime/dirs.ts`
**Fix:** Remove the `if (stage === "06-impl")` special-case that creates the `active` subdirectory. Update `doctor.ts` if it checks for this directory.

### F-8.2 Duplicated `loadThreadMap`

**File:** `src/surfaces/slack-notifier.ts`
**Fix:** Remove the private `loadThreadMap` function. Import `loadThreadMap` from `../core/slack-queue.js`.

### F-8.3 `processedTs` pruning not chronological

**File:** `src/core/watcher.ts`
**Fix:** Sort by Slack `ts` value (numeric epoch comparison) before pruning to the most recent 500.

### Remaining small items (from Round 2)

**F-8.4** (`pipeline.ts`): Add `activeRuns.set(slug, state)` in `retryDeferredTasks` before calling `processStage`.

**F-8.5** (`doctor.ts`): Set `fixable: false` on passing check results.

**F-8.6** (`package.json`): Move the inline `node -e` post-build copy into `scripts/copy-agents.js`.

**F-8.8** (`doctor.ts`): Distinguish "auth check failed" from "not authenticated" in error messages.

**F-8.9** (`retry.ts`): Replace djb2 with `crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)`.

**F-8.10** (`repo-context.ts`): Truncate `git log` output to 500 characters.

**F-8.11** (`loader.ts`): Add validation that `runtimeDir` is an absolute path in `loadConfig`.

---

## Out of Scope

- **2.1/2.3** (CVE in `@anthropic-ai/sdk`, Vite, Hono) — dependency upgrades need separate evaluation for breaking changes. Tracked but not code-fixed here.

## Testing Strategy

- Run `npm test` after each tier to confirm no regressions.
- New tests for: F-1.1 (manifest entries), F-5.1 (notification), F-5.2 (cancel worktree), F-5.3 (concurrent recovery), F-2.2 (shell metacharacter rejection), F-6.1 (traversal rejection), F-5.5 (repo fallback), F-5.6 (currentStage validation).
- Existing tests cover the rest — changes are behavioral fixes or cosmetic.

## Ordering

Implementation order follows severity: Tier 1 → Tier 2 → Tier 3 → Tier 4. Within each tier, order by file proximity to minimize context switching (e.g., all `pipeline.ts` fixes together).
