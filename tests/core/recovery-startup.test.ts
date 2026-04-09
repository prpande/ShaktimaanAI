import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanUnanalyzedFailures, scanHeldTasksWithIssues } from "../../src/core/recovery.js";

describe("scanUnanalyzedFailures", () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = join(tmpdir(), `shkmn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(runtimeDir, "11-failed"), { recursive: true });
  });

  it("returns tasks with no recovery fields", () => {
    const slug = "test-task-001";
    const taskDir = join(runtimeDir, "11-failed", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "impl",
      status: "failed",
      error: "Agent crashed",
    }));

    const results = scanUnanalyzedFailures(runtimeDir);
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe(slug);
    expect(results[0].stage).toBe("impl");
    expect(results[0].error).toBe("Agent crashed");
  });

  it("skips tasks with terminalFailure", () => {
    const slug = "terminal-task";
    const taskDir = join(runtimeDir, "11-failed", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "impl",
      status: "failed",
      error: "Cannot proceed",
      terminalFailure: true,
    }));

    const results = scanUnanalyzedFailures(runtimeDir);
    expect(results).toHaveLength(0);
  });

  it("skips tasks with recoveryDiagnosis", () => {
    const slug = "diagnosed-task";
    const taskDir = join(runtimeDir, "11-failed", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "review",
      status: "failed",
      error: "Review failed",
      recoveryDiagnosis: "Missing permissions",
    }));

    const results = scanUnanalyzedFailures(runtimeDir);
    expect(results).toHaveLength(0);
  });

  it("skips tasks with recoveryIssueUrl", () => {
    const slug = "issued-task";
    const taskDir = join(runtimeDir, "11-failed", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "validate",
      status: "failed",
      error: "Validate failed",
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/99",
    }));

    const results = scanUnanalyzedFailures(runtimeDir);
    expect(results).toHaveLength(0);
  });

  it("returns empty array when 11-failed does not exist", () => {
    const emptyDir = join(tmpdir(), `shkmn-empty-${Date.now()}`);
    const results = scanUnanalyzedFailures(emptyDir);
    expect(results).toHaveLength(0);
  });
});

describe("scanHeldTasksWithIssues", () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = join(tmpdir(), `shkmn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(runtimeDir, "12-hold"), { recursive: true });
  });

  it("returns tasks with awaiting_fix and issue number", () => {
    const slug = "held-task-001";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "impl",
      status: "hold",
      holdReason: "awaiting_fix",
      recoveryIssueNumber: 42,
      recoveryIssueUrl: "https://github.com/prpande/ShaktimaanAI/issues/42",
      recoveryReEntryStage: "review",
    }));

    const results = scanHeldTasksWithIssues(runtimeDir);
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe(slug);
    expect(results[0].issueNumber).toBe(42);
    expect(results[0].issueUrl).toBe("https://github.com/prpande/ShaktimaanAI/issues/42");
    expect(results[0].reEntryStage).toBe("review");
  });

  it("skips tasks with different holdReason", () => {
    const slug = "paused-task";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "design",
      status: "hold",
      holdReason: "approval_required",
    }));

    const results = scanHeldTasksWithIssues(runtimeDir);
    expect(results).toHaveLength(0);
  });

  it("skips tasks without recoveryIssueNumber", () => {
    const slug = "no-issue-task";
    const taskDir = join(runtimeDir, "12-hold", slug);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "run-state.json"), JSON.stringify({
      slug,
      currentStage: "impl",
      status: "hold",
      holdReason: "awaiting_fix",
    }));

    const results = scanHeldTasksWithIssues(runtimeDir);
    expect(results).toHaveLength(0);
  });

  it("returns empty array when 12-hold does not exist", () => {
    const emptyDir = join(tmpdir(), `shkmn-empty-${Date.now()}`);
    const results = scanHeldTasksWithIssues(emptyDir);
    expect(results).toHaveLength(0);
  });
});
