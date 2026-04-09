# Audit Phase 4: Polish

**Date:** 2026-04-09
**Source:** [Production-Readiness Audit](../../production-readiness-audit.md) — Phase 4 (P3)
**Scope:** 10 confirmed polish items for production hardening
**Prerequisite:** Phases 1-3 complete

---

## Audit Reconciliation

After code verification (2026-04-09), several Phase 4 items were already fixed or not issues:

| Audit # | Finding | Status | Evidence |
|---------|---------|--------|----------|
| 9.2 | `heartbeatTimeoutMinutes` unimplemented | **NOT AN ISSUE** | Property never existed in codebase |
| 9.3 | `history` command stubbed | **OPEN** | Prints "not yet implemented", exits 0 |
| 9.4 | `task --full` flag unused | **OPEN** | Declared at `task.ts:16`, never referenced |
| 9.5 | `06-impl/active` unused directory | **NOT AN ISSUE** | Directory never created |
| 9.6 | `DIR_STAGE_MAP` re-export only | **OPEN** | Intentional re-export for external consumers; cleanup removes it and updates any importers to use `stage-map.ts` directly |
| 9.7 | Deprecated `STAGE_DIRS` | **NOT AN ISSUE** | Never existed in codebase |
| 10.3 | Inconsistent `node:` import prefix | **OPEN** | 2 files use bare `fs`, rest use `node:fs` |
| 10.4 | Duplicated `loadThreadMap` | **FIXED** | Properly centralized in `slack-queue.ts` |
| 10.6 | `timeoutHandle` should be `const` | **FIXED** | Already `const` in current code |
| 10.7 | CLI version hardcoded | **OPEN** | `cli.ts:30` — `".version("0.1.0")"` |
| 10.9 | djb2 hash collision risk | **NOT AN ISSUE** | Uses SHA256 truncated to 16 hex chars |
| 10.10 | `gatherRecentCommits` no output cap | **NOT AN ISSUE** | Already capped: 500 chars commits, 2000 word total |
| 10.11 | Slack-notifier swallows append errors | **OPEN** | Intentional but should log warning |
| 10.12 | `loadCursor` no shape validation | **OPEN** | Falls back to defaults on parse failure |
| 10.13 | `stats` accepts invalid calendar dates | **OPEN** | Regex-only validation at `stats.ts:396` |
| 8.8 | Documentation stage-order inconsistency | **OPEN** | CLAUDE.md text vs code order mismatch |

**Remaining scope: 10 fixes across 8 modules.**

---

## Group 1: Dead Code & Stubs Cleanup

### Fix 1.1: Implement `shkmn history` (§9.3)

**File:** `src/commands/history.ts`

**Problem:** The command is registered in CLI and documented in QUICKSTART but always prints "not yet implemented".

**Required Changes:**

1. Implement `history` to read completed tasks from `10-complete/` and failed tasks from `11-failed/`.
2. For each task, display: slug, final status, started/completed timestamps, elapsed time, final stage.
3. Support `--count <n>` flag (already declared) to limit output.
4. Sort by completion time, most recent first.
5. If no completed tasks exist, print a clear message: "No completed tasks found."

**Tests:**
- Test with 0, 1, and multiple completed tasks
- Test `--count` flag limits output
- Test that failed tasks are included with their error reason

---

### Fix 1.2: Remove `task --full` Flag (§9.4)

**File:** `src/commands/task.ts`

**Problem:** Line 16: `--full` option is declared but never used in the action handler.

**Required Changes:**

1. Remove the `.option("--full", "Full task mode (all stages)")` declaration.
2. Remove `full?: boolean` from the opts destructuring.

**Tests:**
- Verify `shkmn task --help` no longer shows `--full`
- Existing task tests still pass

---

### Fix 1.3: Remove `DIR_STAGE_MAP` Re-export (§9.6)

**File:** `src/core/pipeline.ts`

**Problem:** Line 9/22: `DIR_STAGE_MAP` is imported and re-exported but never used internally. The comment on line 21 explains it's for external consumers.

**Required Changes:**

1. Check if any external consumer imports `DIR_STAGE_MAP` from `pipeline.ts` (grep across tests and src).
2. If no consumers exist, remove the import and re-export.
3. If consumers exist, update them to import directly from `stage-map.ts` instead, then remove the re-export.

**Tests:**
- `npm run build` succeeds
- All tests pass

---

## Group 2: Code Quality

### Fix 2.1: Consistent `node:` Import Prefix (§10.3)

**Files:** `src/core/interactions.ts`, `src/core/logger.ts`

**Problem:** These 2 files use bare `"fs"` and `"path"` imports while the rest of the codebase uses `"node:fs"` and `"node:path"`.

**Required Changes:**

1. In both files, replace `"fs"` with `"node:fs"` and `"path"` with `"node:path"`.
2. Add an ESLint rule to enforce the `node:` prefix for built-in modules (if available in the TypeScript ESLint plugin).

**Tests:**
- `npm run build` succeeds
- `npm run lint` passes

---

### Fix 2.2: Dynamic CLI Version from `package.json` (§10.7)

**File:** `src/cli.ts`

**Problem:** Line 30: `.version("0.1.0")` is hardcoded. Version can drift from `package.json`.

