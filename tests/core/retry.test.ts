import { describe, it, expect } from "vitest";
import {
  parseAgentVerdict,
  parseReviewFindings,
  issueHash,
  decideAfterValidate,
  decideAfterReview,
} from "../../src/core/retry.js";
import type { ReviewIssue } from "../../src/core/types.js";

// ─── parseAgentVerdict ───────────────────────────────────────────────────────

describe("parseAgentVerdict", () => {
  describe("validate stage verdicts", () => {
    it("detects READY_FOR_REVIEW in bold markdown format", () => {
      const output = `
## Validation Report
Build: PASS
Tests: PASS

**Verdict:** READY_FOR_REVIEW
      `;
      expect(parseAgentVerdict(output, "validate")).toBe("READY_FOR_REVIEW");
    });

    it("detects NEEDS_FIXES in bold markdown format", () => {
      const output = `
Build failed at src/core/pipeline.ts line 42.

**Verdict:** NEEDS_FIXES
      `;
      expect(parseAgentVerdict(output, "validate")).toBe("NEEDS_FIXES");
    });

    it("detects READY_FOR_REVIEW case-insensitively", () => {
      const output = "**verdict:** ready_for_review";
      expect(parseAgentVerdict(output, "validate")).toBe("READY_FOR_REVIEW");
    });

    it("returns unknown when no verdict present", () => {
      expect(parseAgentVerdict("Some output with no verdict", "validate")).toBe("unknown");
    });
  });

  describe("review stage verdicts", () => {
    it("detects APPROVED", () => {
      const output = "All checks pass.\n\n**Verdict:** APPROVED";
      expect(parseAgentVerdict(output, "review")).toBe("APPROVED");
    });

    it("detects APPROVED_WITH_SUGGESTIONS", () => {
      const output = "Minor notes.\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS";
      expect(parseAgentVerdict(output, "review")).toBe("APPROVED_WITH_SUGGESTIONS");
    });

    it("detects CHANGES_REQUIRED", () => {
      const output = "Critical issues found.\n\n**Verdict:** CHANGES_REQUIRED";
      expect(parseAgentVerdict(output, "review")).toBe("CHANGES_REQUIRED");
    });

    it("returns unknown for unrecognized review verdicts", () => {
      expect(parseAgentVerdict("No verdict here", "review")).toBe("unknown");
    });
  });

  describe("other stages", () => {
    it("returns unknown for stages that don't have verdicts", () => {
      expect(parseAgentVerdict("Some output", "impl")).toBe("unknown");
      expect(parseAgentVerdict("Some output", "questions")).toBe("unknown");
    });
  });
});

// ─── parseReviewFindings ─────────────────────────────────────────────────────

describe("parseReviewFindings", () => {
  it("parses a single MUST_FIX finding", () => {
    const output = `
[R1] MUST_FIX: Missing null check in parseConfig — config.agents could be undefined
  File: src/config/loader.ts:45
    `;
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("MUST_FIX");
    expect(findings[0].description).toContain("Missing null check");
    expect(findings[0].id).toBeTruthy();
  });

  it("parses multiple findings of mixed severity", () => {
    const output = `
[R1] MUST_FIX: No error handling in fetchData — will crash on network failure
[R2] SHOULD_FIX: Variable name 'x' is not descriptive enough
[R3] SUGGESTION: Consider extracting this logic into a helper function
    `;
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("MUST_FIX");
    expect(findings[1].severity).toBe("SHOULD_FIX");
    expect(findings[2].severity).toBe("SUGGESTION");
  });

  it("returns empty array when no findings present", () => {
    const output = "**Verdict:** APPROVED\n\nAll looks good!";
    expect(parseReviewFindings(output)).toEqual([]);
  });

  it("each finding has a unique id based on severity + first sentence", () => {
    const output = `
[R1] MUST_FIX: Error A — details here
[R2] MUST_FIX: Error B — different issue
    `;
    const findings = parseReviewFindings(output);
    expect(findings[0].id).not.toBe(findings[1].id);
  });

  it("same issue generates same id across different outputs", () => {
    const output1 = "[R1] MUST_FIX: Missing null check in parseConfig\n";
    const output2 = "[R3] MUST_FIX: Missing null check in parseConfig\n";
    const f1 = parseReviewFindings(output1);
    const f2 = parseReviewFindings(output2);
    expect(f1[0].id).toBe(f2[0].id);
  });

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
});

// ─── issueHash ───────────────────────────────────────────────────────────────

describe("issueHash", () => {
  it("returns a non-empty string", () => {
    expect(issueHash("MUST_FIX", "Missing null check")).toBeTruthy();
  });

  it("returns the same hash for the same input", () => {
    expect(issueHash("MUST_FIX", "Missing null check")).toBe(
      issueHash("MUST_FIX", "Missing null check"),
    );
  });

  it("returns different hashes for different inputs", () => {
    expect(issueHash("MUST_FIX", "Error A")).not.toBe(
      issueHash("MUST_FIX", "Error B"),
    );
    expect(issueHash("MUST_FIX", "Same error")).not.toBe(
      issueHash("SHOULD_FIX", "Same error"),
    );
  });

  it("is case and whitespace insensitive", () => {
    expect(issueHash("MUST_FIX", "  Missing null check  ")).toBe(
      issueHash("must_fix", "missing null check"),
    );
  });
});

