import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBudgetConfig } from "../../src/config/loader.js";
import { DEFAULT_BUDGET_CONFIG } from "../../src/config/defaults.js";

describe("loadBudgetConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `shkmn-test-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_BUDGET_CONFIG when usage-budget.json does not exist", () => {
    const budgetFile = join(tempDir, "usage-budget.json");
    const result = loadBudgetConfig(budgetFile);
    expect(result).toEqual(DEFAULT_BUDGET_CONFIG);
  });

  it("returns parsed config when usage-budget.json is valid", () => {
    const customConfig = {
      model_budgets: {
        sonnet: {
          weekly_token_limit: 10_000_000,
          daily_token_limit: 2_000_000,
          session_token_limit: 500_000,
          per_task_token_limit: 150_000,
        },
      },
      peak_hours: { start_utc: "14:00", end_utc: "20:00", multiplier: 0.3 },
      safety_margin: 0.1,
    };
    const budgetFile = join(tempDir, "usage-budget.json");
    writeFileSync(budgetFile, JSON.stringify(customConfig));
    const result = loadBudgetConfig(budgetFile);
    expect(result.model_budgets.sonnet.weekly_token_limit).toBe(10_000_000);
    expect(result.peak_hours.multiplier).toBe(0.3);
    expect(result.safety_margin).toBe(0.1);
  });

  it("throws when usage-budget.json contains invalid config", () => {
    const invalidConfig = { model_budgets: "not-an-object" };
    const budgetFile = join(tempDir, "usage-budget.json");
    writeFileSync(budgetFile, JSON.stringify(invalidConfig));
    expect(() => loadBudgetConfig(budgetFile)).toThrow(tempDir);
  });

  it("throws when usage-budget.json is not valid JSON", () => {
    const budgetFile = join(tempDir, "usage-budget.json");
    writeFileSync(budgetFile, "not json {{{");
    expect(() => loadBudgetConfig(budgetFile)).toThrow("Failed to parse");
  });
});
