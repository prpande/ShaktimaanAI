import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isPeakHour,
  getEffectiveLimit,
  aggregateDailyTokens,
  aggregateTaskTokens,
  aggregateWeeklyTokens,
  createSessionTracker,
  checkBudget,
  resolveModelForStage,
} from "../../src/core/budget.js";
import type { BudgetConfig } from "../../src/config/budget-schema.js";
import type { DailyLogEntry } from "../../src/core/interactions.js";
import type { CompletedStage } from "../../src/core/types.js";
import type { ResolvedConfig } from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testBudgetConfig: BudgetConfig = {
  model_budgets: {
    sonnet: {
      weekly_token_limit: 15_000_000,
      daily_token_limit: 3_000_000,
      session_token_limit: 800_000,
      per_task_token_limit: 200_000,
    },
    opus: {
      weekly_token_limit: 5_000_000,
      daily_token_limit: 1_000_000,
      session_token_limit: 300_000,
      per_task_token_limit: 100_000,
    },
  },
  peak_hours: { start_utc: "12:00", end_utc: "18:00", multiplier: 0.5 },
  safety_margin: 0.15,
};

// ─── S4: Utility Functions ──────────────────────────────────────────────────

describe("isPeakHour", () => {
  it("returns true for 14:00 UTC when peak is 12:00-18:00", () => {
    expect(isPeakHour(testBudgetConfig, new Date("2024-01-01T14:00:00Z"))).toBe(true);
  });

  it("returns false for 20:00 UTC", () => {
    expect(isPeakHour(testBudgetConfig, new Date("2024-01-01T20:00:00Z"))).toBe(false);
  });

  it("returns true at boundary: exactly 12:00 UTC (inclusive)", () => {
    expect(isPeakHour(testBudgetConfig, new Date("2024-01-01T12:00:00Z"))).toBe(true);
  });

  it("returns false at boundary: exactly 18:00 UTC (exclusive)", () => {
    expect(isPeakHour(testBudgetConfig, new Date("2024-01-01T18:00:00Z"))).toBe(false);
  });
});

describe("getEffectiveLimit", () => {
  it("non-peak: 1_000_000 * 1.0 * (1 - 0.15) = 850_000", () => {
    expect(getEffectiveLimit(1_000_000, 0.15, false, 0.5)).toBe(850_000);
  });

  it("peak with 0.5 multiplier: 1_000_000 * 0.5 * (1 - 0.15) = 425_000", () => {
    expect(getEffectiveLimit(1_000_000, 0.15, true, 0.5)).toBe(425_000);
  });
});

describe("aggregateDailyTokens", () => {
  it("sums only entries matching the given model", () => {
    const entries: DailyLogEntry[] = [
      { timestamp: "2024-01-01T10:00:00Z", type: "agent_completed", slug: "t1", model: "opus", inputTokens: 100, outputTokens: 50 },
      { timestamp: "2024-01-01T11:00:00Z", type: "agent_completed", slug: "t2", model: "sonnet", inputTokens: 200, outputTokens: 100 },
      { timestamp: "2024-01-01T12:00:00Z", type: "agent_completed", slug: "t3", model: "opus", inputTokens: 300, outputTokens: 150 },
    ];
    expect(aggregateDailyTokens(entries, "opus")).toBe(600);
  });

  it("returns 0 for empty array", () => {
    expect(aggregateDailyTokens([], "opus")).toBe(0);
  });

  it("handles entries without inputTokens/outputTokens", () => {
    const entries: DailyLogEntry[] = [
      { timestamp: "2024-01-01T10:00:00Z", type: "agent_completed", slug: "t1", model: "opus" },
    ];
    expect(aggregateDailyTokens(entries, "opus")).toBe(0);
  });

  it("ignores non-agent_completed entries", () => {
    const entries: DailyLogEntry[] = [
      { timestamp: "2024-01-01T10:00:00Z", type: "agent_started", slug: "t1", model: "opus", inputTokens: 999, outputTokens: 999 },
      { timestamp: "2024-01-01T11:00:00Z", type: "agent_completed", slug: "t2", model: "opus", inputTokens: 100, outputTokens: 50 },
    ];
    expect(aggregateDailyTokens(entries, "opus")).toBe(150);
  });
});

