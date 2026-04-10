import { describe, it, expect, expectTypeOf } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AstraTriageResult } from "../../src/core/types.js";
import { parseTriageResult, runAstraTriage, type AstraInput } from "../../src/core/astra-triage.js";
import type { AgentRunOptions, AgentRunResult } from "../../src/core/types.js";

describe("AstraTriageResult", () => {
  it("accepts action=answer shape", () => {
    const result: AstraTriageResult = {
      action: "answer",
      directAnswer: "Current status: one active task.",
      confidence: 0.95,
      reasoning: "This is a direct question with a clear answer.",
    };
    expectTypeOf(result).toMatchTypeOf<AstraTriageResult>();
  });

  it("accepts action=route_pipeline shape", () => {
    const result: AstraTriageResult = {
      action: "route_pipeline",
      recommendedStages: ["questions", "research", "design"],
      stageHints: { questions: "Focus on API design" },
      enrichedContext: "User wants a REST API for task management",
      repoSummary: "TypeScript monorepo with Express backend",
      confidence: 0.88,
      reasoning: "Task requires full pipeline execution.",
    };
    expectTypeOf(result).toMatchTypeOf<AstraTriageResult>();
  });

  it("accepts action=control_command shape", () => {
    const result: AstraTriageResult = {
      action: "control_command",
      controlOp: "approve",
      extractedSlug: "my-feature-slug",
      confidence: 0.99,
      reasoning: "User explicitly approved the pipeline.",
    };
    expectTypeOf(result).toMatchTypeOf<AstraTriageResult>();
  });

  it("accepts all controlOp variants", () => {
    const ops: Array<AstraTriageResult["controlOp"]> = [
      "approve", "cancel", "skip", "pause",
      "resume", "modify_stages", "restart_stage", "retry",
      undefined,
    ];
    for (const controlOp of ops) {
      const result: AstraTriageResult = {
        action: "control_command",
        controlOp,
        confidence: 0.9,
        reasoning: `Testing controlOp=${String(controlOp)}`,
      };
      expectTypeOf(result).toMatchTypeOf<AstraTriageResult>();
    }
  });

  it("requires confidence and reasoning on all shapes", () => {
    expectTypeOf<AstraTriageResult>().toHaveProperty("confidence");
    expectTypeOf<AstraTriageResult>().toHaveProperty("reasoning");
  });
});

describe("parseTriageResult", () => {
  it("parses valid answer action", () => {
    const json = JSON.stringify({ action: "answer", confidence: 0.95, reasoning: "Simple question" });
    const result = parseTriageResult(json);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");
  });

  it("parses valid route_pipeline action with stages", () => {
    const json = JSON.stringify({
      action: "route_pipeline", confidence: 0.9, reasoning: "Needs design",
      recommendedStages: ["design", "plan", "impl", "review", "pr"],
      enrichedContext: "Found retry logic", repoSummary: "TS project",
    });
    const result = parseTriageResult(json);
    expect(result).not.toBeNull();
    expect(result!.recommendedStages).toEqual(["design", "plan", "impl", "review", "pr"]);
    expect(result!.enrichedContext).toBe("Found retry logic");
  });

  it("parses valid control_command action", () => {
    const json = JSON.stringify({
      action: "control_command", controlOp: "cancel",
      extractedSlug: "fix-auth-bug-20260404103000", confidence: 0.99, reasoning: "Cancel",
    });
    const result = parseTriageResult(json);
    expect(result!.controlOp).toBe("cancel");
    expect(result!.extractedSlug).toBe("fix-auth-bug-20260404103000");
  });

  it("strips markdown code fences", () => {
    const json = "```json\n" + JSON.stringify({ action: "answer", confidence: 0.8, reasoning: "test" }) + "\n```";
    expect(parseTriageResult(json)).not.toBeNull();
  });

  it("returns null for malformed json-like output", () => {
    expect(parseTriageResult("{bad json")).toBeNull();
  });

  it("falls back to answer when output is plain non-JSON text", () => {
    const result = parseTriageResult("Pipeline is healthy. One task is running.");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");
    expect(result!.directAnswer).toContain("Pipeline is healthy");
  });

  it("falls back to answer when non-JSON text is inside code fences", () => {
    const result = parseTriageResult("```json\nPipeline is healthy.\n```");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");
    expect(result!.directAnswer).toBe("Pipeline is healthy.");
  });

  it("strips generic code fences from fallback answer", () => {
    const result = parseTriageResult("```\nHere is your answer.\n```");
    expect(result).not.toBeNull();
    expect(result!.directAnswer).toBe("Here is your answer.");
  });

  it("returns null for invalid action value", () => {
    expect(parseTriageResult(JSON.stringify({ action: "bad", confidence: 0.5, reasoning: "x" }))).toBeNull();
  });

  it("defaults optional fields to undefined", () => {
    const result = parseTriageResult(JSON.stringify({ action: "answer", confidence: 0.8, reasoning: "simple" }));
    expect(result!.controlOp).toBeUndefined();
    expect(result!.recommendedStages).toBeUndefined();
  });
});

