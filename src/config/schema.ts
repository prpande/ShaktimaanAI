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
  }).optional().default({}),
  agents: z.object({
    names: z.record(z.string(), z.string()).optional().default({}),
    defaultStages: z.array(z.string()).optional(),
    defaultReviewAfter: z.string().optional(),
    maxConcurrentTotal: z.number().optional(),
    maxConcurrentValidate: z.number().optional(),
    maxTurns: z.record(z.string(), z.number()).optional(),
    timeoutsMinutes: z.record(z.string(), z.number()).optional(),
    heartbeatTimeoutMinutes: z.number().optional(),
    retryCount: z.number().optional(),
  }).optional().default({}),
  schedule: z.object({
    rollupTime: z.string().optional(),
    notionPushDay: z.string().optional(),
    notionPushTime: z.string().optional(),
    monthlyReportDay: z.number().optional(),
    monthlyReportTime: z.string().optional(),
  }).optional().default({}),
});

export type ConfigInput = z.input<typeof configSchema>;
export type ConfigParsed = z.output<typeof configSchema>;