// ─── decideAfterValidate ─────────────────────────────────────────────────────

describe("decideAfterValidate", () => {
  const outcomeReady = {
    stage: "validate",
    success: true,
    verdict: "READY_FOR_REVIEW",
    output: "All tests pass.\n\n**Verdict:** READY_FOR_REVIEW",
  };

  const outcomeNeedsFixes = (output = "Build failed.\n\n**Verdict:** NEEDS_FIXES") => ({
    stage: "validate",
    success: true,
    verdict: "NEEDS_FIXES",
    output,
  });

  it("returns continue when READY_FOR_REVIEW", () => {
    const decision = decideAfterValidate(outcomeReady, 0, 2);
    expect(decision.action).toBe("continue");
  });

  it("returns retry when NEEDS_FIXES and retryCount < maxRetries", () => {
    const decision = decideAfterValidate(outcomeNeedsFixes(), 0, 2);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
    expect(decision.feedbackContent).toBeTruthy();
  });

  it("retry feedback contains the failure output", () => {
    const output = "TypeScript error: TS2322 at src/core/pipeline.ts:42\n\n**Verdict:** NEEDS_FIXES";
    const decision = decideAfterValidate(outcomeNeedsFixes(output), 1, 2);
    expect(decision.feedbackContent).toContain("TS2322");
  });

  it("returns fail when NEEDS_FIXES and retryCount >= maxRetries", () => {
    const decision = decideAfterValidate(outcomeNeedsFixes(), 2, 2);
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("max");
  });

  it("returns fail for unknown verdict", () => {
    const decision = decideAfterValidate(
      { stage: "validate", success: true, verdict: "unknown", output: "no verdict" },
      0,
      2,
    );
    expect(decision.action).toBe("fail");
  });
});

// ─── decideAfterReview ───────────────────────────────────────────────────────

describe("decideAfterReview", () => {
  function makeIssue(id: string, severity: string, firstSeen: number, lastSeen: number): ReviewIssue {
    return { id, description: `Issue ${id}`, severity, firstSeen, lastSeen };
  }

  const approvedOutcome = {
    stage: "review",
    success: true,
    verdict: "APPROVED",
    output: "**Verdict:** APPROVED",
  };

  const suggestionsOutcome = {
    stage: "review",
    success: true,
    verdict: "APPROVED_WITH_SUGGESTIONS",
    output: "[R1] SUGGESTION: Consider renaming x to something descriptive\n\n**Verdict:** APPROVED_WITH_SUGGESTIONS",
  };

  const changesOutcome = (output: string) => ({
    stage: "review",
    success: true,
    verdict: "CHANGES_REQUIRED",
    output,
  });

  it("returns continue for APPROVED", () => {
    const decision = decideAfterReview(approvedOutcome, [], 1, false, true);
    expect(decision.action).toBe("continue");
  });

  it("returns continue for APPROVED_WITH_SUGGESTIONS when enforceSuggestions=false", () => {
    const decision = decideAfterReview(suggestionsOutcome, [], 1, false, false);
    expect(decision.action).toBe("continue");
  });

  it("returns retry for APPROVED_WITH_SUGGESTIONS when enforceSuggestions=true", () => {
    const decision = decideAfterReview(suggestionsOutcome, [], 1, false, true);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
  });

  it("returns retry for CHANGES_REQUIRED with new issues (no previous)", () => {
    const output = "[R1] MUST_FIX: Error A\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 1, false, true);
    expect(decision.action).toBe("retry");
    expect(decision.retryTarget).toBe("impl");
  });

  it("returns retry for CHANGES_REQUIRED with only new issues even on iteration 3", () => {
    const output = "[R1] MUST_FIX: Brand new issue\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 3, false, true);
    // New issues always get a retry
    expect(decision.action).toBe("retry");
  });

  it("returns fail when a recurring issue has been seen >= maxRecurrence times", () => {
    // Issue has appeared twice before (firstSeen=1, lastSeen=2) and appears again in iteration 3
    const existingIssue = makeIssue("aabbccdd", "MUST_FIX", 1, 2);
    // Build output where the same issue (same hash) appears
    const sameDescription = `Issue aabbccdd`;
    // We'll use a known-hash approach: make an issue whose id matches
    const output = `[R1] MUST_FIX: ${sameDescription}\n\n**Verdict:** CHANGES_REQUIRED`;
    const findings = parseReviewFindings(output);
    // Simulate that the finding matches a previous issue
    const prevIssue = { ...existingIssue, id: findings[0].id };
    const decision = decideAfterReview(changesOutcome(output), [prevIssue], 3, false, true);
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("recurrence");
  });

  it("feedback content includes findings from current review", () => {
    const output = "[R1] MUST_FIX: Missing null guard in loader\n\n**Verdict:** CHANGES_REQUIRED";
    const decision = decideAfterReview(changesOutcome(output), [], 1, false, true);
    expect(decision.feedbackContent).toContain("Missing null guard");
  });

  it("returns fail for unknown review verdict", () => {
    const decision = decideAfterReview(
      { stage: "review", success: true, verdict: "unknown", output: "no verdict" },
      [],
      1,
      false,
      true,
    );
    expect(decision.action).toBe("fail");
  });
});

// ─── decideAfterReview — per-cycle suggestion budget ─────────────────────────

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
