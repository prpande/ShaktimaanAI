import { createHash } from "node:crypto";
import type { ReviewIssue } from "./types.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface StageOutcome {
  stage: string;
  success: boolean;
  verdict: string;
  output: string;
}

export interface RetryDecision {
  action: "continue" | "retry" | "fail";
  retryTarget?: string;
  feedbackContent?: string;
  reason: string;
}

// ─── issueHash ───────────────────────────────────────────────────────────────

/**
 * Produces a stable hash from a severity string and the first sentence of a
 * description. Case-insensitive and whitespace-insensitive.
 * Used to track the "same" issue across review iterations.
 */
export function issueHash(severity: string, description: string): string {
  const firstSentence = description.split(/[.!?]/)[0] ?? description;
  const normalized = `${severity}|${firstSentence}`
    .toLowerCase()
    .replace(/[\s\W]+/g, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ─── parseAgentVerdict ───────────────────────────────────────────────────────

const VALIDATE_VERDICTS = ["PASS", "NEEDS_FIXES"] as const;
const REVIEW_VERDICTS = ["APPROVED_WITH_SUGGESTIONS", "APPROVED", "CHANGES_REQUIRED"] as const;

/**
 * Extracts the verdict from agent output.
 * Looks for the pattern: **Verdict:** VERDICT_TEXT (case-insensitive).
 * Returns the matched verdict in uppercase or "unknown".
 */
export function parseAgentVerdict(output: string, stage: string): string {
  // Match **Verdict:** followed by the verdict text (case-insensitive label)
  const match = output.match(/\*\*verdict:\*\*\s*([A-Z_]+)/i);
  if (!match) return "unknown";

  const raw = match[1].toUpperCase();

  if (stage === "validate") {
    const found = VALIDATE_VERDICTS.find(v => v === raw);
    return found ?? "unknown";
  }

  if (stage === "review") {
    const found = REVIEW_VERDICTS.find(v => v === raw);
    return found ?? "unknown";
  }

  return "unknown";
}

// ─── parseReviewFindings ─────────────────────────────────────────────────────

/**
 * Parses review output for findings in the format:
 *   [R{n}] SEVERITY: description
 *
 * Returns an array of ReviewIssue with ids, descriptions, and severities.
 * firstSeen and lastSeen are set to 0 here — callers set the iteration values.
 */
export function parseReviewFindings(output: string): ReviewIssue[] {
  // Match lines like: [R1] MUST_FIX: Some description here — with trailing context
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

// ─── decideAfterValidate ─────────────────────────────────────────────────────

/**
 * Decides what to do after the validate stage completes.
 *
 * - PASS → continue
 * - NEEDS_FIXES, retryCount < maxRetries → retry impl with feedback
 * - NEEDS_FIXES, retryCount >= maxRetries → fail
 * - unknown verdict → fail (agent did not produce parseable output)
 */
export function decideAfterValidate(
  outcome: StageOutcome,
  retryCount: number,
  maxRetries: number,
): RetryDecision {
  if (outcome.verdict === "PASS") {
    return { action: "continue", reason: "Validation passed" };
  }

  if (outcome.verdict === "NEEDS_FIXES") {
    if (retryCount < maxRetries) {
      return {
        action: "retry",
        retryTarget: "impl",
        feedbackContent: buildValidateFeedback(outcome.output, retryCount + 1),
        reason: `Validation failed — retry ${retryCount + 1}/${maxRetries}`,
      };
    }
    return {
      action: "fail",
      reason: `Validation failed and max retries (${maxRetries}) exhausted`,
    };
  }

  return {
    action: "fail",
    reason: `Unknown validate verdict "${outcome.verdict}" — cannot proceed`,
  };
}

function buildValidateFeedback(output: string, attempt: number): string {
  return [
    `# Validate Feedback — Retry Attempt ${attempt}`,
    "",
    "The validation stage reported failures. Address ALL of the following before re-submitting.",
    "",
    "## Failure Output",
    "",
    output.trim(),
  ].join("\n");
}

// ─── decideAfterReview ────────────────────────────────────────────────────────

/**
 * Decides what to do after the review stage completes.
 * Spec 5a: uses per-cycle suggestion budget instead of maxRecurrence.
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

    const currentFindings = parseReviewFindings(outcome.output);
    const hasHighValue = currentFindings.some(
      f => f.severity === "SUGGESTION(HIGH_VALUE)" || f.severity === "SUGGESTION",
    );

    if (!hasHighValue) {
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

function buildReviewFeedback(issues: ReviewIssue[], iteration: number): string {
  const lines = [
    `# Review Feedback — Iteration ${iteration}`,
    "",
    "The review stage identified the following issues. Address ALL MUST_FIX items. Address SHOULD_FIX items unless there is a clear justification.",
    "",
    "## Findings",
    "",
  ];

  for (const issue of issues) {
    const recurrence = issue.firstSeen < iteration
      ? ` *(recurring since iteration ${issue.firstSeen})*`
      : "";
    lines.push(`- **${issue.severity}**${recurrence}: ${issue.description}`);
  }

  return lines.join("\n");
}
