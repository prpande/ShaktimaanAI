import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { DailyLogEntry } from "../../src/core/interactions.js";
import {
  parseCompletedEntry,
  aggregateStageStats,
  computePipelineSummary,
  formatDuration,
  formatStatsTable,
  formatStatsJson,
  executeStats,
  type StageStats,
  type PipelineSummary,
  type CompletedLogEntry,
} from "../../src/commands/stats.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<DailyLogEntry> = {}): DailyLogEntry {
  return {
    timestamp: "2026-04-01T10:00:00.000Z",
    type: "agent_completed",
    slug: "task-a",
    stage: "questions",
    durationSeconds: 60,
    costUsd: 0.05,
    turns: 4,
    success: true,
    ...overrides,
  };
}

// ─── parseCompletedEntry ────────────────────────────────────────────────────

describe("parseCompletedEntry", () => {
  it("parses a valid agent_completed entry with costUsd field", () => {
    const entry = makeEntry({ costUsd: 0.12, durationSeconds: 90, turns: 5 });
    const parsed = parseCompletedEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.costUsd).toBe(0.12);
    expect(parsed!.durationSeconds).toBe(90);
    expect(parsed!.turns).toBe(5);
  });

  it("falls back to tokensUsed field for backward compatibility", () => {
    const entry: DailyLogEntry = {
      timestamp: "2026-04-01T10:00:00.000Z",
      type: "agent_completed",
      slug: "task-a",
      stage: "questions",
      durationSeconds: 60,
      tokensUsed: 0.08,
      turns: 3,
      success: true,
    };
    const parsed = parseCompletedEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.costUsd).toBe(0.08);
  });

  it("returns null for non-agent_completed entries", () => {
    expect(parseCompletedEntry(makeEntry({ type: "agent_started" }))).toBeNull();
  });

  it("returns null for entries with success !== true", () => {
    expect(parseCompletedEntry(makeEntry({ success: false }))).toBeNull();
  });

  it("returns null for entries missing stage field", () => {
    const entry = makeEntry();
    delete (entry as Record<string, unknown>).stage;
    expect(parseCompletedEntry(entry)).toBeNull();
  });

  it("defaults turns to 0 when missing", () => {
    const entry = makeEntry();
    delete (entry as Record<string, unknown>).turns;
    const parsed = parseCompletedEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.turns).toBe(0);
  });

  it("defaults durationSeconds to 0 when missing", () => {
    const entry = makeEntry();
    delete (entry as Record<string, unknown>).durationSeconds;
    const parsed = parseCompletedEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.durationSeconds).toBe(0);
  });
});

// ─── aggregateStageStats ────────────────────────────────────────────────────

