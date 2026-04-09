# Spec 2c: Execution Agents — Design Document

> **Note (Spec 2d):** References to agent MD file frontmatter and `{{VARIABLE}}` template patterns in this document have been superseded by Spec 2d (Agent Prompt Simplification). Agent MD files are now pure prompt instructions. See `docs/superpowers/specs/2026-04-04-spec2d-agent-prompt-simplification-design.md` for the current design.

**Goal:** Replace the 4 stub execution agent prompts with production-quality prompts, add git worktree management, implement validate→impl and review→impl retry loops with issue tracking, and wire everything into the pipeline engine — making the Impl → Validate → Review → PR pipeline functional for real coding tasks.

**Depends on:** Spec 2a (Pipeline Infrastructure) and Spec 2b (Alignment Agents) — both completed.

---

## Naming Rule

Same as Spec 2b: all code, filenames, agent config files, and identifiers use descriptive English names. Mythological display names exist only in `shkmn.config.json` → `agents.names`.

---

## Architecture Overview

Spec 2a built the pipeline engine and agent runner. Spec 2b added alignment agent intelligence and the agent config system. Spec 2c adds execution intelligence:

1. **Worktree manager** — Creates isolated git worktrees for implementation work. Pipeline owns the lifecycle, agents just work in the directory they're given.

2. **Retry logic** — Validate→impl feedback loop (simple counter) and review→impl feedback loop (issue-tracking — only exhausts when the same issue recurs, new issues always get fresh attempts).

3. **Production prompts** — Full behavioral instructions for impl (TDD + retry awareness + per-slice commits), validate (structured verdicts), review (numbered findings for issue tracking + holistic re-review), and PR (template discovery + ADO linking).

4. **Pipeline modifications** — Worktree setup before impl, workDir resolution for agent cwd, verdict parsing, retry integration, cleanup tracking.

---

## 1. Worktree Manager

New module: `src/core/worktree.ts`

### Functions

| Function | Signature | Purpose |
|---|---|---|
| `createWorktree` | `(repoPath: string, slug: string, worktreesDir: string, baseBranch?: string) => string` | Creates a git worktree with branch `shkmn/{slug}`. Returns the worktree path. The `worktreesDir` param lets the caller specify where worktrees are stored (defaults to `{runtimeDir}/worktrees`). |
| `removeWorktree` | `(worktreePath: string) => void` | Removes a worktree and deletes its branch. |
| `listWorktrees` | `(repoPath: string) => WorktreeInfo[]` | Lists all ShaktimaanAI-managed worktrees (branches matching `shkmn/*`). |
| `cleanupExpired` | `(manifestPath: string, retentionDays: number) => string[]` | Removes worktrees older than retention period. Takes the manifest path directly instead of repo path, since cleanup operates on the global worktree manifest rather than a single repo. Returns list of removed paths. |

### WorktreeInfo

```typescript
interface WorktreeInfo {
  path: string;
  branch: string;
  slug: string;
}
```

> **Implementation note:** `createdAt` was removed because `git worktree list --porcelain` does not include creation timestamps, so there is no reliable way to populate this field from git itself.

### Working Directory Resolution

The pipeline resolves a `workDir` for every task. All agents use this as their `cwd`.

```
1. Task has repo path → create worktree in that repo → workDir = worktree path
2. Task has no repo, config.repos.root is defined → create {repos.root}/{slug}/ → workDir = new directory
3. Task has no repo, no repos.root configured → workDir = invocation cwd
```

- Alignment stages (questions, research, design, structure, plan): `cwd` = repo path or task directory (same as today)
- Execution stages (impl, validate, review, pr): `cwd` = `state.workDir`

### Worktree Cleanup

- Worktrees are NOT deleted when tasks complete or fail — they follow deferred cleanup.
- When a task finishes, record `{ worktreePath, repoPath, completedAt }` in `{runtimeDir}/worktree-manifest.json`.
- On pipeline startup (if `worktree.cleanupOnStartup` is true), scan manifest and remove entries older than `retentionDays`.
- `shkmn cleanup` command also triggers this scan.

### Edge Cases

- Task has no repo path → no worktree created, workDir resolved per fallback chain above
- Worktree already exists for this slug → reuse it (crash recovery scenario)
- Repo is not a git repository → skip worktree, use repo path directly, log warning

---

## 2. Retry Logic

New module: `src/core/retry.ts`

### Interfaces

```typescript
interface StageOutcome {
  stage: string;
  success: boolean;
  verdict: string;    // "READY_FOR_REVIEW" | "NEEDS_FIXES" | "APPROVED" | "APPROVED_WITH_SUGGESTIONS" | "CHANGES_REQUIRED" | "unknown"
  output: string;
}

interface ReviewIssue {
  id: string;           // hash derived from severity + first sentence of description
  description: string;
  severity: string;     // "MUST_FIX" | "SHOULD_FIX" | "SUGGESTION"
  firstSeen: number;    // iteration number
  lastSeen: number;     // iteration number
}

interface RetryDecision {
  action: "continue" | "retry" | "fail";
  retryTarget?: string;
  feedbackContent?: string;
  reason: string;
}
```