describe("runAstraTriage", () => {
  const noopLogger = { info() {}, warn() {}, error() {} };
  const runtimeDir = tmpdir();
  const mockConfig = {
    pipeline: { runtimeDir },
    paths: { astraResponsesDir: join(runtimeDir, "astra-responses") },
  } as any;
  const mockInput: AstraInput = {
    message: "what stages are running?",
    channelId: "C12345",
    userId: "U12345",
    source: "slack",
  };

  it("returns parsed result on success", async () => {
    const mockRunner = async (_opts: AgentRunOptions): Promise<AgentRunResult> => ({
      success: true,
      output: JSON.stringify({ action: "answer", confidence: 0.95, reasoning: "Status question" }),
      costUsd: 0.001, turns: 2, durationMs: 1500, inputTokens: 500, outputTokens: 100,
    });

    const result = await runAstraTriage(mockInput, mockRunner, mockConfig, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");
  });

  it("returns null when runner fails", async () => {
    const failRunner = async (): Promise<AgentRunResult> => ({
      success: false, output: "", costUsd: 0, turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, error: "boom",
    });

    const result = await runAstraTriage(mockInput, failRunner, mockConfig, noopLogger);
    expect(result).toBeNull();
  });

  it("falls back to direct answer when runner returns non-JSON text", async () => {
    const badRunner = async (): Promise<AgentRunResult> => ({
      success: true, output: "not json", costUsd: 0, turns: 1, durationMs: 100, inputTokens: 0, outputTokens: 0,
    });

    const result = await runAstraTriage(mockInput, badRunner, mockConfig, noopLogger);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");
    expect(result!.directAnswer).toBe("not json");
  });

  it("returns null when runner throws", async () => {
    const throwRunner = async (): Promise<AgentRunResult> => { throw new Error("connection failed"); };

    const result = await runAstraTriage(mockInput, throwRunner, mockConfig, noopLogger);
    expect(result).toBeNull();
  });

  it("passes stage=quick and slug=astra-triage to runner", async () => {
    let capturedOpts: AgentRunOptions | null = null;
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      capturedOpts = opts;
      return {
        success: true,
        output: JSON.stringify({ action: "answer", confidence: 0.9, reasoning: "test" }),
        costUsd: 0, turns: 1, durationMs: 50, inputTokens: 0, outputTokens: 0,
      };
    };

    await runAstraTriage(mockInput, trackingRunner, mockConfig, noopLogger);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.stage).toBe("quick-triage");
    expect(capturedOpts!.slug).toBe("astra-triage");
    expect(capturedOpts!.taskContent).toContain("what stages are running?");
  });

  it("includes threadTs in taskContent when provided", async () => {
    let capturedContent = "";
    const trackingRunner = async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      capturedContent = opts.taskContent;
      return {
        success: true,
        output: JSON.stringify({ action: "answer", confidence: 0.9, reasoning: "test" }),
        costUsd: 0, turns: 1, durationMs: 50, inputTokens: 0, outputTokens: 0,
      };
    };

    await runAstraTriage({ ...mockInput, threadTs: "1234.5678" }, trackingRunner, mockConfig, noopLogger);
    expect(capturedContent).toContain("Thread: 1234.5678");
  });
});
