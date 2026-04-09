# Spec 5a — Pipeline Review Loop Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce pipeline review loop cost by ~60% through suggestion classification, moving validate after review, and skipping TDD for non-coding tasks.

**Architecture:** Four changes to the pipeline: (1) review agent sub-classifies SUGGESTION as HIGH_VALUE or NITPICK, (2) validate moves after review as final gate, (3) non-coding tasks skip validate by omitting it from stage list, (4) impl agent uses direct mode (no TDD) when validate is absent. Changes flow bottom-up: types → config → retry logic → pipeline orchestration → agent prompts.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK, Zod

---

### Task 1: Update RunState Types (non-behavioral scaffolding)

**Files:**
- Modify: `src/core/types.ts`

> **Note:** Tasks 1-3 are structural scaffolding — interface definitions, config constants, and directory mappings. They have no independently testable behavior. TDD applies starting at Task 4 where behavioral logic is implemented.

- [ ] **Step 1: Add `suggestionRetryUsed` and `validateFailCount` to RunState, replace `maxReviewRecurrence` usage**

In `src/core/types.ts`, update the RunState interface. Make `validateRetryCount` optional (kept for backward compat with existing `run-state.json` files on disk) and add the new fields:

```typescript
// In RunState interface, replace the retry counters block:

  // Retry counters
  validateRetryCount?: number;    // DEPRECATED — kept optional for backward compat
  reviewRetryCount: number;
  reviewIssues: ReviewIssue[];
  suggestionRetryUsed: boolean;   // NEW — resets each impl cycle
  validateFailCount: number;      // NEW — tracks post-review validate failures
```

- [ ] **Step 2: Verify the build passes**

Run: `npx tsc --noEmit`
Expected: No new errors (existing code doesn't reference the new fields yet, and they're non-optional so existing object literals will fail — but we'll fix those in subsequent tasks).

Note: The build may show errors in files that construct RunState objects. This is expected and will be resolved in Tasks 2–6. Proceed.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add suggestionRetryUsed and validateFailCount to RunState"
```

---

### Task 2: Update Config — Defaults, Schema, Loader (non-behavioral scaffolding)

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Update defaults.ts — reorder stages, replace maxReviewRecurrence, remove maxConcurrentValidate**

In `src/config/defaults.ts`, make these changes:

**a)** Remove `maxConcurrentValidate` from `ShkmnConfig.agents` interface (line 88):
```typescript
// REMOVE this line:
    maxConcurrentValidate: number;
```

**b)** Replace `maxReviewRecurrence` with `maxSuggestionRetriesPerCycle` in the interface (line 94):
```typescript
// CHANGE:
    maxReviewRecurrence: number;
// TO:
    maxSuggestionRetriesPerCycle: number;
```

**c)** Update `defaultStages` in DEFAULT_CONFIG (lines 145-148) — swap validate and review:
```typescript
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "review", "validate", "pr",
    ],
```

**d)** Remove `maxConcurrentValidate: 1,` from DEFAULT_CONFIG.agents (line 151).

**e)** Replace `maxReviewRecurrence: 3,` with `maxSuggestionRetriesPerCycle: 1,` (line 181).

**f)** Update `STAGE_CONTEXT_RULES` — review now reads impl output directly (not validation report), and validate reads review output:
```typescript
  review:    { includeTaskContent: true,  previousOutputLabel: "Implementation Output",   includeRepoContext: true },
  validate:  { includeTaskContent: false, previousOutputLabel: "Review Output",            includeRepoContext: true },
```

- [ ] **Step 2: Update schema.ts — remove maxConcurrentValidate, replace maxReviewRecurrence**

In `src/config/schema.ts`, inside the `agents` object (lines 38-54):

Remove:
```typescript
    maxConcurrentValidate: z.number().optional(),
```

Replace:
```typescript
    maxReviewRecurrence: z.number().optional(),
```
With:
```typescript
    maxSuggestionRetriesPerCycle: z.number().optional(),
```

- [ ] **Step 3: Update loader.ts — wire new config fields**

In `src/config/loader.ts`, in the `resolveConfig` function (lines 74-86):

Remove:
```typescript
      maxConcurrentValidate: parsed.agents?.maxConcurrentValidate ?? da.maxConcurrentValidate,
```

Replace:
```typescript
      maxReviewRecurrence: parsed.agents?.maxReviewRecurrence ?? da.maxReviewRecurrence,
```
With:
```typescript
      maxSuggestionRetriesPerCycle: parsed.agents?.maxSuggestionRetriesPerCycle ?? da.maxSuggestionRetriesPerCycle,
```

- [ ] **Step 4: Update init.ts — remove maxConcurrentValidate from init output**

In `src/commands/init.ts`, remove line 51:
```typescript
      maxConcurrentValidate: d.agents.maxConcurrentValidate,