**Required Changes:**

1. Read the version from `package.json` at build time or runtime:
   - **Option A (build-time):** Use tsup's `define` to inject the version at build: `define: { __VERSION__: JSON.stringify(pkg.version) }`
   - **Option B (runtime):** Read `package.json` with `createRequire` or `fs.readFileSync` at startup
   - **Recommended:** Option A — no runtime overhead, no file I/O at startup

2. Replace `.version("0.1.0")` with `.version(__VERSION__)` (or equivalent).

**Tests:**
- Verify `shkmn --version` output matches `package.json` version
- Verify bumping `package.json` version updates CLI output after rebuild

---

### Fix 2.3: Slack-Notifier Error Logging (§10.11)

**File:** `src/surfaces/slack-notifier.ts`

**Problem:** Lines 237-243: File append errors are silently swallowed. The `catch` block is intentionally empty to prevent pipeline crashes, but lost notifications are invisible.

**Required Changes:**

1. Add a `console.warn` (or logger.warn if available) inside the catch block:
   ```typescript
   catch (err) {
     // Never crash the pipeline, but log the failure for diagnostics
     console.warn(`[slack-notifier] Failed to write outbox entry: ${(err as Error).message}`);
   }
   ```

**Tests:**
- Test that a write failure produces a warning log (not a crash)

---

### Fix 2.4: `loadCursor` Shape Validation (§10.12)

**File:** `src/surfaces/slack-surface.ts`

**Problem:** Lines 60-67: `JSON.parse(raw) as SlackCursor` uses a type assertion with no runtime validation. Corrupt cursor files produce unpredictable behavior.

**Required Changes:**

1. Define a Zod schema for `SlackCursor`:
   ```typescript
   const slackCursorSchema = z.object({
     lastTs: z.string(),
     // ... other fields
   });
   ```

2. Replace `JSON.parse(raw) as SlackCursor` with:
   ```typescript
   const parsed = slackCursorSchema.safeParse(JSON.parse(raw));
   return parsed.success ? parsed.data : { ...DEFAULT_CURSOR };
   ```

**Tests:**
- Test that a valid cursor file is loaded correctly
- Test that a corrupt cursor file (wrong shape) falls back to `DEFAULT_CURSOR`
- Test that an empty file falls back to `DEFAULT_CURSOR`

---

### Fix 2.5: `stats` Calendar Date Validation (§10.13)

**File:** `src/commands/stats.ts`

**Problem:** Lines 396-414: Regex-only validation accepts impossible dates like `2026-02-31`.

**Required Changes:**

1. After regex validation, parse the date and check validity:
   ```typescript
   const date = new Date(opts.from);
   if (isNaN(date.getTime())) {
     console.error(`Invalid date: ${opts.from}. Must be a valid calendar date (YYYY-MM-DD).`);
     process.exit(1);
   }
   ```

**Tests:**
- Test that `2026-02-31` is rejected
- Test that `2026-13-01` is rejected
- Test that `2026-04-09` is accepted
- Test that `0000-00-00` is rejected

---

## Group 3: Documentation Consistency

### Fix 3.1: CLAUDE.md Stage Order (§8.8)

**File:** `CLAUDE.md`

**Problem:** The current mismatch is in the CLAUDE.md text, not the code. CLAUDE.md lists the default stage order as `impl → review → validate → pr`, which matches `defaultStages` in `defaults.ts`, but then describes the retry loop as `impl → validate → review`, incorrectly swapping `review` and `validate`. Any accompanying diagram should also reflect the same forward order and retry behavior.

**Required Changes:**

1. Update the CLAUDE.md text so both the main stage order and the retry-loop description match the actual code order:
   ```
   impl → review → validate → pr
   ```
2. Correct the loop sentence to clarify that validate failures retry back to `impl`; the forward flow remains `impl → review → validate → pr`.
3. Update any related diagram so it is consistent with that same forward order and retry behavior.

---

## Group 4: Operational Improvements

### Fix 4.1: Structured Logging Foundation

**Current State:** All logging uses `console.log`/`console.warn`/`console.error` with no structure, levels, or external output targets.

**Required Changes:**

This is a foundational change that enables future observability:

1. Add `pino` as a dependency.
2. Replace the existing `src/core/logger.ts` (which currently uses bare `fs` imports and `console.*` wrappers) with a pino-based structured logger.
3. Replace `console.*` calls in core modules (`pipeline.ts`, `recovery.ts`, `watcher.ts`, `agent-runner.ts`) with structured logger calls.
4. Log entries should include: `timestamp`, `level`, `module`, `slug` (when available), `stage` (when available), `message`.
5. Configure output: JSON to file (for machine parsing), pretty-print to console (for human readability).

**Tests:**
- Test that log output is valid JSON when configured for file output
- Test that log entries include expected fields

---

## Verification Plan

After implementing all 11 fixes:

1. `npm run build` — compiles without errors
2. `npm test` — all existing + new tests pass
3. `npm run lint` — no errors
4. `shkmn --version` — shows correct version from package.json
5. `shkmn history` — shows completed tasks or clear empty message
6. `shkmn task --help` — no `--full` flag
7. Manual review: CLAUDE.md stage order matches `defaultStages` in code
