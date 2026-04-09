# Audit Phase 1: Critical Fixes

**Date:** 2026-04-09
**Source:** [Production-Readiness Audit](../../production-readiness-audit.md) — Phase 1 (P0)
**Scope:** 2 confirmed critical bugs that cause data leaks or security risk
**Prerequisite:** None — must ship before any production use

---

## Audit Reconciliation

The audit identified 8 items for Phase 1. After code verification (2026-04-09), 6 were already fixed or inaccurate:

| Audit # | Finding | Status | Evidence |
|---------|---------|--------|----------|
| 3.1 | Wrong `repoPath` in worktree cleanup | **OPEN** | `pipeline.ts:449` — falls back to worktree path |
| 3.2 | `cancel` leaks worktrees | **FIXED** | `pipeline.ts:1087` — `recordCompletionIfWorktree` is called |
| 3.3 | Sequential recovery blocks startup | **FIXED** | `recovery.ts:252-292` — uses `Promise.allSettled` concurrently |
| 6.3 | PR agent `git add -A` publishes secrets | **OPEN** | `agents/pr.md:13` — stages all files indiscriminately |
| 4.3 | Slack tasks target wrong repo | **MOVED TO PHASE 2** | Confirmed but P1 severity, not P0 |
| 6.6 | No secrets preamble in prompts | **MOVED TO PHASE 2** | Confirmed but P1 severity, not P0 |
| 6.1 | Shell injection in worktree.ts | **FIXED** | Uses `execFileSync` with array args |
| 6.2 | Path traversal in loadAgentPrompt | **FIXED** | `agent-config.ts:5,13` — allowlist validation in place |

**Remaining scope: 2 fixes across 2 modules.**

---

## Fix 1: Worktree Cleanup — Wrong `repoPath` Fallback

### Audit Reference

- **Audit §3.1** — "Wrong `repoPath` in `recordCompletionIfWorktree` — worktree cleanup permanently broken"
- **Severity:** P0 — every completed task leaks a git worktree directory and `shkmn/<slug>` branch

### Current Behavior

**File:** `src/core/pipeline.ts`, line 449

```typescript
recordWorktreeCompletion(manifestPath, {
  slug: state.slug,
  repoPath: state.repoRoot ?? state.worktreePath,  // BUG
  worktreePath: state.worktreePath,
  completedAt: new Date().toISOString(),
});
```

When `state.repoRoot` is `undefined`, the fallback is `state.worktreePath` — which is the worktree itself, not the original repository. `cleanupExpired` later calls `removeWorktree(entry.repoPath, ...)` with `cwd: repoPath`. Since `repoPath` points at the worktree (not the parent repo), `git worktree remove` silently fails.

### Root Cause

`state.repoRoot` is only populated when the task metadata includes a `repo` field. Tasks created without an explicit repo (e.g., from Slack, or `shkmn task` without `--repo`) have `repoRoot === undefined`.

### Required Changes

**Module: `src/core/pipeline.ts`**

1. In `recordCompletionIfWorktree`, resolve the original repo path deterministically:
   - If `state.repoRoot` is set, use it
   - Otherwise, derive it from `state.worktreePath` by reading the git worktree metadata (`.git` file in worktree points back to the parent repo's `.git/worktrees/` directory)
   - If derivation fails, fall back to `config.repos.root`
   - If all fail, log a warning and skip manifest recording (do not silently record a broken path)

2. Add a guard: if `repoPath === state.worktreePath`, log a warning and skip — this indicates the fallback chain failed.

**Module: `src/core/worktree.ts`**

3. Add a utility function `resolveParentRepo(worktreePath: string): string | null` that reads the `.git` file in a worktree directory and resolves the parent repository path. This is a standard git operation: worktrees have a `.git` file (not directory) containing `gitdir: /path/to/parent/.git/worktrees/<name>`.

### Testing Requirements

- Test that `recordCompletionIfWorktree` records the correct `repoPath` when `state.repoRoot` is defined
- Test that `recordCompletionIfWorktree` derives the correct `repoPath` from worktree metadata when `state.repoRoot` is undefined
- Test that `recordCompletionIfWorktree` falls back to `config.repos.root` when derivation fails
- Test that a `repoPath === worktreePath` condition logs a warning and does not write to manifest
- Test that `resolveParentRepo` correctly parses a worktree `.git` file
- Test that `cleanupExpired` successfully removes worktrees when manifest has correct `repoPath`

### Success Criteria

After this fix, `cleanupExpired` should successfully remove worktrees and branches for completed/cancelled/failed tasks. No stale `shkmn/<slug>` branches should accumulate in the target repository.

---

## Fix 2: PR Agent Secret-Safe Staging

### Audit Reference

- **Audit §6.3** — "PR agent auto-commits dirty worktree — can publish secrets"
- **Severity:** P0 — highest-risk single-step hazard in the pipeline

### Current Behavior

**File:** `agents/pr.md`, line 13

```markdown
git add -A
git commit -m "chore: stage remaining changes before PR"
```

The PR agent (Garuda) runs `git add -A` which stages **all** files in the worktree indiscriminately. If `.env` files, tokens, local config, or debug artifacts exist in the worktree, they are committed and published in the PR.

### Required Changes

**Module: `agents/pr.md`**

1. Replace the `git add -A` instruction with a safe staging sequence:
   - First, run `git diff --name-only` to list changed tracked files
   - Stage only tracked files: `git add -u` (stages modifications and deletions of tracked files, ignores untracked)
   - For any new files that should be staged, use explicit `git add <file>` after verifying they are not in a sensitive-file exclusion list

2. Add an explicit exclusion list to the prompt — the agent must NEVER stage files matching these patterns:
   - `.env`, `.env.*`
   - `*.local`
   - `credentials.*`, `secrets.*`
   - `*.pem`, `*.key`, `*.p12`, `*.pfx`
   - `shkmn.config.json`
   - Any file containing patterns like `API_KEY=`, `SECRET=`, `TOKEN=`, `PASSWORD=` in its content

3. Add a pre-commit verification step: before `git commit`, run `git diff --cached --name-only` and verify no excluded patterns are staged. If any are found, unstage them with `git reset HEAD <file>` and log a warning.

**Module: `src/core/worktree.ts`**

4. In the `createWorktree` function, after creating the worktree, ensure a `.gitignore` exists in the worktree root that excludes common sensitive patterns. If the target repo already has a `.gitignore`, verify the patterns are present. If missing, append them. If no `.gitignore` exists, create one with the exclusion patterns.

### Testing Requirements

- Test that the PR agent prompt contains the exclusion list and safe staging instructions
- Test that worktree creation includes `.gitignore` enforcement
- Integration test: create a worktree with a `.env` file present, run the PR stage, verify `.env` is not in the commit

### Success Criteria

The PR agent must never stage or commit files matching sensitive patterns. A `.env` file placed in a worktree must not appear in any PR created by the pipeline.

---

## Verification Plan

After implementing both fixes:

1. Run `npm test` — all existing tests pass
2. Run new tests for `resolveParentRepo`, `recordCompletionIfWorktree`, and PR staging safety
3. Manual smoke test: run a task through the full pipeline, verify:
   - Worktree manifest records correct `repoPath` (not worktree path)
   - `cleanupExpired` successfully removes the worktree after retention period
   - PR commit does not include `.env` or other sensitive files
