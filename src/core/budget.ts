import type { BudgetConfig } from "../config/budget-schema.js";
import type { ResolvedConfig } from "../config/loader.js";
import type { CompletedStage } from "./types.js";
import type { DailyLogEntry } from "./interactions.js";
import { readAllDailyLogs } from "./interactions.js";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SessionTokenTracker {
  tokens: Record<string, number>;
  addUsage(model: string, tokens: number): void;
  getUsage(model: string): number;
  reset(): void;
}

export interface BudgetStatus {
  model: string;
  weeklyUsed: number;
  weeklyLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  sessionUsed: number;
  sessionLimit: number;
  taskUsed: number;
  taskLimit: number;
  isOverLimit: boolean;
  limitBreached: "weekly" | "daily" | "session" | "task" | null;
  effectiveMultiplier: number;
}

export type ModelResolution =
  | { action: "use"; model: string }
  | { action: "downgrade"; model: string; reason: string }
  | { action: "hold"; reason: string };

export interface BudgetCheckContext {
  interactionsDir: string;
  sessionTracker: SessionTokenTracker;
  taskCompletedStages: CompletedStage[];
  today?: Date;
}

// ─── Session Tracker ────────────────────────────────────────────────────────

export function createSessionTracker(): SessionTokenTracker {
  const tokens: Record<string, number> = {};
  return {
    tokens,
    addUsage(model: string, count: number): void {
      tokens[model] = (tokens[model] ?? 0) + count;
    },
    getUsage(model: string): number {
      return tokens[model] ?? 0;
    },
    reset(): void {
      for (const key of Object.keys(tokens)) {
        delete tokens[key];
      }
    },
  };
}

// ─── Peak Hours ─────────────────────────────────────────────────────────────

export function isPeakHour(config: BudgetConfig, now?: Date): boolean {
  const d = now ?? new Date();
  const currentMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();

  const [startH, startM] = config.peak_hours.start_utc.split(":").map(Number);
  const [endH, endM] = config.peak_hours.end_utc.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ─── Effective Limit ────────────────────────────────────────────────────────

export function getEffectiveLimit(
  baseLimit: number,
  safetyMargin: number,
  isPeak: boolean,
  peakMultiplier: number,
): number {
  const multiplier = isPeak ? peakMultiplier : 1.0;
  return baseLimit * multiplier * (1 - safetyMargin);
}

// ─── Aggregation Functions ──────────────────────────────────────────────────

export function aggregateDailyTokens(
  entries: DailyLogEntry[],
  model: string,
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== "agent_completed") continue;
    if (entry.model !== model) continue;
    const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
    const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
    total += input + output;
  }
  return total;
}

function getISOWeekMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function aggregateWeeklyTokens(
  interactionsDir: string,
  model: string,
  today?: Date,
): number {
  const now = today ?? new Date();
  const monday = getISOWeekMonday(now);
  const from = formatDate(monday);
  const to = formatDate(now);

  let entries: DailyLogEntry[];
  try {
    entries = readAllDailyLogs(interactionsDir, { from, to });
  } catch {
    return 0;
  }

  return aggregateDailyTokens(entries, model);
}

export function aggregateTaskTokens(
  completedStages: CompletedStage[],
  model: string,
): number {
  let total = 0;
  for (const stage of completedStages) {
    if (stage.model !== model) continue;
    total += (stage.inputTokens ?? 0) + (stage.outputTokens ?? 0);
  }
  return total;
}

// ─── Budget Check ───────────────────────────────────────────────────────────