describe("aggregateStageStats", () => {
  it("aggregates entries by stage with correct averages", () => {
    const entries: CompletedLogEntry[] = [
      { timestamp: "2026-04-01T10:00:00Z", slug: "task-a", stage: "questions", durationSeconds: 60, costUsd: 0.04, turns: 3 },
      { timestamp: "2026-04-01T11:00:00Z", slug: "task-b", stage: "questions", durationSeconds: 80, costUsd: 0.06, turns: 5 },
      { timestamp: "2026-04-01T12:00:00Z", slug: "task-a", stage: "research", durationSeconds: 200, costUsd: 0.15, turns: 10 },
    ];

    const stats = aggregateStageStats(entries);
    expect(stats).toHaveLength(2);

    const qStats = stats.find((s) => s.stage === "questions")!;
    expect(qStats.count).toBe(2);
    expect(qStats.avgDurationSeconds).toBe(70);
    expect(qStats.avgCostUsd).toBeCloseTo(0.05);
    expect(qStats.avgTurns).toBe(4);
    expect(qStats.totalCostUsd).toBeCloseTo(0.10);

    const rStats = stats.find((s) => s.stage === "research")!;
    expect(rStats.count).toBe(1);
    expect(rStats.avgDurationSeconds).toBe(200);
    expect(rStats.avgCostUsd).toBeCloseTo(0.15);
    expect(rStats.avgTurns).toBe(10);
    expect(rStats.totalCostUsd).toBeCloseTo(0.15);
  });

  it("orders output by PIPELINE_STAGES constant", () => {
    const entries: CompletedLogEntry[] = [
      { timestamp: "2026-04-01T10:00:00Z", slug: "t", stage: "impl", durationSeconds: 60, costUsd: 0.1, turns: 5 },
      { timestamp: "2026-04-01T11:00:00Z", slug: "t", stage: "questions", durationSeconds: 30, costUsd: 0.02, turns: 2 },
      { timestamp: "2026-04-01T12:00:00Z", slug: "t", stage: "design", durationSeconds: 120, costUsd: 0.08, turns: 7 },
    ];

    const stats = aggregateStageStats(entries);
    expect(stats.map((s) => s.stage)).toEqual(["questions", "design", "impl"]);
  });

  it("appends unknown stages after known stages", () => {
    const entries: CompletedLogEntry[] = [
      { timestamp: "2026-04-01T10:00:00Z", slug: "t", stage: "custom-stage", durationSeconds: 60, costUsd: 0.1, turns: 5 },
      { timestamp: "2026-04-01T11:00:00Z", slug: "t", stage: "questions", durationSeconds: 30, costUsd: 0.02, turns: 2 },
    ];

    const stats = aggregateStageStats(entries);
    expect(stats.map((s) => s.stage)).toEqual(["questions", "custom-stage"]);
  });

  it("returns empty array for empty input", () => {
    expect(aggregateStageStats([])).toEqual([]);
  });
});

// ─── computePipelineSummary ─────────────────────────────────────────────────

describe("computePipelineSummary", () => {
  it("computes per-run averages and identifies most expensive stage", () => {
    const entries: CompletedLogEntry[] = [
      { timestamp: "2026-04-01T10:00:00Z", slug: "task-a", stage: "questions", durationSeconds: 60, costUsd: 0.04, turns: 3 },
      { timestamp: "2026-04-01T11:00:00Z", slug: "task-a", stage: "research", durationSeconds: 200, costUsd: 0.15, turns: 10 },
      { timestamp: "2026-04-02T10:00:00Z", slug: "task-b", stage: "questions", durationSeconds: 80, costUsd: 0.06, turns: 5 },
      { timestamp: "2026-04-02T11:00:00Z", slug: "task-b", stage: "research", durationSeconds: 180, costUsd: 0.12, turns: 8 },
    ];

    const stageStats = aggregateStageStats(entries);
    const summary = computePipelineSummary(entries, stageStats);

    expect(summary.totalRuns).toBe(2);
    expect(summary.avgTotalDurationSeconds).toBe(260);
    expect(summary.avgTotalCostUsd).toBeCloseTo(0.185);
    expect(summary.avgTotalTurns).toBe(13);
    expect(summary.mostExpensiveStage).toBe("research");
  });

  it("handles a single run", () => {
    const entries: CompletedLogEntry[] = [
      { timestamp: "2026-04-01T10:00:00Z", slug: "solo", stage: "impl", durationSeconds: 300, costUsd: 0.50, turns: 20 },
    ];

    const stageStats = aggregateStageStats(entries);
    const summary = computePipelineSummary(entries, stageStats);

    expect(summary.totalRuns).toBe(1);
    expect(summary.avgTotalDurationSeconds).toBe(300);
    expect(summary.avgTotalCostUsd).toBeCloseTo(0.50);
    expect(summary.avgTotalTurns).toBe(20);
    expect(summary.mostExpensiveStage).toBe("impl");
  });

  it("returns sensible defaults for empty input", () => {
    const summary = computePipelineSummary([], []);
    expect(summary.totalRuns).toBe(0);
    expect(summary.avgTotalDurationSeconds).toBe(0);
    expect(summary.avgTotalCostUsd).toBe(0);
    expect(summary.avgTotalTurns).toBe(0);
    expect(summary.mostExpensiveStage).toBe("N/A");
  });
});

