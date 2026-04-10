import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { STAGE_DIR_MAP } from "../../src/core/stage-map.js";
import {
  buildPaths,
  TERMINAL_DIR_MAP,
  type TaskPaths,
  type RuntimePaths,
} from "../../src/config/paths.js";

const RUNTIME = "/test/runtime";

// ─── System paths ────────────────────────────────────────────────────────────

describe("buildPaths — system paths resolve from runtimeDir", () => {
  const p = buildPaths(RUNTIME);

  it("runtimeDir is set correctly", () => {
    expect(p.runtimeDir).toBe(RUNTIME);
  });

  it("logsDir", () => expect(p.logsDir).toBe(join(RUNTIME, "logs")));
  it("historyDir", () => expect(p.historyDir).toBe(join(RUNTIME, "history")));
  it("dailyLogDir", () => expect(p.dailyLogDir).toBe(join(RUNTIME, "history", "daily-log")));
  it("monthlyReportsDir", () => expect(p.monthlyReportsDir).toBe(join(RUNTIME, "history", "monthly-reports")));
  it("interactionsDir", () => expect(p.interactionsDir).toBe(join(RUNTIME, "interactions")));
  it("diagnosticsDir", () => expect(p.diagnosticsDir).toBe(join(RUNTIME, "diagnostics")));
  it("astraResponsesDir", () => expect(p.astraResponsesDir).toBe(join(RUNTIME, "astra-responses")));
  it("worktreesDir", () => expect(p.worktreesDir).toBe(join(RUNTIME, "worktrees")));

  it("pidFile", () => expect(p.pidFile).toBe(join(RUNTIME, "shkmn.pid")));
  it("worktreeManifest", () => expect(p.worktreeManifest).toBe(join(RUNTIME, "worktree-manifest.json")));
  it("usageBudget", () => expect(p.usageBudget).toBe(join(RUNTIME, "usage-budget.json")));
  it("envFile", () => expect(p.envFile).toBe(join(RUNTIME, ".env")));
  it("configFile", () => expect(p.configFile).toBe(join(RUNTIME, "shkmn.config.json")));

  it("slackOutbox", () => expect(p.slackOutbox).toBe(join(RUNTIME, "slack-outbox.jsonl")));
  it("slackInbox", () => expect(p.slackInbox).toBe(join(RUNTIME, "slack-inbox.jsonl")));
  it("slackSent", () => expect(p.slackSent).toBe(join(RUNTIME, "slack-sent.jsonl")));
  it("slackThreads", () => expect(p.slackThreads).toBe(join(RUNTIME, "slack-threads.json")));
  it("slackCursor", () => expect(p.slackCursor).toBe(join(RUNTIME, "slack-cursor.json")));
  it("slackProcessed", () => expect(p.slackProcessed).toBe(join(RUNTIME, "slack-processed.json")));
});

// ─── Stage dirs ──────────────────────────────────────────────────────────────

describe("buildPaths — stages built from STAGE_DIR_MAP", () => {
  const p = buildPaths(RUNTIME);

  it("has an entry for every stage in STAGE_DIR_MAP", () => {
    for (const stage of Object.keys(STAGE_DIR_MAP)) {
      expect(p.stages).toHaveProperty(stage);
    }
  });

  it("each stage path is join(runtimeDir, STAGE_DIR_MAP[stage])", () => {
    for (const [stage, dir] of Object.entries(STAGE_DIR_MAP)) {
      expect(p.stages[stage as keyof typeof p.stages]).toBe(join(RUNTIME, dir));
    }
  });
});

// ─── Terminal dirs ───────────────────────────────────────────────────────────

describe("buildPaths — terminal dirs", () => {
  const p = buildPaths(RUNTIME);

  it("inbox", () => expect(p.terminals.inbox).toBe(join(RUNTIME, "00-inbox")));
  it("complete", () => expect(p.terminals.complete).toBe(join(RUNTIME, "10-complete")));
  it("failed", () => expect(p.terminals.failed).toBe(join(RUNTIME, "11-failed")));
  it("hold", () => expect(p.terminals.hold).toBe(join(RUNTIME, "12-hold")));
});

// ─── TERMINAL_DIR_MAP ────────────────────────────────────────────────────────

describe("TERMINAL_DIR_MAP", () => {
  it("inbox → 00-inbox", () => expect(TERMINAL_DIR_MAP.inbox).toBe("00-inbox"));
  it("complete → 10-complete", () => expect(TERMINAL_DIR_MAP.complete).toBe("10-complete"));
  it("failed → 11-failed", () => expect(TERMINAL_DIR_MAP.failed).toBe("11-failed"));
  it("hold → 12-hold", () => expect(TERMINAL_DIR_MAP.hold).toBe("12-hold"));
});

// ─── resolveTask — pipeline stages ──────────────────────────────────────────