export function checkBudget(
  model: string,
  budgetConfig: BudgetConfig,
  context: BudgetCheckContext,
): BudgetStatus {
  const modelBudget = budgetConfig.model_budgets[model];

  // Fail-open: if model not in config, treat as unlimited
  if (!modelBudget) {
    return {
      model,
      weeklyUsed: 0, weeklyLimit: Infinity,
      dailyUsed: 0, dailyLimit: Infinity,
      sessionUsed: 0, sessionLimit: Infinity,
      taskUsed: 0, taskLimit: Infinity,
      isOverLimit: false,
      limitBreached: null,
      effectiveMultiplier: 1.0,
    };
  }

  const now = context.today ?? new Date();
  const peak = isPeakHour(budgetConfig, now);
  const peakMult = budgetConfig.peak_hours.multiplier;
  const margin = budgetConfig.safety_margin;

  const weeklyLimit = getEffectiveLimit(modelBudget.weekly_token_limit, margin, peak, peakMult);
  const dailyLimit = getEffectiveLimit(modelBudget.daily_token_limit, margin, peak, peakMult);
  const sessionLimit = getEffectiveLimit(modelBudget.session_token_limit, margin, peak, peakMult);
  const taskLimit = getEffectiveLimit(modelBudget.per_task_token_limit, margin, peak, peakMult);

  const weeklyUsed = aggregateWeeklyTokens(context.interactionsDir, model, now);

  const todayStr = formatDate(now);
  let dailyUsed: number;
  try {
    const entries = readAllDailyLogs(context.interactionsDir, { from: todayStr, to: todayStr });
    dailyUsed = aggregateDailyTokens(entries, model);
  } catch {
    dailyUsed = 0;
  }

  const sessionUsed = context.sessionTracker.getUsage(model);
  const taskUsed = aggregateTaskTokens(context.taskCompletedStages, model);

  // Check limits in priority order: task > session > daily > weekly
  let limitBreached: BudgetStatus["limitBreached"] = null;
  if (taskUsed >= taskLimit) limitBreached = "task";
  else if (sessionUsed >= sessionLimit) limitBreached = "session";
  else if (dailyUsed >= dailyLimit) limitBreached = "daily";
  else if (weeklyUsed >= weeklyLimit) limitBreached = "weekly";

  return {
    model,
    weeklyUsed, weeklyLimit,
    dailyUsed, dailyLimit,
    sessionUsed, sessionLimit,
    taskUsed, taskLimit,
    isOverLimit: limitBreached !== null,
    limitBreached,
    effectiveMultiplier: peak ? peakMult : 1.0,
  };
}

// ─── Model Resolution ───────────────────────────────────────────────────────

function formatBudgetReason(status: BudgetStatus): string {
  if (!status.limitBreached) return "";
  const used = {
    weekly: status.weeklyUsed, daily: status.dailyUsed,
    session: status.sessionUsed, task: status.taskUsed,
  }[status.limitBreached];
  const limit = {
    weekly: status.weeklyLimit, daily: status.dailyLimit,
    session: status.sessionLimit, task: status.taskLimit,
  }[status.limitBreached];
  const pct = Math.round((used / limit) * 100);
  return `${status.model} ${status.limitBreached} limit at ${pct}%`;
}

export function resolveModelForStage(
  stage: string,
  config: ResolvedConfig,
  budgetConfig: BudgetConfig,
  context: BudgetCheckContext,
): ModelResolution {
  const preferredModel = config.agents.models?.[stage] ?? "sonnet";

  // Fail-open: model not in budget config = no limits
  if (!budgetConfig.model_budgets[preferredModel]) {
    return { action: "use", model: preferredModel };
  }

  const status = checkBudget(preferredModel, budgetConfig, context);

  if (!status.isOverLimit) {
    return { action: "use", model: preferredModel };
  }

  // If preferred model is over budget, try downgrade from opus to sonnet
  if (preferredModel === "opus") {
    const sonnetStatus = checkBudget("sonnet", budgetConfig, context);
    if (!sonnetStatus.isOverLimit) {
      return {
        action: "downgrade",
        model: "sonnet",
        reason: `${formatBudgetReason(status)} — downgrading to sonnet`,
      };
    }
    return {
      action: "hold",
      reason: `${formatBudgetReason(status)}; sonnet also over limit (${formatBudgetReason(sonnetStatus)})`,
    };
  }

  return {
    action: "hold",
    reason: formatBudgetReason(status),
  };
}
