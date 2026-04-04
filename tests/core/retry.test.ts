import { describe, it, expect } from "vitest";
import {
  parseAgentVerdict,
  parseReviewFindings,
  issueHash,
} from "../../src/core/retry.js";

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