// ─── formatDuration ─────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(83)).toBe("1m 23s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatDuration(8145)).toBe("2h 15m 45s");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120)).toBe("2m 0s");
  });

  it("formats exact hours", () => {
    expect(formatDuration(3600)).toBe("1h 0m 0s");
  });

  it("rounds fractional seconds", () => {
    expect(formatDuration(83.7)).toBe("1m 24s");
    expect(formatDuration(0.4)).toBe("0s");
    expect(formatDuration(59.5)).toBe("1m 0s");
  });
});

// ─── formatStatsTable ───────────────────────────────────────────────────────

describe("formatStatsTable", () => {
  const sampleStats: StageStats[] = [
    { stage: "questions", count: 2, avgDurationSeconds: 83, avgTurns: 4.2, avgCostUsd: 0.042, totalCostUsd: 0.084 },
    { stage: "research", count: 2, avgDurationSeconds: 225, avgTurns: 8.1, avgCostUsd: 0.156, totalCostUsd: 0.312 },
  ];
  const sampleSummary: PipelineSummary = {
    totalRuns: 2,
    avgTotalDurationSeconds: 308,
    avgTotalCostUsd: 0.198,
    avgTotalTurns: 12.3,
    mostExpensiveStage: "research",
  };

  it("includes column headers", () => {
    const output = formatStatsTable(sampleStats, sampleSummary);
    expect(output).toContain("Stage");
    expect(output).toContain("Runs");
    expect(output).toContain("Avg Time");
    expect(output).toContain("Avg Turns");
    expect(output).toContain("Avg Cost");
    expect(output).toContain("Total Cost");
  });

  it("includes stage rows with formatted values", () => {
    const output = formatStatsTable(sampleStats, sampleSummary);
    expect(output).toContain("questions");
    expect(output).toContain("research");
    expect(output).toContain("1m 23s");
    expect(output).toContain("$0.042");
  });

  it("includes TOTAL summary row with grand total cost", () => {
    const output = formatStatsTable(sampleStats, sampleSummary);
    expect(output).toContain("TOTAL");
    expect(output).toContain("$0.198");  // avgTotalCostUsd
    expect(output).toContain("$0.396");  // grand total (0.084 + 0.312)
  });

  it("includes most expensive stage", () => {
    const output = formatStatsTable(sampleStats, sampleSummary);
    expect(output).toContain("Most $$");
    expect(output).toContain("research");
  });

  it("uses separator lines", () => {
    const output = formatStatsTable(sampleStats, sampleSummary);
    expect(output).toContain("───");
  });
});

// ─── formatStatsJson ────────────────────────────────────────────────────────

describe("formatStatsJson", () => {
  it("returns valid JSON matching the schema", () => {
    const stats: StageStats[] = [
      { stage: "questions", count: 2, avgDurationSeconds: 83, avgTurns: 4.2, avgCostUsd: 0.042, totalCostUsd: 0.084 },
    ];
    const summary: PipelineSummary = {
      totalRuns: 2,
      avgTotalDurationSeconds: 83,
      avgTotalCostUsd: 0.042,
      avgTotalTurns: 4.2,
      mostExpensiveStage: "questions",
    };

    const jsonStr = formatStatsJson(stats, summary);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0].stage).toBe("questions");
    expect(parsed.stages[0].count).toBe(2);
    expect(parsed.stages[0].avgDurationSeconds).toBe(83);
    expect(parsed.stages[0].avgTurns).toBe(4.2);
    expect(parsed.stages[0].avgCostUsd).toBe(0.042);
    expect(parsed.stages[0].totalCostUsd).toBe(0.084);

    expect(parsed.summary.totalRuns).toBe(2);
    expect(parsed.summary.avgTotalDurationSeconds).toBe(83);
    expect(parsed.summary.avgTotalCostUsd).toBe(0.042);
    expect(parsed.summary.avgTotalTurns).toBe(4.2);
    expect(parsed.summary.mostExpensiveStage).toBe("questions");
  });

  it("does NOT include inputTokens or outputTokens in output", () => {
    const stats: StageStats[] = [
      { stage: "impl", count: 1, avgDurationSeconds: 100, avgTurns: 5, avgCostUsd: 0.1, totalCostUsd: 0.1 },
    ];
    const summary: PipelineSummary = {
      totalRuns: 1,
      avgTotalDurationSeconds: 100,
      avgTotalCostUsd: 0.1,
      avgTotalTurns: 5,
      mostExpensiveStage: "impl",
    };

    const jsonStr = formatStatsJson(stats, summary);
    expect(jsonStr).not.toContain("inputTokens");
    expect(jsonStr).not.toContain("outputTokens");
  });
});