describe("aggregateTaskTokens", () => {
  it("sums inputTokens + outputTokens for matching model", () => {
    const stages: CompletedStage[] = [
      { stage: "plan", completedAt: "2024-01-01T10:00:00Z", model: "opus", inputTokens: 40, outputTokens: 60 },
      { stage: "impl", completedAt: "2024-01-01T11:00:00Z", model: "sonnet", inputTokens: 100, outputTokens: 200 },
    ];
    expect(aggregateTaskTokens(stages, "opus")).toBe(100);
  });

  it("returns 0 for stages with undefined token counts", () => {
    const stages: CompletedStage[] = [
      { stage: "plan", completedAt: "2024-01-01T10:00:00Z", model: "opus" },
    ];
    expect(aggregateTaskTokens(stages, "opus")).toBe(0);
  });

  it("returns 0 when no stages match the model", () => {
    const stages: CompletedStage[] = [
      { stage: "impl", completedAt: "2024-01-01T10:00:00Z", model: "sonnet", inputTokens: 100, outputTokens: 200 },
    ];
    expect(aggregateTaskTokens(stages, "opus")).toBe(0);
  });
});

describe("aggregateWeeklyTokens", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `shkmn-test-weekly-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 0 when no JSONL files exist", () => {
    expect(aggregateWeeklyTokens(tempDir, "opus", new Date("2024-01-03T10:00:00Z"))).toBe(0);
  });

  it("sums tokens from current ISO week only", () => {
    // 2024-01-03 is Wednesday. ISO week starts Monday 2024-01-01.
    const mondayEntry = JSON.stringify({
      timestamp: "2024-01-01T10:00:00Z", type: "agent_completed", slug: "t1",
      model: "opus", inputTokens: 100, outputTokens: 50,
    });
    const wednesdayEntry = JSON.stringify({
      timestamp: "2024-01-03T10:00:00Z", type: "agent_completed", slug: "t2",
      model: "opus", inputTokens: 200, outputTokens: 100,
    });
    // Previous week (Sunday Dec 31)
    const prevWeekEntry = JSON.stringify({
      timestamp: "2023-12-31T10:00:00Z", type: "agent_completed", slug: "t3",
      model: "opus", inputTokens: 999, outputTokens: 999,
    });

    writeFileSync(join(tempDir, "2024-01-01.jsonl"), mondayEntry + "\n");
    writeFileSync(join(tempDir, "2024-01-03.jsonl"), wednesdayEntry + "\n");
    writeFileSync(join(tempDir, "2023-12-31.jsonl"), prevWeekEntry + "\n");

    const result = aggregateWeeklyTokens(tempDir, "opus", new Date("2024-01-03T10:00:00Z"));
    expect(result).toBe(450); // (100+50) + (200+100)
  });

  it("handles missing interactionsDir gracefully", () => {
    expect(aggregateWeeklyTokens("/nonexistent/path", "opus", new Date("2024-01-03T10:00:00Z"))).toBe(0);
  });
});

describe("createSessionTracker", () => {
  it("returns 0 for unknown models", () => {
    const tracker = createSessionTracker();
    expect(tracker.getUsage("opus")).toBe(0);
  });

  it("accumulates usage via addUsage", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("opus", 500);
    tracker.addUsage("opus", 300);
    expect(tracker.getUsage("opus")).toBe(800);
  });

  it("tracks multiple models independently", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("opus", 500);
    tracker.addUsage("sonnet", 1000);
    expect(tracker.getUsage("opus")).toBe(500);
    expect(tracker.getUsage("sonnet")).toBe(1000);
  });

  it("resets all counters", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("opus", 500);
    tracker.addUsage("sonnet", 1000);
    tracker.reset();
    expect(tracker.getUsage("opus")).toBe(0);
    expect(tracker.getUsage("sonnet")).toBe(0);
  });
});

// ─── S5: Budget Check and Model Resolution ─────────────────────────────────

describe("checkBudget", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `shkmn-test-cb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns isOverLimit: false when all usage is well under limits", () => {
    const result = checkBudget("opus", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
    });
    expect(result.isOverLimit).toBe(false);
    expect(result.limitBreached).toBeNull();
  });

  it("returns limitBreached: 'daily' when daily usage exceeds effective daily limit", () => {
    // 14:00 UTC is peak. Effective daily for opus peak: 1M * 0.5 * 0.85 = 425_000
    const today = new Date("2024-01-03T14:00:00Z");
    const dateStr = "2024-01-03";
    const entry = JSON.stringify({
      timestamp: `${dateStr}T10:00:00Z`, type: "agent_completed", slug: "t1",
      model: "opus", inputTokens: 500_000, outputTokens: 400_000,
    });
    writeFileSync(join(tempDir, `${dateStr}.jsonl`), entry + "\n");

    const result = checkBudget("opus", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
      today,
    });
    expect(result.isOverLimit).toBe(true);
    expect(result.limitBreached).toBe("daily");
  });

  it("returns limitBreached: 'session' when session usage exceeds limit", () => {
    const tracker = createSessionTracker();
    // Effective session limit for opus non-peak: 300_000 * 1.0 * 0.85 = 255_000
    tracker.addUsage("opus", 260_000);

    const result = checkBudget("opus", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: tracker,
      taskCompletedStages: [],
      today: new Date("2024-01-03T20:00:00Z"),
    });
    expect(result.isOverLimit).toBe(true);
    expect(result.limitBreached).toBe("session");
  });

  it("returns limitBreached: 'task' when task usage exceeds per-task limit", () => {
    // Effective task limit for opus non-peak: 100_000 * 1.0 * 0.85 = 85_000
    const stages: CompletedStage[] = [
      { stage: "plan", completedAt: "2024-01-03T10:00:00Z", model: "opus", inputTokens: 50_000, outputTokens: 40_000 },
    ];

    const result = checkBudget("opus", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: stages,
      today: new Date("2024-01-03T20:00:00Z"),
    });
    expect(result.isOverLimit).toBe(true);
    expect(result.limitBreached).toBe("task");
  });

  it("returns isOverLimit: false for model not in budget config (fail-open)", () => {
    const result = checkBudget("haiku", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
    });
    expect(result.isOverLimit).toBe(false);
    expect(result.limitBreached).toBeNull();
  });

  it("applies peak-hour multiplier to reduce effective limits", () => {
    const result = checkBudget("opus", testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
      today: new Date("2024-01-03T14:00:00Z"),
    });
    expect(result.effectiveMultiplier).toBe(0.5);
  });
});