```

- [ ] **Step 5: Verify the build compiles (expect some downstream errors)**

Run: `npx tsc --noEmit`
Expected: Errors in files that reference `maxConcurrentValidate` or `maxReviewRecurrence` (registry.ts, pipeline.ts, start.ts). These will be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/config/defaults.ts src/config/schema.ts src/config/loader.ts src/commands/init.ts
git commit -m "feat(config): reorder stages, replace maxReviewRecurrence with maxSuggestionRetriesPerCycle, remove maxConcurrentValidate"
```

---

### Task 3: Update Stage Map (non-behavioral scaffolding)

**Files:**
- Modify: `src/core/stage-map.ts`

- [ ] **Step 1: Reorder PIPELINE_STAGES — swap validate and review**

In `src/core/stage-map.ts`, update line 7-10:

```typescript
export const PIPELINE_STAGES = [
  "questions", "research", "design", "structure", "plan",
  "impl", "review", "validate", "pr",
] as const;
```

Also update `STAGE_DIR_MAP` (lines 15-25) — review gets directory 07, validate gets 08:

```typescript
export const STAGE_DIR_MAP: Record<string, string> = {
  questions: "01-questions",
  research: "02-research",
  design: "03-design",
  structure: "04-structure",
  plan: "05-plan",
  impl: "06-impl",
  review: "07-review",
  validate: "08-validate",
  pr: "09-pr",
};
```

- [ ] **Step 2: Commit**

```bash
git add src/core/stage-map.ts
git commit -m "feat(stage-map): reorder stages — review before validate"
```

---

### Task 4: Simplify Registry — Remove Validate Concurrency

**Files:**
- Modify: `src/core/registry.ts`
- Modify: `src/commands/start.ts`
- Test: `tests/core/registry.test.ts`

- [ ] **Step 1: Write failing tests for simplified registry**

In `tests/core/registry.test.ts`, add a new test that validates the registry no longer has validate-specific concurrency. First, update the existing `createAgentRegistry` call signature in tests — it should now accept only `maxConcurrentTotal`:

Find all occurrences of `createAgentRegistry(N, M)` in the test file (two-arg calls) and replace with single-arg `createAgentRegistry(N)`.

Add this test:

```typescript
it("allows multiple validate agents up to maxConcurrentTotal", () => {
  const registry = createAgentRegistry(3);
  registry.register("task-1", "validate", "Dharma", new AbortController());
  registry.register("task-2", "validate", "Dharma", new AbortController());
  registry.register("task-3", "validate", "Dharma", new AbortController());
  expect(registry.canStartAgent("validate")).toBe(false); // at total limit, not validate limit
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: FAIL — `createAgentRegistry` still expects 2 args.

- [ ] **Step 3: Update registry.ts — remove validate concurrency logic**

In `src/core/registry.ts`:

**a)** Remove `getActiveValidateCount` from the `AgentRegistry` interface (line 18).

**b)** Change factory signature from `createAgentRegistry(maxConcurrentTotal: number, maxConcurrentValidate: number)` to `createAgentRegistry(maxConcurrentTotal: number)` (line 23).

**c)** Remove the `getActiveValidateCount()` method implementation (lines 53-58).

**d)** Simplify `canStartAgent()` — remove the validate-specific check (lines 60-66):

```typescript
    canStartAgent(_stage: string) {
      return agents.size < maxConcurrentTotal;
    },
```

The `_stage` parameter is kept for interface compatibility but no longer used for branching.

- [ ] **Step 4: Update start.ts — remove maxConcurrentValidate from createAgentRegistry call**

In `src/commands/start.ts`, find the line that calls `createAgentRegistry(config.agents.maxConcurrentTotal, config.agents.maxConcurrentValidate)` (around line 48) and change to:

```typescript
createAgentRegistry(config.agents.maxConcurrentTotal)
```

- [ ] **Step 5: Remove old validate-specific tests from registry.test.ts**

Remove tests that specifically test `getActiveValidateCount` or the old validate-specific concurrency behavior. Update any remaining tests that use the two-arg constructor.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/registry.ts src/commands/start.ts tests/core/registry.test.ts
git commit -m "feat(registry): remove validate-specific concurrency, simplify canStartAgent"
```

---

### Task 5: Update Retry Logic — Suggestion Classification + Per-Cycle Budget

**Files:**
- Modify: `src/core/retry.ts`
- Modify: `tests/core/retry.test.ts`

This is the core logic change. The `parseReviewFindings` function must parse `SUGGESTION(HIGH_VALUE)` and `SUGGESTION(NITPICK)` sub-classes, and `decideAfterReview` must use per-cycle suggestion budget instead of `maxReviewRecurrence`.

- [ ] **Step 1: Write failing tests for parseReviewFindings with sub-classes**

Add to `tests/core/retry.test.ts` in the `parseReviewFindings` describe block:

