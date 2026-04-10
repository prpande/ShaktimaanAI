import type { Command } from "commander";
import { join } from "node:path";
import type { DailyLogEntry } from "../core/interactions.js";
import { readAllDailyLogs } from "../core/interactions.js";
import { PIPELINE_STAGES } from "../core/stage-map.js";
import { findConfigPath, loadConfig } from "../config/loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed and validated agent_completed log entry. */
export interface CompletedLogEntry {
  timestamp: string;
  slug: string;
  stage: string;
  durationSeconds: number;
  costUsd: number;
  turns: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregated stats for a single pipeline stage. */
export interface StageStats {
  stage: string;
  count: number;
  avgDurationSeconds: number;
  avgTurns: number;
  avgCostUsd: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  dominantModel: string;
}

/** Summary across all pipeline runs. */
export interface PipelineSummary {
  totalRuns: number;
  avgTotalDurationSeconds: number;
  avgTotalCostUsd: number;
  avgTotalTurns: number;
  mostExpensiveStage: string;
}

// ---------------------------------------------------------------------------
// parseCompletedEntry
// ---------------------------------------------------------------------------

/**
 * Validates and extracts a CompletedLogEntry from a raw DailyLogEntry.
 * Returns null if the entry is not a valid, successful agent_completed entry.
 * Supports backward compat: reads `tokensUsed` if `costUsd` is absent.
 */
export function parseCompletedEntry(entry: DailyLogEntry): CompletedLogEntry | null {
  if (entry.type !== "agent_completed") return null;
  if (entry.success !== true) return null;
  if (typeof entry.stage !== "string") return null;

  // Backward compat: old logs have tokensUsed (which stored costUsd)
  const costUsd = typeof entry.costUsd === "number"
    ? entry.costUsd
    : typeof entry.tokensUsed === "number"
      ? entry.tokensUsed
      : 0;

  const durationSeconds = typeof entry.durationSeconds === "number" ? entry.durationSeconds : 0;
  const turns = typeof entry.turns === "number" ? entry.turns : 0;
  const model = typeof entry.model === "string" ? entry.model : "";
  const inputTokens = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const outputTokens = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;

  return {
    timestamp: entry.timestamp,
    slug: entry.slug,
    stage: entry.stage,
    durationSeconds,
    costUsd,
    turns,
    model,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// aggregateStageStats
// ---------------------------------------------------------------------------

/**
 * Groups completed entries by stage and computes per-stage averages.
 * Output is ordered by PIPELINE_STAGES, with unknown stages appended.
 */
export function aggregateStageStats(entries: CompletedLogEntry[]): StageStats[] {
  if (entries.length === 0) return [];

  // Group by stage
  const groups = new Map<string, CompletedLogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.stage) ?? [];
    list.push(entry);
    groups.set(entry.stage, list);
  }

  // Compute stats per stage
  const statsMap = new Map<string, StageStats>();
  for (const [stage, stageEntries] of groups) {
    const count = stageEntries.length;
    const totalDuration = stageEntries.reduce((sum, e) => sum + e.durationSeconds, 0);
    const totalCost = stageEntries.reduce((sum, e) => sum + e.costUsd, 0);
    const totalTurns = stageEntries.reduce((sum, e) => sum + e.turns, 0);
    const totalInput = stageEntries.reduce((sum, e) => sum + e.inputTokens, 0);
    const totalOutput = stageEntries.reduce((sum, e) => sum + e.outputTokens, 0);

    // Find dominant model (most frequently used for this stage)
    const modelCounts = new Map<string, number>();
    for (const e of stageEntries) {
      if (e.model) modelCounts.set(e.model, (modelCounts.get(e.model) ?? 0) + 1);
    }
    let dominantModel = "";
    let maxCount = 0;
    for (const [m, c] of modelCounts) {
      if (c > maxCount) { dominantModel = m; maxCount = c; }
    }

    statsMap.set(stage, {
      stage,
      count,
      avgDurationSeconds: totalDuration / count,
      avgTurns: totalTurns / count,
      avgCostUsd: totalCost / count,
      totalCostUsd: totalCost,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      dominantModel,
    });
  }

  // Order by PIPELINE_STAGES, unknown stages appended
  const ordered: StageStats[] = [];
  for (const stage of PIPELINE_STAGES) {
    const s = statsMap.get(stage);
    if (s) {
      ordered.push(s);
      statsMap.delete(stage);
    }
  }
  // Append any remaining (unknown) stages in alphabetical order
  const remaining = [...statsMap.values()].sort((a, b) => a.stage.localeCompare(b.stage));
  ordered.push(...remaining);

  return ordered;
}

// ---------------------------------------------------------------------------
// computePipelineSummary
// ---------------------------------------------------------------------------

/**
 * Computes pipeline-wide summary: per-run totals averaged across all runs.
 * A "run" is identified by a unique slug.
 */
export function computePipelineSummary(
  entries: CompletedLogEntry[],
  stageStats: StageStats[],
): PipelineSummary {
  if (entries.length === 0 || stageStats.length === 0) {
    return {
      totalRuns: 0,
      avgTotalDurationSeconds: 0,
      avgTotalCostUsd: 0,
      avgTotalTurns: 0,
      mostExpensiveStage: "N/A",
    };
  }

  // Group entries by slug (pipeline run)
  const runs = new Map<string, CompletedLogEntry[]>();
  for (const entry of entries) {
    const list = runs.get(entry.slug) ?? [];
    list.push(entry);
    runs.set(entry.slug, list);
  }

  const totalRuns = runs.size;
  let sumDuration = 0;
  let sumCost = 0;
  let sumTurns = 0;

  for (const runEntries of runs.values()) {
    sumDuration += runEntries.reduce((s, e) => s + e.durationSeconds, 0);
    sumCost += runEntries.reduce((s, e) => s + e.costUsd, 0);
    sumTurns += runEntries.reduce((s, e) => s + e.turns, 0);
  }

  // Find most expensive stage by avgCostUsd
  const mostExpensive = stageStats.reduce((max, s) =>
    s.avgCostUsd > max.avgCostUsd ? s : max,
  );

  return {
    totalRuns,
    avgTotalDurationSeconds: sumDuration / totalRuns,
    avgTotalCostUsd: sumCost / totalRuns,
    avgTotalTurns: sumTurns / totalRuns,
    mostExpensiveStage: mostExpensive.stage,
  };
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

/** Formats seconds into a human-readable duration string. */
export function formatDuration(seconds: number): string {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// formatStatsTable
// ---------------------------------------------------------------------------

/** Formats a cost value with dollar sign. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

/** Formats token counts with K/M suffixes. */
function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/**
 * Renders a formatted ASCII table to stdout.
 * Uses padEnd/padStart for alignment — no external library.
 */
export function formatStatsTable(stats: StageStats[], summary: PipelineSummary): string {
  const COL = {
    stage: 14,
    runs: 7,
    model: 9,
    time: 12,
    turns: 11,
    tokens: 12,
    avgCost: 11,
    totalCost: 12,
  };

  const header =
    "Stage".padEnd(COL.stage) +
    "Runs".padStart(COL.runs) +
    "Model".padStart(COL.model) +
    "Avg Time".padStart(COL.time) +
    "Avg Turns".padStart(COL.turns) +
    "Tokens".padStart(COL.tokens) +
    "Avg Cost".padStart(COL.avgCost) +
    "Total Cost".padStart(COL.totalCost);

  const sep =
    "─".repeat(COL.stage) +
    "  " + "─".repeat(COL.runs - 2) +
    "  " + "─".repeat(COL.model - 2) +
    "  " + "─".repeat(COL.time - 2) +
    "  " + "─".repeat(COL.turns - 2) +
    "  " + "─".repeat(COL.tokens - 2) +
    "  " + "─".repeat(COL.avgCost - 2) +
    "  " + "─".repeat(COL.totalCost - 2);

  const lines: string[] = [header, sep];

  for (const s of stats) {
    const totalTokens = s.totalInputTokens + s.totalOutputTokens;
    lines.push(
      s.stage.padEnd(COL.stage) +
      String(s.count).padStart(COL.runs) +
      s.dominantModel.padStart(COL.model) +
      formatDuration(s.avgDurationSeconds).padStart(COL.time) +
      s.avgTurns.toFixed(1).padStart(COL.turns) +
      formatTokens(totalTokens).padStart(COL.tokens) +
      formatCost(s.avgCostUsd).padStart(COL.avgCost) +
      formatCost(s.totalCostUsd).padStart(COL.totalCost),
    );
  }

  lines.push(sep);

  const grandTotalTokens = stats.reduce((sum, s) => sum + s.totalInputTokens + s.totalOutputTokens, 0);

  // TOTAL row
  lines.push(
    "TOTAL".padEnd(COL.stage) +
    String(summary.totalRuns).padStart(COL.runs) +
    "".padStart(COL.model) +
    formatDuration(summary.avgTotalDurationSeconds).padStart(COL.time) +
    summary.avgTotalTurns.toFixed(1).padStart(COL.turns) +
    formatTokens(grandTotalTokens).padStart(COL.tokens) +
    formatCost(summary.avgTotalCostUsd).padStart(COL.avgCost) +
    formatCost(stats.reduce((sum, s) => sum + s.totalCostUsd, 0)).padStart(COL.totalCost),
  );

  // Most expensive stage row
  lines.push(
    "Most $$".padEnd(COL.stage) +
    "".padStart(COL.runs) +
    "".padStart(COL.model) +
    "".padStart(COL.time) +
    "".padStart(COL.turns) +
    "".padStart(COL.tokens) +
    "".padStart(COL.avgCost) +
    summary.mostExpensiveStage.padStart(COL.totalCost),
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// formatStatsJson
// ---------------------------------------------------------------------------

/** Returns JSON string matching the stats schema. */
export function formatStatsJson(stats: StageStats[], summary: PipelineSummary): string {
  return JSON.stringify({ stages: stats, summary }, null, 2);
}

// ---------------------------------------------------------------------------
// executeStats — testable command logic
// ---------------------------------------------------------------------------

export interface StatsOptions {
  runtimeDir: string;
  json: boolean;
  task?: string;
  from?: string;
  to?: string;
}

/** Core stats logic, separated from Commander for testability. */
export function executeStats(options: StatsOptions): void {
  const interactionsDir = join(options.runtimeDir, "interactions");

  // Read all daily logs with optional date range
  const allEntries = readAllDailyLogs(interactionsDir, {
    from: options.from,
    to: options.to,
  });

  if (allEntries.length === 0) {
    console.log("No pipeline data found.");
    return;
  }

  // Parse and filter to agent_completed entries only
  let completed = allEntries
    .map(parseCompletedEntry)
    .filter((e): e is CompletedLogEntry => e !== null);

  if (completed.length === 0) {
    console.log("No completed stage data found.");
    return;
  }

  // Filter by task slug if specified
  if (options.task) {
    completed = completed.filter((e) => e.slug === options.task);
    if (completed.length === 0) {
      console.log(`No data found for task: ${options.task}`);
      return;
    }
  }

  const stageStats = aggregateStageStats(completed);
  const summary = computePipelineSummary(completed, stageStats);

  if (options.json) {
    console.log(formatStatsJson(stageStats, summary));
  } else {
    console.log(formatStatsTable(stageStats, summary));
  }
}

// ---------------------------------------------------------------------------
// registerStatsCommand
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const date = new Date(dateStr + "T00:00:00Z");
  if (isNaN(date.getTime())) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show pipeline stage statistics — duration, turns, and cost averages")
    .option("--json", "Output as JSON", false)
    .option("--task <slug>", "Filter to a specific task slug")
    .option("--from <date>", "Start date (YYYY-MM-DD, inclusive)")
    .option("--to <date>", "End date (YYYY-MM-DD, inclusive)")
    .action((opts: { json: boolean; task?: string; from?: string; to?: string }) => {
      if (opts.from && !isValidCalendarDate(opts.from)) {
        console.error("Invalid date for --from. Must be a valid calendar date (YYYY-MM-DD).");
        process.exit(1);
      }
      if (opts.to && !isValidCalendarDate(opts.to)) {
        console.error("Invalid date for --to. Must be a valid calendar date (YYYY-MM-DD).");
        process.exit(1);
      }

      const configPath = findConfigPath();
      const config = loadConfig(configPath);

      executeStats({
        runtimeDir: config.pipeline.runtimeDir,
        json: opts.json,
        task: opts.task,
        from: opts.from,
        to: opts.to,
      });
    });
}
