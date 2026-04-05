import { describe, it, expect } from "vitest";
import {
  classifyByKeywords,
  classifyByLLM,
  classifyIntent,
} from "../../src/core/intent-classifier.js";
import type { AgentRunOptions, AgentRunResult } from "../../src/core/types.js";

// ─── stubs ───────────────────────────────────────────────────────────────────

const stubRunner = async (_opts: AgentRunOptions): Promise<AgentRunResult> => ({
  success: true,
  output: JSON.stringify({ intent: "create_task", confidence: 0.85, extractedSlug: null, extractedContent: "test" }),
  costUsd: 0.001,
  turns: 1,
  durationMs: 50,
});

const failRunner = async (): Promise<AgentRunResult> => ({
  success: false,
  output: "",
  costUsd: 0,
  turns: 0,
  durationMs: 0,
  error: "boom",
});

const noopLogger = { info() {}, warn() {}, error() {} };

// ─── classifyByKeywords ──────────────────────────────────────────────────────

describe("classifyByKeywords", () => {
  // create_task
  it("detects create_task from 'create task'", () => {
    const result = classifyByKeywords("create task something");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
    expect(result!.confidence).toBe(0.95);
  });

  it("detects create_task from 'new task'", () => {
    const result = classifyByKeywords("new task add retry logic");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
  });

  it("detects create_task from 'add ticket'", () => {
    const result = classifyByKeywords("add ticket for the login bug");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
  });

  it("detects create_task from 'make item'", () => {
    const result = classifyByKeywords("make item to refactor pipeline");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
  });

  it("detects create_task from 'new story'", () => {
    const result = classifyByKeywords("new story implement retry logic");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
  });

  // approve
  it("detects approve from 'approve'", () => {
    const result = classifyByKeywords("approve");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("approve");
    expect(result!.confidence).toBe(0.95);
  });

  it("detects approve from 'lgtm'", () => {
    const result = classifyByKeywords("lgtm");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("approve");
  });

  it("detects approve from 'ship it'", () => {
    const result = classifyByKeywords("ship it");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("approve");
  });

  it("detects approve from 'go ahead'", () => {
    const result = classifyByKeywords("go ahead");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("approve");
  });

  // status
  it("detects status from 'status'", () => {
    const result = classifyByKeywords("status");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
    expect(result!.confidence).toBe(0.95);
  });

  it("detects status from 'what's running'", () => {
    const result = classifyByKeywords("what's running");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
  });

  it("detects status from 'whats running' (no apostrophe)", () => {
    const result = classifyByKeywords("whats running");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
  });

  it("detects status from 'show tasks'", () => {
    const result = classifyByKeywords("show tasks");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
  });

  it("detects status from 'progress'", () => {
    const result = classifyByKeywords("progress");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
  });

  // cancel
  it("detects cancel from 'cancel slug'", () => {
    const result = classifyByKeywords("cancel my-task-slug");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("cancel");
    expect(result!.confidence).toBe(0.95);
  });

  it("detects cancel from 'abort task-123'", () => {
    const result = classifyByKeywords("abort task-123");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("cancel");
  });

  it("detects cancel from 'stop running-task'", () => {
    const result = classifyByKeywords("stop running-task");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("cancel");
  });

  it("detects cancel from 'kill process'", () => {
    const result = classifyByKeywords("kill process");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("cancel");
  });

  // null for unrecognized
  it("returns null for unrecognized input", () => {
    expect(classifyByKeywords("hello world")).toBeNull();
    expect(classifyByKeywords("random gibberish text")).toBeNull();
    expect(classifyByKeywords("")).toBeNull();
  });

  // case insensitivity
  it("is case insensitive — 'CREATE TASK'", () => {
    const result = classifyByKeywords("CREATE TASK build login");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_task");
  });

  it("is case insensitive — 'LGTM'", () => {
    const result = classifyByKeywords("LGTM");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("approve");
  });

  it("is case insensitive — 'STATUS'", () => {
    const result = classifyByKeywords("STATUS");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("status");
  });

  it("is case insensitive — 'CANCEL task'", () => {
    const result = classifyByKeywords("CANCEL task-name");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("cancel");
  });

  // slug extraction
  it("extracts slug when present in create_task input", () => {
    const slug = "fix-auth-bug-20260404103000";
    const result = classifyByKeywords(`create task related to ${slug}`);
    expect(result).not.toBeNull();
    expect(result!.extractedSlug).toBe(slug);
  });

  it("extracts slug when present in cancel input", () => {
    const slug = "fix-auth-bug-20260404103000";
    const result = classifyByKeywords(`cancel ${slug}`);
    expect(result).not.toBeNull();
    expect(result!.extractedSlug).toBe(slug);
  });

  it("returns null extractedSlug when no slug in input", () => {
    const result = classifyByKeywords("create task build the feature");
    expect(result).not.toBeNull();
    expect(result!.extractedSlug).toBeNull();
  });

  it("returns null extractedContent initially", () => {
    const result = classifyByKeywords("status");
    expect(result).not.toBeNull();
    expect(result!.extractedContent).toBeNull();
  });
});

