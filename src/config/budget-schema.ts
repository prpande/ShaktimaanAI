import { z } from "zod";

const modelBudgetSchema = z.object({
  weekly_token_limit: z.number().positive(),
  daily_token_limit: z.number().positive(),
  session_token_limit: z.number().positive(),
  per_task_token_limit: z.number().positive(),
});

const peakHoursSchema = z.object({
  start_utc: z.string().regex(/^\d{2}:\d{2}$/),
  end_utc: z.string().regex(/^\d{2}:\d{2}$/),
  multiplier: z.number().min(0).max(1),
});

export const budgetConfigSchema = z.object({
  model_budgets: z.record(z.string(), modelBudgetSchema),
  peak_hours: peakHoursSchema,
  safety_margin: z.number().min(0).max(0.5),
});

export type BudgetConfig = z.infer<typeof budgetConfigSchema>;
export type ModelBudget = z.infer<typeof modelBudgetSchema>;