// ─── executeStats (command handler) ─────────────────────────────────────────

describe("executeStats", () => {
  let TEST_DIR: string;
  let interactionsDir: string;

  beforeEach(() => {
    TEST_DIR = join(tmpdir(), `shkmn-stats-cmd-${randomUUID()}`);
    interactionsDir = join(TEST_DIR, "interactions");
    mkdirSync(interactionsDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("prints 'No pipeline data found.' when interactions dir is empty", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: false });

    expect(consoleSpy).toHaveBeenCalledWith("No pipeline data found.");

  });

  it("prints 'No completed stage data found.' when only agent_started entries exist", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_started","slug":"task-a","stage":"questions"}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: false });

    expect(consoleSpy).toHaveBeenCalledWith("No completed stage data found.");

  });

  it("prints 'No data found for task: ...' when --task slug matches nothing", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"task-a","stage":"questions","durationSeconds":60,"costUsd":0.05,"turns":3,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: false, task: "nonexistent-slug" });

    expect(consoleSpy).toHaveBeenCalledWith("No data found for task: nonexistent-slug");

  });

  it("outputs formatted table for valid data", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"task-a","stage":"questions","durationSeconds":60,"costUsd":0.05,"turns":3,"success":true}\n' +
      '{"timestamp":"2026-04-01T11:00:00.000Z","type":"agent_completed","slug":"task-a","stage":"research","durationSeconds":200,"costUsd":0.15,"turns":10,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: false });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("questions");
    expect(output).toContain("research");
    expect(output).toContain("TOTAL");

  });

  it("outputs valid JSON when --json is set", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"task-a","stage":"questions","durationSeconds":60,"costUsd":0.05,"turns":3,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: true });

    const jsonStr = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(jsonStr);
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0].stage).toBe("questions");
    expect(parsed.summary.totalRuns).toBe(1);

  });

  it("filters by --task slug", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"task-a","stage":"questions","durationSeconds":60,"costUsd":0.05,"turns":3,"success":true}\n' +
      '{"timestamp":"2026-04-01T11:00:00.000Z","type":"agent_completed","slug":"task-b","stage":"questions","durationSeconds":80,"costUsd":0.08,"turns":5,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: true, task: "task-a" });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.stages[0].count).toBe(1);
    expect(parsed.stages[0].avgCostUsd).toBeCloseTo(0.05);

  });

  it("filters by --from and --to date range", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"t","stage":"questions","durationSeconds":60,"costUsd":0.05,"turns":3,"success":true}\n',
    );
    writeFileSync(
      join(interactionsDir, "2026-04-05.jsonl"),
      '{"timestamp":"2026-04-05T10:00:00.000Z","type":"agent_completed","slug":"t","stage":"research","durationSeconds":120,"costUsd":0.10,"turns":7,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: true, from: "2026-04-03", to: "2026-04-06" });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0].stage).toBe("research");

  });

  it("handles backward compat with tokensUsed field name", () => {
    writeFileSync(
      join(interactionsDir, "2026-04-01.jsonl"),
      '{"timestamp":"2026-04-01T10:00:00.000Z","type":"agent_completed","slug":"t","stage":"questions","durationSeconds":60,"tokensUsed":0.05,"turns":3,"success":true}\n',
    );
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    executeStats({ runtimeDir: TEST_DIR, json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.stages[0].avgCostUsd).toBeCloseTo(0.05);

  });
});