```typescript
it("parses SUGGESTION(HIGH_VALUE) sub-class", () => {
  const output = "[R1] SUGGESTION(HIGH_VALUE): Naming inconsistency — _usage vs usage\n";
  const findings = parseReviewFindings(output);
  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("SUGGESTION(HIGH_VALUE)");
  expect(findings[0].description).toContain("Naming inconsistency");
});

it("parses SUGGESTION(NITPICK) sub-class", () => {
  const output = "[R1] SUGGESTION(NITPICK): formatDuration could guard against negative input\n";
  const findings = parseReviewFindings(output);
  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("SUGGESTION(NITPICK)");
});

it("parses mixed findings with sub-classes and plain severities", () => {
  const output = [
    "[R1] MUST_FIX: Missing null check",
    "[R2] SUGGESTION(HIGH_VALUE): DRY violation in readAllDailyLogs",
    "[R3] SUGGESTION(NITPICK): Consider adding --sort option",
  ].join("\n");
  const findings = parseReviewFindings(output);
  expect(findings).toHaveLength(3);
  expect(findings[0].severity).toBe("MUST_FIX");
  expect(findings[1].severity).toBe("SUGGESTION(HIGH_VALUE)");
  expect(findings[2].severity).toBe("SUGGESTION(NITPICK)");
});

it("falls back to plain SUGGESTION when no sub-class provided", () => {
  const output = "[R1] SUGGESTION: Some general suggestion\n";
  const findings = parseReviewFindings(output);
  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("SUGGESTION");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/retry.test.ts`
Expected: The new sub-class tests FAIL because the regex doesn't match `SUGGESTION(HIGH_VALUE)`.

- [ ] **Step 3: Update parseReviewFindings to handle sub-classes**

In `src/core/retry.ts`, update the regex pattern in `parseReviewFindings` (line 83):

