import { describe, it, expectTypeOf } from "vitest";
import type { AstraTriageResult } from "../../src/core/types.js";

describe("AstraTriageResult", () => {
  it("accepts action=answer shape", () => {
    const result: AstraTriageResult = {
      action: "answer",
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
