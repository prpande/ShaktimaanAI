# Spec 5a — Pipeline Review Loop Optimization

## Problem Statement

The current impl-validate-review retry loop is expensive and slow. Analysis of a real pipeline run (task: `shkmn stats` command, Apr 5 2026) revealed:

- **$16.32 total cost**, 3h 36m wall time for a moderate-complexity feature
- **75% of cost ($12.27)** spent in the review retry loop
- 4 impl runs, 4 validate runs, 4 review runs — all triggered by `APPROVED_WITH_SUGGESTIONS`
- Every review finding was `SUGGESTION` severity — zero MUST_FIX or SHOULD_FIX
- Each review iteration invented new nitpicks instead of re-verifying previous suggestions
- Validate re-ran the full test suite identically to what impl already ran at end of TDD

With optimization, the same task would cost ~$6.50 in ~1h 15m.

## Goals

1. Reduce wasted retry cycles on low-value suggestion churn
2. Eliminate redundant test suite runs between impl and review
3. Allow non-coding tasks to skip validation entirely
4. Skip TDD for non-coding tasks — no useless tests for documentation or config files
5. Maintain code quality — HIGH_VALUE suggestions still get addressed

## Non-Goals

- Changing the alignment stages (questions through plan) — they are already efficient ($3.46 total)
- Parallelizing stages within a single task
- Changing the review agent's core review criteria

---

## Change 1: Review Suggestion Sub-Classification

### Current Behavior

The review agent outputs findings with three severity levels:

```
[R1] MUST_FIX: ...
[R2] SHOULD_FIX: ...
[R3] SUGGESTION: ...
```

When all findings are SUGGESTION, the verdict is `APPROVED_WITH_SUGGESTIONS`. If `enforceSuggestions` is true (default), the pipeline retries impl up to `maxReviewRecurrence` (3) times. Each retry burns a full impl + validate + review cycle.

### Proposed Behavior

Split SUGGESTION into two sub-classes:

```
[R1] SUGGESTION(HIGH_VALUE): `_usage` naming inconsistent with `usage` on lines 259, 270
[R2] SUGGESTION(NITPICK): `formatDuration` could guard against negative input
```

**HIGH_VALUE criteria** — issues that meaningfully improve the shipped code:

- Naming inconsistencies within the same file or function
- Dead or unreachable code
- DRY violations (duplicated logic across functions)
- Missing error handling on real, exercised code paths
- Type safety gaps on public API surfaces (redundant casts, missing guards)

**NITPICK criteria** — issues that are cosmetic or speculative:

- Defensive guards for caller-controlled or impossible inputs
- Style and formatting preferences
- Feature requests not in the original task spec
- Test pattern preferences that don't affect correctness
- Cosmetic issues (display formatting, decimal precision)

### Verdict Mapping

| Findings Present | Verdict |
|---|---|
| Any MUST_FIX or SHOULD_FIX | `CHANGES_REQUIRED` (unchanged) |
| At least one SUGGESTION(HIGH_VALUE), no MUST_FIX/SHOULD_FIX | `APPROVED_WITH_SUGGESTIONS` |
| Only SUGGESTION(NITPICK), no higher severity | `APPROVED` |
| No findings | `APPROVED` |

### Files Changed

- **`agents/review.md`** — Add classification guidance, update findings format, add examples of HIGH_VALUE vs NITPICK
- **`src/core/retry.ts`** — Update `parseReviewFindings()` to extract sub-class from `SUGGESTION(HIGH_VALUE)` / `SUGGESTION(NITPICK)` format. Update `decideAfterReview()` to only count HIGH_VALUE suggestions when deciding retry.

---

## Change 2: Move Validate After Review

### Current Stage Order

```
questions → research → design → structure → plan → impl → validate → review → pr
```

### New Stage Order

```
questions → research → design → structure → plan → impl → review → validate → pr
```

### Rationale

The impl agent already performs full TDD and runs the complete test suite at the end of each implementation (Step 3 of impl.md). The validate agent then runs the exact same test suite again. In the analyzed run:

- impl reported: 518/525 pass, 7 pre-existing failures
- validate reported: 56 new tests pass, 9 pre-existing failures, verdict READY_FOR_REVIEW

Validate added zero new information. Its unique value — independent verification — is most useful as a **final gate before PR**, not as an intermediate check between every impl-review cycle.

### New Flow

```
impl (TDD, self-tests at end)
  → review
    → CHANGES_REQUIRED: back to impl (new cycle)
    → APPROVED_WITH_SUGGESTIONS (HIGH_VALUE) + suggestionRetryUsed=false:
        set suggestionRetryUsed=true, back to impl (same cycle)
    → APPROVED (or suggestions but budget spent):
        proceed to validate
  → validate (final gate)
    → READY_FOR_REVIEW: proceed to pr
    → NEEDS_FIXES: back to impl (new cycle, resets suggestionRetryUsed)
```

### Per-Cycle Suggestion Retry Counter

Each time impl is entered from a **new trigger** (initial entry, validate failure), the suggestion retry counter resets. This means:

- Each impl→review cycle gets up to `maxSuggestionRetriesPerCycle` (default: 1) HIGH_VALUE suggestion retries
- The counter resets when impl is re-entered from validate failure (new code changes = new suggestions possible)
- CHANGES_REQUIRED retries do NOT consume the suggestion budget (those are mandatory fixes)

**Example — validate fails after suggestion pass:**

```
impl → review (APPROVED_WITH_SUGGESTIONS, HIGH_VALUE)      # cycle 1
  → impl (suggestion fix) → review (APPROVED)              # cycle 1, suggestion budget spent
    → validate (NEEDS_FIXES)                                # final gate fails
      → impl (fix) → review (APPROVED_WITH_SUGGESTIONS)    # cycle 2, budget reset
        → impl (suggestion fix) → review (APPROVED)        # cycle 2, budget spent
          → validate (READY_FOR_REVIEW) → pr               # done
```

### State Changes

**RunState additions:**

```typescript
suggestionRetryUsed: boolean;    // resets on each new impl cycle
validateFailCount: number;       // tracks post-review validate failures
```

**RunState removals:**

- `validateRetryCount` — no longer needed (validate doesn't sit between impl and review)

**Retained:**

- `reviewRetryCount` — still tracks total review iterations for logging
- `reviewIssues: ReviewIssue[]` — still tracks issue recurrence for CHANGES_REQUIRED

### Config Changes

**defaults.ts:**

```typescript
// Remove:
maxReviewRecurrence: 3,           // replaced by per-cycle cap

// Add:
maxSuggestionRetriesPerCycle: 1,  // HIGH_VALUE suggestion retries per impl cycle

// Retain:
maxValidateRetries: 2,            // now applies to post-review validate
enforceSuggestions: true,         // master switch for suggestion retries
```

### Default Stages Update

```typescript
// Old:
defaultStages: ["questions","research","design","structure","plan","impl","validate","review","pr"]

// New:
defaultStages: ["questions","research","design","structure","plan","impl","review","validate","pr"]
```

### Files Changed

- **`src/config/defaults.ts`** — Reorder defaultStages, replace `maxReviewRecurrence` with `maxSuggestionRetriesPerCycle`, remove `maxConcurrentValidate`
- **`src/core/types.ts`** — Add `suggestionRetryUsed`, `validateFailCount` to RunState, remove `validateRetryCount`
- **`src/core/retry.ts`** — Rewrite `decideAfterReview()` to use per-cycle suggestion budget, add `decideAfterFinalValidate()` for post-review validate logic
- **`src/core/pipeline.ts`** — Update stage progression logic: after review → validate (not after impl → validate), handle validate failure by looping back to impl with cycle reset
- **`src/core/stage-map.ts`** — Update stage ordering and directory mappings
- **`src/core/registry.ts`** — Remove `maxConcurrentValidate` and `getActiveValidateCount()`, simplify `canStartAgent()`
- **`src/config/schema.ts`** — Update schema for new config fields
- **`src/config/loader.ts`** — Wire new defaults

---

## Change 3: Conditional Validate for Non-Coding Tasks

### Rationale

Documentation tasks, config changes, and other non-coding tasks don't benefit from a validate stage that runs build + test. The validate agent would find no tests to run and produce a vacuous READY_FOR_REVIEW verdict.

### Approach

Use the existing stages mechanism — no new task-type field needed. The task file's `Pipeline Config` already controls which stages run:

**Coding task (default):**
```markdown
## Pipeline Config
stages: questions, research, design, structure, plan, impl, review, validate, pr
```

**Documentation / non-coding task:**
```markdown
## Pipeline Config
stages: questions, research, design, structure, plan, impl, review, pr
```

The pipeline already walks the stages array in order and only runs listed stages. Omitting `validate` from the list skips it entirely. Zero code changes needed for the skip logic.

### Task Creator Guidance

Update the task creator agent (`agents/task-creator.md` or equivalent) to:

- Default to including `validate` for tasks that involve code changes
- Omit `validate` for tasks that are documentation-only, config-only, or non-code

### Concurrency Change

Remove `maxConcurrentValidate: 1` from defaults. Since validate now runs at most once per task cycle (final gate, not between every impl→review), the bottleneck it guarded against is gone. The existing `maxConcurrentTotal: 3` provides sufficient concurrency control.

### Files Changed

- **`src/config/defaults.ts`** — Remove `maxConcurrentValidate` field and default
- **`src/config/schema.ts`** — Remove `maxConcurrentValidate` from schema
- **`src/config/loader.ts`** — Remove `maxConcurrentValidate` wiring
- **`src/core/registry.ts`** — Remove validate-specific concurrency logic
- **`src/commands/init.ts`** — Remove `maxConcurrentValidate` from init output
- **Agent prompts** — Update task creator to classify coding vs non-coding for stage selection

---

## Change 4: Skip TDD for Non-Coding Tasks

### Problem

The impl agent currently enforces strict TDD for every task (Step 2 of `agents/impl.md`). For non-coding tasks — documentation, README, quickstart guides, config files — this produces useless test files like:

```typescript
// tests/docs/readme.test.ts
describe("README.md", () => {
  it("should exist", () => { ... });
  it("should contain installation section", () => { ... });
});
```

These tests add no value, waste impl turns writing and running them, inflate validate runs, and generate noise in review findings. On a documentation task, the TDD overhead can account for 30-50% of impl time.

### Proposed Behavior

The impl agent adapts its workflow based on whether the task involves code:

**Coding tasks** (default) — strict TDD, unchanged:
1. Write failing test first
2. Write minimum code to pass
3. Run test, confirm passes
4. Refactor, commit

**Non-coding tasks** — direct implementation, no tests:
1. Write the deliverable (docs, config, README, etc.)
2. Verify it renders/parses correctly (e.g., markdown lint, JSON validity) if applicable
3. Commit

### How the Impl Agent Knows

The task's configured stages already signal intent (from Change 3):

- **Validate in stage list** → coding task → TDD
- **No validate in stage list** → non-coding task → skip TDD

The impl agent checks whether `validate` appears in the task's stage sequence (already available in the system prompt's pipeline context section: `Stage sequence for this task: questions, research, ...`). If validate is absent, the agent follows the "Without test framework" path that already exists in `agents/impl.md`:

```markdown
*Without test framework:*
1. Write code for slice
2. Ensure builds
3. Commit with note: `feat(<scope>): <what> [no tests — no framework]`
```

This path exists but currently only triggers when no test framework is detected. We repurpose it to also trigger when validate is not in the stage list.

### Impl Agent Prompt Change

Update `agents/impl.md` Step 2 decision logic:

```markdown
## Step 2 — Implement Each Slice

Determine your implementation mode:

**TDD mode** (strict) — when `validate` is in the stage sequence:
1. Write failing test first (follow project conventions)
2. Write minimum code to make test pass
3. Run test, confirm passes
4. Refactor if needed
5. Commit slice

**Direct mode** — when `validate` is NOT in the stage sequence (documentation, config, non-code tasks):
1. Write the deliverable for this slice
2. If the deliverable has a verifiable format (JSON, YAML, TOML), validate it parses correctly
3. Commit slice with note: `docs(<scope>): <what>` or `chore(<scope>): <what>`
4. Do NOT write test files for documentation or config content
```

### Review Agent Awareness

Update `agents/review.md` to not flag missing tests for non-coding tasks:

```markdown
When reviewing non-coding tasks (validate not in stage sequence):
- Do NOT flag missing test coverage as MUST_FIX or SHOULD_FIX
- Focus review on: content accuracy, completeness, formatting, links, spelling
- SUGGESTION criteria shift: structural improvements to docs, missing sections, unclear instructions
```

### Files Changed

- **`agents/impl.md`** — Add direct mode for non-coding tasks, triggered by validate absence in stage sequence
- **`agents/review.md`** — Add guidance for reviewing non-coding tasks (no test coverage expectations)

### Impact

For a documentation task like "Write a README and quickstart guide":
- **Before**: impl writes 3-5 useless test files (15-20 turns), validate runs them (5-10 turns), review flags test quality issues
- **After**: impl writes docs directly (~10 turns), no validate, review focuses on content quality

Estimated savings per documentation task: ~40% of impl cost, 100% of validate cost.

---

## Impact Analysis

### Cost Impact (based on analyzed run)

| Metric | Before | After |
|---|---|---|
| impl runs | 4 | 2 |
| validate runs | 4 | 1 |
| review runs | 4 | 2 |
| Total cost | $16.32 | ~$6.50 |
| Wall time | 3h 36m | ~1h 15m |
| Cost reduction | — | ~60% |
| Time reduction | — | ~65% |

### Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Review evaluates unverified code | Low | Impl already runs full TDD + test suite. Final validate catches any gaps. |
| HIGH_VALUE vs NITPICK misclassification | Low | Review agent prompt includes clear criteria + examples. 1 retry cap bounds worst case. |
| Validate failure after review wastes review cost | Low | Review cost ($0.77) is small relative to impl ($1.5-3.6). The cycle-reset ensures suggestions are re-evaluated on changed code. |
| Non-coding task incorrectly skips validate | Low | Stage list is explicit in task file. Task creator prompt provides guidance. |

---

## Testing Plan

1. **Unit tests for retry.ts** — Test `parseReviewFindings()` with HIGH_VALUE/NITPICK sub-classes, test `decideAfterReview()` with per-cycle suggestion budget, test cycle reset on validate failure
2. **Unit tests for pipeline stage ordering** — Verify new default stage order, verify validate comes after review
3. **Integration test** — Run a task through the full pipeline with a mock review agent returning APPROVED_WITH_SUGGESTIONS(HIGH_VALUE), verify exactly 1 retry, verify validate runs once at end
4. **Regression test** — Verify CHANGES_REQUIRED flow still works (not affected by suggestion budget)
5. **Non-coding task test** — Verify pipeline completes without validate when stage list omits it
6. **Impl mode selection test** — Verify impl agent prompt includes correct mode guidance based on stage sequence (TDD when validate present, direct when absent)
7. **Review non-coding test** — Verify review agent does not flag missing test coverage when validate is absent from stage sequence
