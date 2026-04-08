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