// ─── classifyByLLM ───────────────────────────────────────────────────────────

describe("classifyByLLM", () => {
  it("parses JSON result from stub runner", async () => {
    const result = await classifyByLLM("some ambiguous input", stubRunner, {} as any, noopLogger);
    expect(result.intent).toBe("create_task");
    expect(result.confidence).toBe(0.85);
    expect(result.extractedSlug).toBeNull();
    expect(result.extractedContent).toBe("test");
  });

  it("returns unknown intent when runner fails", async () => {
    const result = await classifyByLLM("some input", failRunner, {} as any, noopLogger);
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("returns unknown intent when output is invalid JSON", async () => {
    const badJsonRunner = async (): Promise<AgentRunResult> => ({
      success: true,
      output: "not valid json at all",
      costUsd: 0,
      turns: 1,
      durationMs: 10,
    });
    const result = await classifyByLLM("input", badJsonRunner, {} as any, noopLogger);
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("strips markdown code fences from LLM output", async () => {
    const fencedRunner = async (): Promise<AgentRunResult> => ({
      success: true,
      output: "```json\n" + JSON.stringify({ intent: "approve", confidence: 0.9, extractedSlug: null, extractedContent: null }) + "\n```",
      costUsd: 0,
      turns: 1,
      durationMs: 10,
    });
    const result = await classifyByLLM("lgtm-ish", fencedRunner, {} as any, noopLogger);
    expect(result.intent).toBe("approve");
    expect(result.confidence).toBe(0.9);
  });
});

// ─── classifyIntent ──────────────────────────────────────────────────────────

describe("classifyIntent", () => {
  it("uses keyword match when confidence is high (does not call LLM)", async () => {
    let llmCalled = false;
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      llmCalled = true;
      return stubRunner(opts);
    };

    const result = await classifyIntent("create task build the feature", trackingRunner, {} as any, noopLogger);
    expect(result.intent).toBe("create_task");
    expect(result.confidence).toBe(0.95);
    expect(llmCalled).toBe(false);
  });

  it("falls back to LLM for unrecognized input", async () => {
    let llmCalled = false;
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      llmCalled = true;
      return stubRunner(opts);
    };

    const result = await classifyIntent("something completely ambiguous", trackingRunner, {} as any, noopLogger);
    expect(llmCalled).toBe(true);
    expect(result.intent).toBe("create_task"); // stubRunner returns create_task
  });

  it("returns unknown when LLM fails on unrecognized input", async () => {
    const result = await classifyIntent("totally unrecognized input", failRunner, {} as any, noopLogger);
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("falls back to LLM when keyword confidence below threshold", async () => {
    // Use a very high custom threshold to force LLM fallback even for keyword matches
    let llmCalled = false;
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      llmCalled = true;
      return stubRunner(opts);
    };

    // With threshold = 0.99, keyword match at 0.95 should trigger LLM fallback
    const result = await classifyIntent("create task build feature", trackingRunner, {} as any, noopLogger, 0.99);
    expect(llmCalled).toBe(true);
    // LLM stub returns create_task
    expect(result.intent).toBe("create_task");
  });

  it("uses default confidence threshold of 0.7", async () => {
    // keyword match at 0.95 >= 0.7, should NOT call LLM
    let llmCalled = false;
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      llmCalled = true;
      return stubRunner(opts);
    };

    await classifyIntent("approve", trackingRunner, {} as any, noopLogger);
    expect(llmCalled).toBe(false);
  });
});
