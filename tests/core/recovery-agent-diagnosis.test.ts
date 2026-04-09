import { describe, it, expect } from "vitest";
import { parseRecoveryDiagnosis, sanitizeDiagnosisForGithub } from "../../src/core/recovery-agent.js";

describe("parseRecoveryDiagnosis", () => {
  it("parses valid fixable diagnosis", () => {
    const raw = JSON.stringify({
      classification: "fixable",
      diagnosis: "Tool permission missing: review stage needs Bash",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Add Bash to review stage allowed tools",
      reEntryStage: "review",
      confidence: 0.9,
    });
    const result = parseRecoveryDiagnosis(raw);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("fixable");
    expect(result!.reEntryStage).toBe("review");
  });

  it("parses valid terminal diagnosis", () => {
    const raw = JSON.stringify({
      classification: "terminal",
      diagnosis: "Task requires access to a private API that is down",
      affectedFiles: [],
      suggestedFix: "",
      reEntryStage: null,
      confidence: 0.85,
    });
    const result = parseRecoveryDiagnosis(raw);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("terminal");
  });

  it("returns null for invalid JSON", () => {
    expect(parseRecoveryDiagnosis("not json")).toBeNull();
  });

  it("returns null for missing classification", () => {
    const raw = JSON.stringify({ diagnosis: "something" });
    expect(parseRecoveryDiagnosis(raw)).toBeNull();
  });
});

describe("sanitizeDiagnosisForGithub", () => {
  it("includes pipeline internals", () => {
    const text = sanitizeDiagnosisForGithub({
      classification: "fixable",
      diagnosis: "Review stage timeout too short",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Increase review timeout to 45 minutes",
      reEntryStage: "review",
      confidence: 0.9,
    }, "review", "Agent timed out after 30 minutes", 2, 1);
    expect(text).toContain("review");
    expect(text).toContain("defaults.ts");
    expect(text).toContain("timeout");
  });

  it("never includes task slug in output", () => {
    const text = sanitizeDiagnosisForGithub({
      classification: "fixable",
      diagnosis: "Tool permission missing",
      affectedFiles: ["src/config/defaults.ts"],
      suggestedFix: "Add Bash",
      reEntryStage: "review",
      confidence: 0.9,
    }, "review", "Agent failed", 0, 0);
    expect(text).not.toContain("my-secret-project");
  });
});
