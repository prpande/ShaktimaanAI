import { describe, it, expect } from "vitest";
import { budgetConfigSchema, type BudgetConfig } from "../../src/config/budget-schema.js";
import { DEFAULT_BUDGET_CONFIG } from "../../src/config/defaults.js";

const validConfig: BudgetConfig = {
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
  peak_hours: {
    start_utc: "12:00",
    end_utc: "18:00",
    multiplier: 0.5,
  },
  safety_margin: 0.15,
};

describe("budgetConfigSchema", () => {
  it("parses a valid config with all required fields", () => {
    const result = budgetConfigSchema.parse(validConfig);
    expect(result.model_budgets).toHaveProperty("sonnet");
    expect(result.model_budgets).toHaveProperty("opus");
  });

  it("throws ZodError when model_budgets is missing", () => {
    const bad = { peak_hours: validConfig.peak_hours, safety_margin: 0.15 };
    expect(() => budgetConfigSchema.parse(bad)).toThrow();
  });

  it("throws when peak_hours.multiplier exceeds 1", () => {
    const bad = {
      ...validConfig,
      peak_hours: { ...validConfig.peak_hours, multiplier: 1.5 },
    };
    expect(() => budgetConfigSchema.parse(bad)).toThrow();
  });

  it("throws when peak_hours.start_utc is non-padded (9:00)", () => {
    const bad = {
      ...validConfig,
      peak_hours: { ...validConfig.peak_hours, start_utc: "9:00" },
    };
    expect(() => budgetConfigSchema.parse(bad)).toThrow();
  });

  it("throws when safety_margin exceeds 0.5", () => {
    const bad = { ...validConfig, safety_margin: 0.6 };
    expect(() => budgetConfigSchema.parse(bad)).toThrow();
  });

  it("throws when safety_margin is negative", () => {
    const bad = { ...validConfig, safety_margin: -0.1 };
    expect(() => budgetConfigSchema.parse(bad)).toThrow();
  });
});

describe("DEFAULT_BUDGET_CONFIG", () => {
  it("passes budgetConfigSchema validation", () => {
    const result = budgetConfigSchema.parse(DEFAULT_BUDGET_CONFIG);
    expect(result.model_budgets).toHaveProperty("sonnet");
    expect(result.model_budgets).toHaveProperty("opus");
  });

  it("has opus.weekly_token_limit of 5_000_000", () => {
    expect(DEFAULT_BUDGET_CONFIG.model_budgets.opus.weekly_token_limit).toBe(5_000_000);
  });

  it("has safety_margin of 0.15", () => {
    expect(DEFAULT_BUDGET_CONFIG.safety_margin).toBe(0.15);
  });
});
