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
  // Extract first sentence (up to first period, exclamation, question mark or end)
  const firstSentence = description.split(/[.!?]/)[0] ?? description;
  const normalized = `${severity}|${firstSentence}`
    .toLowerCase()
    .replace(/[\s\W]+/g, "");

  // Simple djb2 hash — good enough for issue identity
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
    hash = hash >>> 0; // keep as unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── parseAgentVerdict ───────────────────────────────────────────────────────

const VALIDATE_VERDICTS = ["READY_FOR_REVIEW", "NEEDS_FIXES"] as const;
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
  const pattern = /\[R\d+\]\s+(MUST_FIX|SHOULD_FIX|SUGGESTION):\s*(.+)/g;
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
