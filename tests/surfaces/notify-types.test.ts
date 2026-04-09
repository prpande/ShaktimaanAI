import { describe, it, expect } from "vitest";
import type { NotifyEvent } from "../../src/surfaces/types.js";
import { shouldNotify } from "../../src/surfaces/types.js";

describe("NotifyEvent enriched fields", () => {
  it("stage_started accepts agentName", () => {
    const event: NotifyEvent = {
      type: "stage_started",
      slug: "test-task",
      stage: "design",
      agentName: "Vishwakarma",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(event.agentName).toBe("Vishwakarma");
  });

  it("stage_completed accepts metric fields", () => {
    const event: NotifyEvent = {
      type: "stage_completed",
      slug: "test-task",
      stage: "impl",
      artifactPath: "impl-output.md",
      durationSeconds: 274,
      costUsd: 0.88,
      model: "opus",
      inputTokens: 410,
      outputTokens: 7353,
      turns: 27,
      verdict: "APPROVED",
      agentName: "Karigar",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(event.durationSeconds).toBe(274);
    expect(event.costUsd).toBe(0.88);
    expect(event.model).toBe("opus");
    expect(event.inputTokens).toBe(410);
    expect(event.outputTokens).toBe(7353);
    expect(event.turns).toBe(27);
    expect(event.verdict).toBe("APPROVED");
    expect(event.agentName).toBe("Karigar");
  });

  it("task_held accepts hold context and metrics", () => {
    const event: NotifyEvent = {
      type: "task_held",
      slug: "test-task",
      stage: "impl",
      artifactUrl: "",
      holdReason: "budget_exhausted",
      holdDetail: "opus task limit at 209%",
      durationSeconds: 120,
      costUsd: 0.55,
      model: "opus",
      inputTokens: 300,
      outputTokens: 5000,
      turns: 10,
      agentName: "Karigar",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(event.holdReason).toBe("budget_exhausted");
    expect(event.holdDetail).toBe("opus task limit at 209%");
  });

  it("task_failed accepts metrics", () => {
    const event: NotifyEvent = {
      type: "task_failed",
      slug: "test-task",
      stage: "validate",
      error: "Unknown verdict",
      durationSeconds: 207,
      costUsd: 0.12,
      model: "haiku",
      inputTokens: 200,
      outputTokens: 1800,
      turns: 8,
      agentName: "Dharma",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(event.durationSeconds).toBe(207);
    expect(event.agentName).toBe("Dharma");
  });

  it("task_completed accepts completedStages summary and agentNames", () => {
    const event: NotifyEvent = {
      type: "task_completed",
      slug: "test-task",
      completedStages: [
        { stage: "questions", completedAt: "2026-01-01T00:05:00Z", costUsd: 0.38, turns: 5, inputTokens: 500, outputTokens: 4064, model: "sonnet" },
        { stage: "impl", completedAt: "2026-01-01T00:15:00Z", costUsd: 3.74, turns: 40, inputTokens: 2000, outputTokens: 39194, model: "opus" },
      ],
      startedAt: "2026-01-01T00:00:00Z",
      agentNames: { questions: "Gargi", impl: "Karigar" },
      timestamp: "2026-01-01T00:20:00Z",
    };
    expect(event.completedStages).toHaveLength(2);
    expect(event.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(event.agentNames?.questions).toBe("Gargi");
  });
});

describe("shouldNotify", () => {
  it("stages level returns true for task_created", () => {
    const event: NotifyEvent = {
      type: "task_created",
      slug: "test-task",
      title: "Test Task",
      source: "inbox",
      stages: ["questions", "impl"],
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("stages level returns true for stage_started", () => {
    const event: NotifyEvent = {
      type: "stage_started",
      slug: "test-task",
      stage: "design",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("stages level returns true for recovery_diagnosed", () => {
    const event: NotifyEvent = {
      type: "recovery_diagnosed",
      slug: "test-task",
      stage: "impl",
      classification: "fixable",
      diagnosis: "Missing dependency",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("stages", event)).toBe(true);
  });

  it("minimal level returns false for stage_started", () => {
    const event: NotifyEvent = {
      type: "stage_started",
      slug: "test-task",
      stage: "design",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("minimal", event)).toBe(false);
  });

  it("bookends level returns true for task_created", () => {
    const event: NotifyEvent = {
      type: "task_created",
      slug: "test-task",
      title: "Test Task",
      source: "inbox",
      stages: ["questions", "impl"],
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("bookends", event)).toBe(true);
  });

  it("bookends level returns false for stage_started", () => {
    const event: NotifyEvent = {
      type: "stage_started",
      slug: "test-task",
      stage: "design",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("bookends", event)).toBe(false);
  });

  it("minimal level returns true for task_failed", () => {
    const event: NotifyEvent = {
      type: "task_failed",
      slug: "test-task",
      stage: "impl",
      error: "Build failed",
      timestamp: "2026-01-01T00:00:00Z",
    };
    expect(shouldNotify("minimal", event)).toBe(true);
  });
});