```typescript
export function parseReviewFindings(output: string): ReviewIssue[] {
  // Match lines like:
  //   [R1] MUST_FIX: description
  //   [R2] SUGGESTION(HIGH_VALUE): description
  //   [R3] SUGGESTION(NITPICK): description
  const pattern = /\[R\d+\]\s+(MUST_FIX|SHOULD_FIX|SUGGESTION(?:\(HIGH_VALUE\)|\(NITPICK\))?):\s*(.+)/g;
  const findings: ReviewIssue[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const severity = match[1];
    const description = match[2].trim();
    const id = issueHash(severity, description);
    findings.push({
      id,
      severity,
      description,
      firstSeen: 0,
      lastSeen: 0,
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run parseReviewFindings tests**

Run: `npx vitest run tests/core/retry.test.ts -t "parseReviewFindings"`
Expected: All PASS.

- [ ] **Step 5: Write failing tests for new decideAfterReview behavior**

Add a new describe block in `tests/core/retry.test.ts`:

```typescript
describe("decideAfterReview — per-cycle suggestion budget", () => {
  const highValueOutput = [
    "[R1] SUGGESTION(HIGH_VALUE): DRY violation in readAllDailyLogs",
    "",
    "**Verdict:** APPROVED_WITH_SUGGESTIONS",
  ].join("\n");

  const nitpickOnlyOutput = [
    "[R1] SUGGESTION(NITPICK): formatDuration could guard against negative input",
    "[R2] SUGGESTION(NITPICK): Consider adding --sort option",
    "",
    "**Verdict:** APPROVED_WITH_SUGGESTIONS",
  ].join("\n");

  const mixedOutput = [
    "[R1] SUGGESTION(HIGH_VALUE): Naming inconsistency",
    "[R2] SUGGESTION(NITPICK): Extra decimal guard",
    "",
    "**Verdict:** APPROVED_WITH_SUGGESTIONS",
  ].join("\n");

  it("returns retry when HIGH_VALUE suggestions and suggestionRetryUsed=false", () => {
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output: highValueOutput };
    const decision = decideAfterReview(outcome, [], 1, false, true);
    expect(decision.action).toBe("retry");
  });

  it("returns continue when HIGH_VALUE suggestions but suggestionRetryUsed=true", () => {
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output: highValueOutput };
    const decision = decideAfterReview(outcome, [], 2, true, true);
    expect(decision.action).toBe("continue");
  });

  it("returns continue when only NITPICK suggestions (treated as APPROVED)", () => {
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output: nitpickOnlyOutput };
    const decision = decideAfterReview(outcome, [], 1, false, true);
    expect(decision.action).toBe("continue");
  });

  it("returns retry for mixed output when suggestionRetryUsed=false (has HIGH_VALUE)", () => {
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output: mixedOutput };
    const decision = decideAfterReview(outcome, [], 1, false, true);
    expect(decision.action).toBe("retry");
  });

  it("returns continue when enforceSuggestions=false regardless of HIGH_VALUE", () => {
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output: highValueOutput };
    const decision = decideAfterReview(outcome, [], 1, false, false);
    expect(decision.action).toBe("continue");
  });

  it("CHANGES_REQUIRED still retries regardless of suggestion budget", () => {
    const output = "[R1] MUST_FIX: Missing null check\n\n**Verdict:** CHANGES_REQUIRED";
    const outcome = { stage: "review", success: true, verdict: "CHANGES_REQUIRED", output };
    const decision = decideAfterReview(outcome, [], 1, true, true);
    expect(decision.action).toBe("retry");
  });

  it("plain SUGGESTION (no sub-class) is treated as HIGH_VALUE for backward compat", () => {
    const output = "[R1] SUGGESTION: Some suggestion\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS";
    const outcome = { stage: "review", success: true, verdict: "APPROVED_WITH_SUGGESTIONS", output };
    const decision = decideAfterReview(outcome, [], 1, false, true);
    expect(decision.action).toBe("retry");
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/core/retry.test.ts -t "per-cycle suggestion budget"`
Expected: FAIL — `decideAfterReview` has wrong signature.

- [ ] **Step 7: Rewrite decideAfterReview with new signature**

Replace the entire `decideAfterReview` function in `src/core/retry.ts` (lines 169-251):

```typescript
/**
 * Decides what to do after the review stage completes.
 *
 * New signature (Spec 5a): uses per-cycle suggestion budget instead of maxRecurrence.
 *
 * - APPROVED → continue
 * - APPROVED_WITH_SUGGESTIONS:
 *   - Only NITPICK findings → treat as APPROVED (continue)
 *   - Any HIGH_VALUE (or plain SUGGESTION) + enforceSuggestions + !suggestionRetryUsed → retry
 *   - Otherwise → continue
 * - CHANGES_REQUIRED → retry (with issue tracking for recurring detection)
 * - unknown → fail
 */
export function decideAfterReview(
  outcome: StageOutcome,
  previousIssues: ReviewIssue[],
  currentIteration: number,
  suggestionRetryUsed: boolean,
  enforceSuggestions: boolean,
): RetryDecision {
  if (outcome.verdict === "APPROVED") {
    return { action: "continue", reason: "Review approved" };
  }

  if (outcome.verdict === "APPROVED_WITH_SUGGESTIONS") {
    if (!enforceSuggestions) {
      return {
        action: "continue",
        reason: "Review approved with suggestions (not enforced)",
      };
    }

    // Check if any findings are HIGH_VALUE (or plain SUGGESTION for backward compat)
    const currentFindings = parseReviewFindings(outcome.output);
    const hasHighValue = currentFindings.some(
      f => f.severity === "SUGGESTION(HIGH_VALUE)" || f.severity === "SUGGESTION",
    );

    if (!hasHighValue) {
      // All findings are NITPICK — treat as approved
      return {
        action: "continue",
        reason: "Review approved — all suggestions are NITPICK",
      };
    }

    if (suggestionRetryUsed) {
      return {
        action: "continue",
        reason: "Review has HIGH_VALUE suggestions but suggestion retry budget spent for this cycle",
      };
    }

    // HIGH_VALUE found, budget available — retry
    const taggedFindings = currentFindings
      .filter(f => f.severity !== "SUGGESTION(NITPICK)")
      .map(f => ({ ...f, firstSeen: currentIteration, lastSeen: currentIteration }));

    return {
      action: "retry",
      retryTarget: "impl",
      feedbackContent: buildReviewFeedback(taggedFindings, currentIteration),
      reason: "Review has HIGH_VALUE suggestions — retrying impl",
    };
  }

  if (outcome.verdict === "CHANGES_REQUIRED") {
    const currentFindings = parseReviewFindings(outcome.output);

    // Categorize findings
    const recurring: ReviewIssue[] = [];
    const newIssues: ReviewIssue[] = [];

    for (const finding of currentFindings) {
      const prev = previousIssues.find(p => p.id === finding.id);
      if (prev) {
        recurring.push({ ...prev, lastSeen: currentIteration });
      } else {
        newIssues.push({ ...finding, firstSeen: currentIteration, lastSeen: currentIteration });
      }
    }

    // Check if any recurring issue has exceeded 3 iterations without resolution (hard cap)
    const maxRecurrenceHardCap = 3;
    const exhaustedIssues = recurring.filter(
      r => (currentIteration - r.firstSeen + 1) >= maxRecurrenceHardCap,
    );

    if (exhaustedIssues.length > 0) {
      return {
        action: "fail",
        reason: `Review failed: ${exhaustedIssues.length} issue(s) exceeded max recurrence (${maxRecurrenceHardCap}) without resolution`,
      };
    }

    const allCurrentIssues = [...recurring, ...newIssues];
    const hasNewIssues = newIssues.length > 0;

    return {
      action: "retry",
      retryTarget: "impl",
      feedbackContent: buildReviewFeedback(allCurrentIssues, currentIteration),
      reason: hasNewIssues
        ? `Review found ${newIssues.length} new issue(s) — retrying impl`
        : `Review found ${recurring.length} recurring issue(s) below max recurrence — retrying impl`,
    };
  }

  return {
    action: "fail",
    reason: `Unknown review verdict "${outcome.verdict}" — cannot proceed`,
  };
}
```

- [ ] **Step 8: Update the OLD decideAfterReview tests to match new signature**

The existing tests in the `decideAfterReview` describe block (lines 207-293) use the old 5-arg signature `(outcome, previousIssues, currentIteration, maxRecurrence, enforceSuggestions)`. Update them to the new 5-arg signature `(outcome, previousIssues, currentIteration, suggestionRetryUsed, enforceSuggestions)`:

Replace the existing `decideAfterReview` describe block with:

```typescript
describe("decideAfterReview — legacy behavior preserved", () => {
  function makeIssue(id: string, severity: string, firstSeen: number, lastSeen: number): ReviewIssue {
    return { id, description: `Issue ${id}`, severity, firstSeen, lastSeen };
  }

  const approvedOutcome = {
    stage: "review",
    success: true,
    verdict: "APPROVED",
    output: "**Verdict:** APPROVED",
  };

  it("returns continue for APPROVED", () => {
    const decision = decideAfterReview(approvedOutcome, [], 1, false, true);
    expect(decision.action).toBe("continue");
  });

  it("returns continue for APPROVED_WITH_SUGGESTIONS when enforceSuggestions=false", () => {
    const outcome = {
      stage: "review",
      success: true,
      verdict: "APPROVED_WITH_SUGGESTIONS",
      output: "[R1] SUGGESTION: Consider renaming x\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS",
    };
    const decision = decideAfterReview(outcome, [], 1, false, false);
    expect(decision.action).toBe("continue");
  });

  it("returns retry for CHANGES_REQUIRED with new issues", () => {
    const output = "[R1] MUST_FIX: Error A\n\n**Verdict:** CHANGES_REQUIRED";
    const outcome = { stage: "review", success: true, verdict: "CHANGES_REQUIRED", output };
    const decision = decideAfterReview(outcome, [], 1, false, true);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
  });

  it("returns fail when a recurring CHANGES_REQUIRED issue exceeds hard cap", () => {
    const output = "[R1] MUST_FIX: Error A\n\n**Verdict:** CHANGES_REQUIRED";
    const findings = parseReviewFindings(output);
    const prevIssue = { ...findings[0], firstSeen: 1, lastSeen: 2, id: findings[0].id };
    const decision = decideAfterReview(
      { stage: "review", success: true, verdict: "CHANGES_REQUIRED", output },
      [prevIssue],
      3,
      false,
      true,
    );
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("recurrence");
  });

  it("feedback content includes findings from current review", () => {
    const output = "[R1] MUST_FIX: Missing null guard in loader\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(
      { stage: "review", success: true, verdict: "CHANGES_REQUIRED", output },
      [], 1, false, true,
    );
    expect(decision.feedbackContent).toContain("Missing null guard");
  });

  it("returns fail for unknown review verdict", () => {
    const decision = decideAfterReview(
      { stage: "review", success: true, verdict: "unknown", output: "no verdict" },
      [], 1, false, true,
    );
    expect(decision.action).toBe("fail");
  });
});
```

- [ ] **Step 9: Run all retry tests**

Run: `npx vitest run tests/core/retry.test.ts`
Expected: All PASS.

- [ ] **Step 10: Commit**

```bash
git add src/core/retry.ts tests/core/retry.test.ts
git commit -m "feat(retry): add suggestion sub-classification, per-cycle budget in decideAfterReview"
```

---

### Task 6: Update Pipeline — New Stage Flow (TDD)

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `tests/core/pipeline.test.ts`
- Modify: `tests/core/pipeline-control.test.ts`
- Modify: `tests/core/pipeline-quick.test.ts`

This task changes the verdict-checking block in `processStage` to handle the new flow: review uses per-cycle budget, validate is now a post-review final gate. TDD: write/update failing tests first, then implement.

- [ ] **Step 1: Write failing test — review retries with suggestion budget**

In `tests/core/pipeline.test.ts`, add a new describe block. This test verifies that when review returns `APPROVED_WITH_SUGGESTIONS` with HIGH_VALUE findings and `suggestionRetryUsed=false`, the pipeline retries impl and sets `suggestionRetryUsed=true`.

The test requires a stub runner. Use the existing `createStubRunner` pattern from the test file. The stub runner should:
- Return success for `impl` stage
- Return `APPROVED_WITH_SUGGESTIONS` with `[R1] SUGGESTION(HIGH_VALUE): ...` for `review` stage on first call, then `APPROVED` on second call
- Return `READY_FOR_REVIEW` for `validate` stage
- Return success for `pr` stage

```typescript
describe("review suggestion budget — Spec 5a", () => {
  it("retries impl once on HIGH_VALUE suggestion then proceeds through validate to pr", async () => {
    let reviewCallCount = 0;
    const stubRunner = createStubRunner((options) => {
      if (options.stage === "review") {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return {
            success: true,
            output: "[R1] SUGGESTION(HIGH_VALUE): DRY violation\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS",
            costUsd: 0.5, turns: 10, durationMs: 1000, inputTokens: 0, outputTokens: 0,
          };
        }
        return {
          success: true,
          output: "**Verdict:** APPROVED",
          costUsd: 0.3, turns: 8, durationMs: 800, inputTokens: 0, outputTokens: 0,
        };
      }
      if (options.stage === "validate") {
        return {
          success: true,
          output: "**Verdict:** READY_FOR_REVIEW",
          costUsd: 0.2, turns: 1, durationMs: 500, inputTokens: 0, outputTokens: 0,
        };
      }
      // impl, pr, etc.
      return {
        success: true,
        output: `${options.stage} done`,
        costUsd: 0.1, turns: 5, durationMs: 500, inputTokens: 0, outputTokens: 0,
      };
    });

    // Set up a 2-stage task: impl → review → validate → pr
    // (setup code follows existing patterns in the test file for creating task dirs and states)
    // ... adapt from existing pipeline test setup patterns ...

    const state = readRunState(taskDir);
    expect(state.status).toBe("complete");
    expect(reviewCallCount).toBe(2); // first: APPROVED_WITH_SUGGESTIONS, second: APPROVED
  });

  it("does NOT retry on NITPICK-only suggestions", async () => {
    let reviewCallCount = 0;
    const stubRunner = createStubRunner((options) => {
      if (options.stage === "review") {
        reviewCallCount++;
        return {
          success: true,
          output: "[R1] SUGGESTION(NITPICK): Minor style nit\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS",
          costUsd: 0.3, turns: 8, durationMs: 800, inputTokens: 0, outputTokens: 0,
        };
      }
      if (options.stage === "validate") {
        return {
          success: true,
          output: "**Verdict:** READY_FOR_REVIEW",
          costUsd: 0.2, turns: 1, durationMs: 500, inputTokens: 0, outputTokens: 0,
        };
      }
      return {
        success: true,
        output: `${options.stage} done`,
        costUsd: 0.1, turns: 5, durationMs: 500, inputTokens: 0, outputTokens: 0,
      };
    });

    // ... setup task with impl → review → validate → pr stages ...

    const state = readRunState(taskDir);
    expect(state.status).toBe("complete");
    expect(reviewCallCount).toBe(1); // only called once, no retry
  });
});
```

Note: Adapt the test setup (directory creation, task file writing, pipeline instantiation) from existing tests in the file. The exact setup code depends on the helper patterns already in use.

- [ ] **Step 2: Write failing test — validate failure resets suggestion budget**

Add another test in the same describe block:

```typescript
  it("resets suggestionRetryUsed when validate fails and loops back to impl", async () => {
    let implCallCount = 0;
    let reviewCallCount = 0;
    let validateCallCount = 0;

    const stubRunner = createStubRunner((options) => {
      if (options.stage === "impl") {
        implCallCount++;
        return { success: true, output: "impl done", costUsd: 0.5, turns: 20, durationMs: 2000, inputTokens: 0, outputTokens: 0 };
      }
      if (options.stage === "review") {
        reviewCallCount++;
        // Always approve (no suggestions) to isolate the validate→impl reset
        return { success: true, output: "**Verdict:** APPROVED", costUsd: 0.3, turns: 8, durationMs: 800, inputTokens: 0, outputTokens: 0 };
      }
      if (options.stage === "validate") {
        validateCallCount++;
        if (validateCallCount === 1) {
          return { success: true, output: "Tests failed.\n\n**Verdict:** NEEDS_FIXES", costUsd: 0.2, turns: 1, durationMs: 500, inputTokens: 0, outputTokens: 0 };
        }
        return { success: true, output: "**Verdict:** READY_FOR_REVIEW", costUsd: 0.2, turns: 1, durationMs: 500, inputTokens: 0, outputTokens: 0 };
      }
      return { success: true, output: `${options.stage} done`, costUsd: 0.1, turns: 5, durationMs: 500, inputTokens: 0, outputTokens: 0 };
    });

    // ... setup task with impl → review → validate → pr stages ...

    const state = readRunState(taskDir);
    expect(state.status).toBe("complete");
    expect(implCallCount).toBe(2);     // initial + retry after validate fail
    expect(reviewCallCount).toBe(2);   // once per impl cycle
    expect(validateCallCount).toBe(2); // first fails, second passes
    expect(state.suggestionRetryUsed).toBe(false); // reset after validate failure
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/pipeline.test.ts -t "review suggestion budget"`
Expected: FAIL — pipeline still uses old `decideAfterReview` call signature and old flow.

- [ ] **Step 4: Update existing pipeline tests for new types and stage order**

Before implementing, fix existing tests so they compile with the new types. In all three test files (`pipeline.test.ts`, `pipeline-control.test.ts`, `pipeline-quick.test.ts`):

- Replace all `validateRetryCount` references with `validateFailCount` where constructing RunState
- Add `suggestionRetryUsed: false, validateFailCount: 0` to any RunState object literals
- Update stage order references from `impl, validate, review, pr` to `impl, review, validate, pr`
- Replace `maxReviewRecurrence` with `maxSuggestionRetriesPerCycle` in any config objects
- Remove `maxConcurrentValidate` from any config objects
- Update `createAgentRegistry` calls to single-arg form

- [ ] **Step 5: Implement — Update createRunState**

In `src/core/pipeline.ts`, find the `createRunState` function. Add the new fields to the returned object:

```typescript
    suggestionRetryUsed: false,
    validateFailCount: 0,
```

- [ ] **Step 6: Implement — Replace verdict-checking block in processStage**

In `src/core/pipeline.ts`, find the block starting at line 482 (`if (stage === "validate" || stage === "review")`). Replace the entire verdict-checking block (lines 482-561) with:

```typescript
      if (stage === "review" || stage === "validate") {
        const verdict = parseAgentVerdict(result.output, stage);
        const outcome = { stage, success: true, verdict, output: result.output };

        let decision;
        if (stage === "review") {
          decision = decideAfterReview(
            outcome,
            state.reviewIssues,
            state.reviewRetryCount + 1,
            state.suggestionRetryUsed,
            config.review.enforceSuggestions,
          );
        } else {
          // validate is now the post-review final gate
          decision = decideAfterValidate(
            outcome,
            state.validateFailCount,
            config.agents.maxValidateRetries,
          );
        }

        logger.info(
          `[pipeline] ${stage} verdict="${verdict}" for "${slug}" → action="${decision.action}" reason="${decision.reason}"`,
        );

        if (decision.action === "fail") {
          state.status = "failed";
          state.error = decision.reason;
          writeRunState(currentTaskDir, state);
          recordCompletionIfWorktree(state);
          moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            "11-failed",
          );
          activeRuns.delete(slug);
          return;
        }

        if (decision.action === "retry") {
          // Write feedback artifact for impl to read
          const retryCount = stage === "validate"
            ? state.validateFailCount + 1
            : state.reviewRetryCount + 1;
          const feedbackFile = `retry-feedback-${stage}-${retryCount}.md`;

          if (decision.feedbackContent) {
            writeFileSync(
              join(currentTaskDir, "artifacts", feedbackFile),
              decision.feedbackContent,
              "utf-8",
            );
          }

          // Update retry counters and issue tracking
          if (stage === "validate") {
            state.validateFailCount += 1;
            // Reset suggestion budget for new impl cycle
            state.suggestionRetryUsed = false;
          } else {
            state.reviewRetryCount += 1;
            // Track whether this was a suggestion retry
            if (outcome.verdict === "APPROVED_WITH_SUGGESTIONS") {
              state.suggestionRetryUsed = true;
            }
            // Merge current findings into reviewIssues
            const currentFindings = parseReviewFindings(result.output);
            state.reviewIssues = mergeReviewIssues(
              state.reviewIssues,
              currentFindings,
              state.reviewRetryCount,
            );
          }

          // Move back to impl/pending
          state.currentStage = "impl";
          state.status = "running";
          writeRunState(currentTaskDir, state);
          currentTaskDir = moveTaskDir(
            runtimeDir, slug,
            join(STAGE_DIR_MAP[stage], "pending"),
            join(STAGE_DIR_MAP["impl"], "pending"),
          );
          // Continue the while loop — will re-run impl
          continue;
        }

        // decision.action === "continue" — fall through to normal stage completion
      }
```

- [ ] **Step 7: Run all pipeline tests**

Run: `npx vitest run tests/core/pipeline.test.ts tests/core/pipeline-control.test.ts tests/core/pipeline-quick.test.ts`
Expected: All PASS, including the new Spec 5a tests from Steps 1-2.

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (aside from known pre-existing failures).

- [ ] **Step 9: Commit**

```bash
git add src/core/pipeline.ts tests/core/pipeline.test.ts tests/core/pipeline-control.test.ts tests/core/pipeline-quick.test.ts
git commit -m "feat(pipeline): review before validate, per-cycle suggestion budget, cycle reset on validate failure"
```

---

### Task 7: Update Agent Prompts — Review Classification + Impl Direct Mode

**Files:**
- Modify: `agents/review.md`
- Modify: `agents/impl.md`

- [ ] **Step 1: Update agents/review.md — add suggestion sub-classification**

Replace the SUGGESTION line in the severity definitions (around line 44) and add sub-class guidance. The findings format section should become:

```markdown
Where SEVERITY is one of:
- `MUST_FIX` — blocks merge (incorrect behavior, test failures hidden, security issue, type `any` in core path)
- `SHOULD_FIX` — important quality issue but not blocking (missing error handling, unclear naming, weak test coverage)
- `SUGGESTION(HIGH_VALUE)` — meaningful improvement worth fixing (naming inconsistencies within the same file, dead code, DRY violations, missing error handling on real paths, type safety gaps on public APIs)
- `SUGGESTION(NITPICK)` — cosmetic or speculative (defensive guards for impossible inputs, style preferences, feature requests not in spec, test pattern preferences, display formatting)
- `SUGGESTION` — use ONLY if you cannot confidently classify as HIGH_VALUE or NITPICK; the pipeline treats unclassified SUGGESTION as HIGH_VALUE

**Classification guidance:**
- If fixing it would prevent a real bug, confusion, or maintenance issue → HIGH_VALUE
- If it's "nice to have" or "while we're here" → NITPICK
- Feature requests (e.g. "add a --sort option") are always NITPICK
- Edge case guards for inputs the caller controls are NITPICK
```

Also add examples to the example findings section:

```markdown
[R3] SUGGESTION(HIGH_VALUE): `_usage` naming inconsistent with `usage` on lines 259, 270 — rename for consistency
  File: src/core/agent-runner.ts:235

[R4] SUGGESTION(NITPICK): `formatDuration` could guard against negative input — caller always passes positive values
  File: src/commands/stats.ts:189
```

Update the verdict section:

```markdown
Use:
- `APPROVED` — no MUST_FIX, SHOULD_FIX, or HIGH_VALUE findings
- `APPROVED_WITH_SUGGESTIONS` — has SUGGESTION(HIGH_VALUE) or unclassified SUGGESTION findings, but no MUST_FIX/SHOULD_FIX
- `CHANGES_REQUIRED` — any MUST_FIX or SHOULD_FIX findings present

Note: If ALL suggestions are SUGGESTION(NITPICK), use `APPROVED` (not APPROVED_WITH_SUGGESTIONS).
```

Add non-coding task guidance at the end, before the verdict section:

```markdown
---

## Non-Coding Task Review

When the stage sequence does NOT include `validate` (documentation, config, non-code tasks):
- Do NOT flag missing test coverage as MUST_FIX or SHOULD_FIX
- Focus review on: content accuracy, completeness, formatting, links, spelling
- SUGGESTION criteria shift: structural improvements to docs, missing sections, unclear instructions are HIGH_VALUE; formatting nits are NITPICK
```

- [ ] **Step 2: Update agents/impl.md — add direct mode for non-coding tasks**

Replace the current Step 2 (lines 42-72) with:

```markdown
## Step 2 — Implement Each Slice

Determine your implementation mode by checking the stage sequence in the Pipeline Context above.

### TDD mode (strict) — when `validate` IS in the stage sequence:

For each slice in the plan, in order:

1. **Write the failing test first**
   - Follow the project's existing test file naming and placement conventions
   - Test the behavior described by the slice, not the implementation
   - Run the test: confirm it fails for the right reason (not a syntax error or import failure)

2. **Write the minimum code to make the test pass**
   - Export only what the plan specifies
   - Do not add dependencies not already in the project's package manifest

3. **Run the test: confirm it passes**

4. **Refactor if needed** — keep tests green throughout

5. **Commit the slice**
   ```bash
   git add <files>
   git commit -m "feat(<scope>): <what this slice does>"
   ```

### Direct mode — when `validate` is NOT in the stage sequence (documentation, config, non-code tasks):

For each slice in the plan, in order:

1. **Write the deliverable** (docs, config, README, etc.)
2. **If the deliverable has a verifiable format** (JSON, YAML, TOML), validate it parses correctly
3. **Do NOT write test files** for documentation or config content
4. **Commit the slice**
   ```bash
   git add <files>
   git commit -m "docs(<scope>): <what>" # or chore(<scope>): <what>
   ```

### Without test framework (code task but no test runner detected):

1. Write the code for the slice
2. Ensure it compiles/builds
3. Commit the slice with a note: `feat(<scope>): <what> [no tests — no framework]`
```

- [ ] **Step 3: Commit**

```bash
git add agents/review.md agents/impl.md
git commit -m "feat(agents): add suggestion sub-classification to review, direct mode to impl for non-coding tasks"
```

---

### Task 8: Build and Full Test Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (aside from known pre-existing failures).

- [ ] **Step 3: Verify stage ordering is consistent**

Run a quick sanity check:

```bash
grep -n "defaultStages" src/config/defaults.ts
grep -n "PIPELINE_STAGES" src/core/stage-map.ts
```

Expected: Both show `impl, review, validate, pr` (review before validate).

- [ ] **Step 4: Verify no references to removed config fields**

```bash
grep -rn "maxConcurrentValidate" src/ tests/
grep -rn "maxReviewRecurrence" src/ tests/
```

Expected: No matches (all references replaced).

- [ ] **Step 5: Commit any final fixes**

If any issues found in steps 1-4, fix and commit.

```bash
git add -A
git commit -m "fix: resolve build/test issues from spec 5a changes"
```

---

### Task 9: Migrate Existing Runtime Directories (Optional — Manual Step)

This task is informational. Existing runtime directories on disk use the old numbering (07-validate, 08-review). After deploying the new code:

- [ ] **Step 1: Document the migration**

The directory rename from `07-validate`→`07-review` and `08-review`→`08-validate` only affects new tasks. Existing completed/failed tasks in `10-complete/` and `11-failed/` are self-contained (their stage order is in `run-state.json`) and don't need migration.

For any tasks currently in-progress in `07-validate/` or `08-review/`, they will need manual intervention:
1. Move task from `08-review/` → `07-review/`
2. Move task from `07-validate/` → `08-validate/`

This is a one-time operation at deploy time. No code change needed.