describe("resolveModelForStage", () => {
  let tempDir: string;
  const mockConfig = DEFAULT_CONFIG as ResolvedConfig;

  beforeEach(() => {
    tempDir = join(tmpdir(), `shkmn-test-rm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns action: 'use' when preferred model is within budget", () => {
    const result = resolveModelForStage("plan", mockConfig, testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
    });
    expect(result.action).toBe("use");
    expect(result).toHaveProperty("model", "opus"); // plan defaults to opus
  });

  it("returns action: 'downgrade' when opus is over limit but sonnet is OK", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("opus", 260_000); // over 255_000 effective non-peak

    const result = resolveModelForStage("plan", mockConfig, testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: tracker,
      taskCompletedStages: [],
      today: new Date("2024-01-03T20:00:00Z"),
    });
    expect(result.action).toBe("downgrade");
    if (result.action === "downgrade") {
      expect(result.model).toBe("sonnet");
      expect(result.reason).toBeTruthy();
    }
  });

  it("returns action: 'hold' when both opus and sonnet are over limit", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("opus", 260_000);
    tracker.addUsage("sonnet", 700_000); // over 680_000 effective non-peak

    const result = resolveModelForStage("plan", mockConfig, testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: tracker,
      taskCompletedStages: [],
      today: new Date("2024-01-03T20:00:00Z"),
    });
    expect(result.action).toBe("hold");
    if (result.action === "hold") {
      expect(result.reason).toBeTruthy();
    }
  });

  it("returns action: 'use' for haiku (not in budget config, fail-open)", () => {
    const tracker = createSessionTracker();
    tracker.addUsage("haiku", 999_999_999);

    const result = resolveModelForStage("quick", mockConfig, testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: tracker,
      taskCompletedStages: [],
    });
    expect(result.action).toBe("use");
    if (result.action === "use") {
      expect(result.model).toBe("haiku");
    }
  });

  it("falls back to sonnet when stage has no model configured", () => {
    const configNoModels = { ...mockConfig, agents: { ...mockConfig.agents, models: {} } } as ResolvedConfig;
    const result = resolveModelForStage("plan", configNoModels, testBudgetConfig, {
      interactionsDir: tempDir,
      sessionTracker: createSessionTracker(),
      taskCompletedStages: [],
    });
    expect(result.action).toBe("use");
    if (result.action === "use") {
      expect(result.model).toBe("sonnet");
    }
  });
});