### Decision Functions

**`decideAfterValidate(outcome, retryCount, maxRetries): RetryDecision`**

- `READY_FOR_REVIEW` → `{ action: "continue" }`
- `NEEDS_FIXES`, retryCount < maxRetries → `{ action: "retry", retryTarget: "impl", feedbackContent: failure report }`
- `NEEDS_FIXES`, retryCount >= maxRetries → `{ action: "fail" }`

**`decideAfterReview(outcome, previousIssues, currentIteration, maxRecurrence, enforceSuggestions): RetryDecision`**

1. Parse current review findings into `ReviewIssue[]`
2. Compare against `previousIssues` to categorize:
   - **Recurring** — same issue (by ID) appeared in previous iteration AND this one
   - **New** — first appearance this iteration
   - **Resolved** — in previous iteration but not this one
3. Decision:
   - `APPROVED` → continue
   - `APPROVED_WITH_SUGGESTIONS` + enforceSuggestions=false → continue
   - `APPROVED_WITH_SUGGESTIONS` + enforceSuggestions=true → retry (suggestions are new)
   - `CHANGES_REQUIRED` with any recurring issue that has persisted >= maxRecurrence iterations → fail
   - `CHANGES_REQUIRED` with new issues present → retry (progress is being made)
   - `CHANGES_REQUIRED` with only recurring issues below maxRecurrence → retry

**Key rule:** Only exhaust retries when the same issues keep coming back without progress. New issues always get a fresh attempt.

### Issue Matching

To determine if an issue is "the same" across iterations:
- Take the severity + first sentence of the description
- Lowercase, strip whitespace/punctuation
- Hash the result (simple string hash)
- False negatives (treating same issue as new) are the safe failure mode — they give impl another chance

### Verdict Parsing

**`parseAgentVerdict(output: string, stage: string): string`**

Extracts the verdict from agent output by looking for known patterns:
- For validate: `READY_FOR_REVIEW` or `NEEDS_FIXES`
- For review: `APPROVED`, `APPROVED_WITH_SUGGESTIONS`, or `CHANGES_REQUIRED`
- Returns the matched string or `"unknown"`

**`parseReviewFindings(output: string): ReviewIssue[]`**

Parses review output for findings in the format `[R{n}] SEVERITY: description`. Returns structured issues for tracking.

---

## 3. Pipeline Engine Modifications

Targeted changes to `src/core/pipeline.ts`.

### RunState Additions

```typescript
export interface RunState {
  // existing fields unchanged
  slug: string;
  taskFile: string;
  stages: string[];
  reviewAfter: string;
  currentStage: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedStages: CompletedStage[];
  error?: string;

  // new fields
  workDir?: string;              // effective working directory for agents
  worktreePath?: string;         // git worktree path (only for repo-backed tasks)
  invocationCwd?: string;        // directory where task was created from
  validateRetryCount: number;    // default 0
  reviewRetryCount: number;      // default 0
  reviewIssues: ReviewIssue[];   // issues from most recent review iteration
}
```

### processStage Modifications

**Before running an agent:**
1. If entering `impl` and `state.workDir` is not yet set (first time, not a retry) → resolve `workDir`:
   - Repo path exists → `createWorktree(repoPath, slug)`
   - No repo, `repos.root` configured → create `{repos.root}/{slug}/`
   - No repo, no root → use `invocationCwd`
   - On retry iterations, `state.workDir` is already set → skip this step (reuse existing worktree/directory)
2. For execution stages (impl, validate, review, pr) → set agent `cwd` to `state.workDir`

**After agent completes (for validate/review):**
1. Call `parseAgentVerdict()` on the output
2. Call the appropriate decision function from `retry.ts`
3. Handle the decision:
   - `continue` → proceed to next stage as normal
   - `retry` → write feedback to `artifacts/retry-feedback-{stage}-{count}.md`, update retry counters and reviewIssues in state, set `currentStage` back to `impl`, move task back to impl's pending directory
   - `fail` → move to failed with reason

**On task completion/failure:**
- Record worktree info in `worktree-manifest.json` for deferred cleanup

### createRunState Modifications

Initialize new fields:
```typescript
validateRetryCount: 0,
reviewRetryCount: 0,
reviewIssues: [],
```

### startRun Modifications

Capture `invocationCwd` if provided (passed through from CLI command or task creator).

---

## 4. Execution Agent Prompts

All prompts use the same frontmatter + body format established in Spec 2b.

### 4A: Impl Agent

**Purpose:** Execute the plan using TDD when test framework is available, straight implementation when not. Commit per slice. Handle retry iterations.

**Tool permissions:** Read, Write, Edit, Bash, Glob, Grep (full access)

**Key instructions:**
- Read the plan from `{{PREVIOUS_OUTPUT}}`
- Check `{{REPO_CONTEXT}}` for build/test commands
- If test commands exist → strict TDD (red-green-refactor per slice)
- If no test commands → write code only, flag prominently: "NO TEST FRAMEWORK DETECTED"
- Commit after each slice (small, focused commits with descriptive messages)
- **Retry awareness:** Check for `retry-feedback-*.md` in artifacts. If present, this is a fix iteration — address ONLY the reported issues, don't redo passing work
- Retry commit messages should reference what was fixed

