import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { parseTriageResult } from "../../src/core/astra-triage.js";
import { createTask } from "../../src/core/task-creator.js";
import { resolveConfig } from "../../src/config/loader.js";
import { configSchema } from "../../src/config/schema.js";

let TEST_DIR: string;

function makeConfig() {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } }),
  );
}

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-astra-integ-${randomUUID()}`);
  mkdirSync(join(TEST_DIR, "00-inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Astra end-to-end flow", () => {
  it("control_command: triage returns cancel — no task file created", () => {
    const triageOutput = JSON.stringify({
      action: "control_command",
      controlOp: "cancel",
      extractedSlug: "fix-auth-bug-20260404103000",
      confidence: 0.99,
      reasoning: "User wants to cancel",
    });

    const result = parseTriageResult(triageOutput);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("control_command");
    expect(result!.controlOp).toBe("cancel");
    expect(result!.extractedSlug).toBe("fix-auth-bug-20260404103000");

    // No task should be created for control commands
    const inboxFiles = readdirSync(join(TEST_DIR, "00-inbox"));
    expect(inboxFiles.filter(f => f.endsWith(".task"))).toHaveLength(0);
  });

  it("route_pipeline: triage returns stages — task file created with recommended stages", () => {
    const triageOutput = JSON.stringify({
      action: "route_pipeline",
      confidence: 0.9,
      reasoning: "Complex refactor",
      recommendedStages: ["design", "plan", "impl", "validate", "review", "pr"],
      stageHints: { impl: "Use exponential backoff" },
      enrichedContext: "retry.ts has linear backoff",
      repoSummary: "TypeScript project with retry logic",
    });

    const result = parseTriageResult(triageOutput);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("route_pipeline");

    const config = makeConfig();
    const slug = createTask(
      {
        source: "slack",
        content: "refactor retry logic to use exponential backoff",
        stages: result!.recommendedStages,
        stageHints: result!.stageHints,
      },
      join(TEST_DIR, "00-inbox"),
      config,
      result!.enrichedContext,
      result!.repoSummary,
    );

    const taskFile = join(TEST_DIR, "00-inbox", `${slug}.task`);
    expect(existsSync(taskFile)).toBe(true);

    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("stages: design, plan, impl, review, validate, pr");
    expect(content).toContain("## Astra Context");
    expect(content).toContain("retry.ts has linear backoff");
    expect(content).toContain("## Repo Summary");
    expect(content).toContain("TypeScript project with retry logic");
    expect(content).toContain("## Stage Hints");
    expect(content).toContain("impl: Use exponential backoff");
  });

  it("answer: triage returns answer — no task file, direct response path", () => {
    const triageOutput = JSON.stringify({
      action: "answer",
      confidence: 0.95,
      reasoning: "Simple question about code structure",
    });

    const result = parseTriageResult(triageOutput);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("answer");

    // No task should be created for direct answers
    const inboxFiles = readdirSync(join(TEST_DIR, "00-inbox"));
    expect(inboxFiles.filter(f => f.endsWith(".task"))).toHaveLength(0);
  });

  it("route_pipeline without enrichedContext creates task without Astra sections", () => {
    const triageOutput = JSON.stringify({
      action: "route_pipeline",
      confidence: 0.85,
      reasoning: "Multi-step task",
      recommendedStages: ["impl", "review", "pr"],
    });

    const result = parseTriageResult(triageOutput);
    expect(result).not.toBeNull();

    const config = makeConfig();
    const slug = createTask(
      {
        source: "slack",
        content: "fix the null check in watcher.ts",
        stages: result!.recommendedStages,
      },
      join(TEST_DIR, "00-inbox"),
      config,
    );

    const taskFile = join(TEST_DIR, "00-inbox", `${slug}.task`);
    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("stages: design, plan, impl, review, validate, pr");
    expect(content).not.toContain("## Astra Context");
    expect(content).not.toContain("## Repo Summary");
  });

  it("control_command with all controlOp variants parses correctly", () => {
    const ops = ["approve", "cancel", "skip", "pause", "resume", "modify_stages", "restart_stage", "retry"] as const;
    for (const op of ops) {
      const result = parseTriageResult(JSON.stringify({
        action: "control_command",
        controlOp: op,
        confidence: 0.95,
        reasoning: `User wants to ${op}`,
      }));
      expect(result).not.toBeNull();
      expect(result!.controlOp).toBe(op);
    }
  });
});
