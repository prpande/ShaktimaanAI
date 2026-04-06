import { z } from "zod";

const repoAliasSchema = z.object({
  path: z.string(),
  sequentialBuild: z.boolean().optional(),
});

export const configSchema = z.object({
  pipeline: z.object({
    runtimeDir: z.string().min(1, "pipeline.runtimeDir is required"),
    agentsDir: z.string().optional().default(""),
    dashboardRepoLocal: z.string().optional().default(""),
    dashboardRepoUrl: z.string().optional().default(""),
  }),
  repos: z.object({
    root: z.string().optional().default(""),
    aliases: z.record(z.string(), repoAliasSchema).optional().default({}),
  }).optional().default({}),
  ado: z.object({
    org: z.string().optional().default(""),
    project: z.string().optional().default(""),
    defaultArea: z.string().optional().default(""),
  }).optional().default({}),
  slack: z.object({
    enabled: z.boolean().optional().default(false),
    channel: z.string().optional().default("#agent-pipeline"),
    channelId: z.string().optional().default(""),
    pollIntervalSeconds: z.number().optional().default(30),
    notifyLevel: z.enum(["minimal", "bookends", "stages"]).optional().default("bookends"),
    allowDMs: z.boolean().optional().default(false),
    requirePrefix: z.boolean().optional().default(true),
    prefix: z.string().optional().default("shkmn"),
  }).optional().default({}),
  quickTask: z.object({
    requireReview: z.boolean().optional().default(true),
    complexityThreshold: z.number().min(0).max(1).optional().default(0.8),
  }).optional().default({}),
  agents: z.object({
    names: z.record(z.string(), z.string()).optional().default({}),
    defaultStages: z.array(z.string()).optional(),
    defaultReviewAfter: z.string().optional(),
    maxConcurrentTotal: z.number().optional(),
    maxTurns: z.record(z.string(), z.number()).optional(),
    timeoutsMinutes: z.record(z.string(), z.number()).optional(),
    heartbeatTimeoutMinutes: z.number().optional(),
    retryCount: z.number().optional(),
    maxValidateRetries: z.number().optional(),
    maxSuggestionRetriesPerCycle: z.number().optional(),
    tools: z.record(z.string(), z.object({
      allowed: z.array(z.string()).optional(),
      disallowed: z.array(z.string()).optional(),
    })).optional().default({}),
    models: z.record(z.string(), z.string()).optional().default({}),
  }).optional().default({}),
  schedule: z.object({
    rollupTime: z.string().optional(),
    notionPushDay: z.string().optional(),
    notionPushTime: z.string().optional(),
    monthlyReportDay: z.number().optional(),
    monthlyReportTime: z.string().optional(),
  }).optional().default({}),
  worktree: z.object({
    retentionDays: z.number().optional().default(7),
    cleanupOnStartup: z.boolean().optional().default(true),
  }).optional().default({}),
  review: z.object({
    enforceSuggestions: z.boolean().optional().default(true),
  }).optional().default({}),
});

export type ConfigInput = z.input<typeof configSchema>;
export type ConfigParsed = z.output<typeof configSchema>;