**Self-validation:**
- Every slice from the plan is addressed
- If TDD: every behavior has a test
- All commits are clean
- If retry: all feedback issues addressed

### 4B: Validate Agent

**Purpose:** Discover and run build/test commands, report structured results.

**Tool permissions:** Read, Bash, Glob, Grep (no Write/Edit)

**Key instructions:**
- Discover build/test commands from repo context and build configs
- Run build first, then tests
- Structured output with machine-parseable verdict line:
  ```
  **Verdict:** READY_FOR_REVIEW
  ```
  or
  ```
  **Verdict:** NEEDS_FIXES
  ```
- When `NEEDS_FIXES`: list each failure with file path and error message so impl knows exactly what to fix

### 4C: Review Agent

**Purpose:** Code quality review with trackable findings across iterations.

**Tool permissions:** Read, Glob, Grep (no Write/Edit/Bash)

**Key instructions:**
- Same review criteria (correctness, test quality, type safety, error handling, clarity, SOLID, security, performance, consistency)
- Each finding has a unique ID: `[R{n}]` format
- Finding format:
  ```
  [R1] MUST_FIX: Missing null check in parseConfig — config.agents could be undefined
    File: src/config/loader.ts:45
  ```
- The `[R{n}]` + severity + first sentence is used for issue tracking across iterations
- Machine-parseable verdict line:
  ```
  **Verdict:** APPROVED
  ```
  or `APPROVED_WITH_SUGGESTIONS` or `CHANGES_REQUIRED`
- **On retry iterations:** Judge the whole implementation holistically, not just the diff from last iteration. Changes to previously-approved code are allowed if they're a reasonable consequence of fixing flagged issues. Only flag as regression if a fix genuinely broke something (tests fail, functionality removed, new bugs introduced).

### 4D: PR Agent

**Purpose:** Push branch and create pull request.

**Tool permissions:** Bash only

**Key instructions:**
- Verify all changes are committed (impl should have done this, but verify)
- Push the branch to remote
- **Check for PR templates** — look for `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, or `docs/pull_request_template.md`. If found, follow its structure.
- If no template, use default structure: summary (1-3 bullets) + test results from validate + ADO link if applicable
- No review verdict in PR body
- If ADO item ID exists in task, include link
- Output the PR URL
- Does NOT merge — only creates the PR

---

## 5. Config Additions

### New Config Sections

```typescript
worktree: {
  retentionDays: number;        // default 7
  cleanupOnStartup: boolean;    // default true
};

review: {
  enforceSuggestions: boolean;   // default true
};
```

### Additions to Existing Agents Section

```typescript
agents: {
  // existing fields unchanged...
  maxValidateRetries: number;    // default 2
  maxReviewRecurrence: number;   // default 3
};
```

---

## 6. File Change Summary

### New Files

| File | Purpose |
|---|---|
| `src/core/worktree.ts` | Git worktree lifecycle — create, remove, list, cleanup |
| `src/core/retry.ts` | Retry decision logic, verdict parsing, issue tracking |

### Modified Files

| File | What Changes |
|---|---|
| `src/core/types.ts` | Add `workDir`, `worktreePath`, `invocationCwd`, `validateRetryCount`, `reviewRetryCount`, `reviewIssues` to RunState. Add `ReviewIssue` interface. |
| `src/core/pipeline.ts` | Worktree setup before impl, workDir resolution for agent cwd, verdict parsing after validate/review, retry loop integration, cleanup manifest tracking |
| `src/config/defaults.ts` | Add `worktree` and `review` sections. Add `maxValidateRetries`, `maxReviewRecurrence` to agents. |
| `src/config/schema.ts` | Zod schemas for `worktree` and `review` sections |
| `src/config/loader.ts` | Resolve new config fields |
| `agents/impl.md` | Full rewrite: TDD workflow, retry awareness, per-slice commits |
| `agents/validate.md` | Full rewrite: structured verdict output, failure detail |
| `agents/review.md` | Full rewrite: numbered findings, issue tracking, holistic re-review |
| `agents/pr.md` | Full rewrite: PR template discovery, ADO linking |

### Not Changed

- `src/core/agent-runner.ts` — agents receive `cwd` from pipeline, no runner changes needed
- `src/core/agent-config.ts` — no changes
- `src/core/repo-context.ts` — no changes
- Alignment agent files (questions, research, design, structure, plan) — no changes
- `src/core/registry.ts`, `src/core/logger.ts` — no changes

---

## 7. What Is NOT In Scope

- Slack/Notion/CLI input surfaces — Spec 3
- Dashboard — Spec 4
- `shkmn cleanup` CLI command implementation — will be added but is thin (calls `cleanupExpired`)
- Parallel impl (multiple slices running concurrently) — future enhancement
- Auto-merge after PR — always human or CI decision