describe("resolveTask — pending pipeline stage", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug-20260410120000", "questions", "pending");

  it("taskDir = runtimeDir/01-questions/pending/slug", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "01-questions", "pending", "my-slug-20260410120000"));
  });

  it("artifactsDir = taskDir/artifacts", () => {
    expect(result.artifactsDir).toBe(join(result.taskDir, "artifacts"));
  });

  it("runStateFile = taskDir/run-state.json", () => {
    expect(result.runStateFile).toBe(join(result.taskDir, "run-state.json"));
  });

  it("taskFile = taskDir/task.task", () => {
    expect(result.taskFile).toBe(join(result.taskDir, "task.task"));
  });

  it("outputFile = artifacts/questions-output.md (no retry suffix)", () => {
    expect(result.outputFile).toBe(join(result.artifactsDir, "questions-output.md"));
  });
});

describe("resolveTask — done pipeline stage", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug-20260410120000", "impl", "done");

  it("taskDir uses done subdirectory", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "06-impl", "done", "my-slug-20260410120000"));
  });

  it("outputFile = artifacts/impl-output.md", () => {
    expect(result.outputFile).toBe(join(result.artifactsDir, "impl-output.md"));
  });
});

// ─── resolveTask — retry suffix ──────────────────────────────────────────────

describe("resolveTask — retry suffix", () => {
  const p = buildPaths(RUNTIME);

  it("retryNumber=0 produces no suffix", () => {
    const r = p.resolveTask("slug", "impl", "pending", 0);
    expect(r.outputFile).toBe(join(r.artifactsDir, "impl-output.md"));
  });

  it("retryNumber omitted produces no suffix", () => {
    const r = p.resolveTask("slug", "impl", "pending");
    expect(r.outputFile).toBe(join(r.artifactsDir, "impl-output.md"));
  });

  it("retryNumber=1 produces -r1 suffix", () => {
    const r = p.resolveTask("slug", "impl", "pending", 1);
    expect(r.outputFile).toBe(join(r.artifactsDir, "impl-output-r1.md"));
  });

  it("retryNumber=3 produces -r3 suffix", () => {
    const r = p.resolveTask("slug", "validate", "pending", 3);
    expect(r.outputFile).toBe(join(r.artifactsDir, "validate-output-r3.md"));
  });
});

// ─── resolveTask — terminal types ────────────────────────────────────────────

describe("resolveTask — terminal: complete", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug", "complete");

  it("taskDir = runtimeDir/10-complete/slug", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "10-complete", "my-slug"));
  });

  it("artifactsDir = taskDir/artifacts", () => {
    expect(result.artifactsDir).toBe(join(result.taskDir, "artifacts"));
  });

  it("runStateFile = taskDir/run-state.json", () => {
    expect(result.runStateFile).toBe(join(result.taskDir, "run-state.json"));
  });

  it("taskFile = taskDir/task.task", () => {
    expect(result.taskFile).toBe(join(result.taskDir, "task.task"));
  });

  it("outputFile is undefined for terminals", () => {
    expect(result.outputFile).toBeUndefined();
  });
});

describe("resolveTask — terminal: failed", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug", "failed");

  it("taskDir = runtimeDir/11-failed/slug", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "11-failed", "my-slug"));
  });

  it("outputFile is undefined", () => {
    expect(result.outputFile).toBeUndefined();
  });
});

describe("resolveTask — terminal: hold", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug", "hold");

  it("taskDir = runtimeDir/12-hold/slug", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "12-hold", "my-slug"));
  });

  it("outputFile is undefined", () => {
    expect(result.outputFile).toBeUndefined();
  });
});

describe("resolveTask — terminal: inbox", () => {
  const p = buildPaths(RUNTIME);
  const result = p.resolveTask("my-slug", "inbox");

  it("taskDir = runtimeDir/00-inbox/slug", () => {
    expect(result.taskDir).toBe(join(RUNTIME, "00-inbox", "my-slug"));
  });

  it("outputFile is undefined", () => {
    expect(result.outputFile).toBeUndefined();
  });
});

// ─── resolveTask — all 9 pipeline stages produce correct dirs ────────────────

describe("resolveTask — all pipeline stages", () => {
  const p = buildPaths(RUNTIME);

  for (const [stage, dir] of Object.entries(STAGE_DIR_MAP)) {
    it(`stage ${stage} uses directory ${dir}`, () => {
      const r = p.resolveTask("slug", stage as any, "pending");
      expect(r.taskDir).toBe(join(RUNTIME, dir, "pending", "slug"));
    });
  }
});

// ─── resolveTask — error cases ───────────────────────────────────────────────

describe("resolveTask — throws on unknown input", () => {
  const p = buildPaths(RUNTIME);

  it("throws for unknown pipeline stage", () => {
    expect(() => p.resolveTask("slug", "nonexistent" as any, "pending")).toThrow();
  });

  it("throws for unknown terminal", () => {
    expect(() => p.resolveTask("slug", "nonexistent" as any)).toThrow();
  });
});

// ─── Object is frozen ────────────────────────────────────────────────────────

describe("buildPaths — returns frozen object", () => {
  const p = buildPaths(RUNTIME);

  it("result is frozen", () => {
    expect(Object.isFrozen(p)).toBe(true);
  });
});
