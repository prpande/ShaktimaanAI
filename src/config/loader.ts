import { readFileSync } from "node:fs";
import { configSchema, type ConfigParsed } from "./schema.js";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES, type ShkmnConfig } from "./defaults.js";

/**
 * A fully resolved config with all fields present (no optionals).
 * Alias for ShkmnConfig — single source of truth lives in defaults.ts.
 */
export type ResolvedConfig = ShkmnConfig;

/**
 * Reads a JSON config file from disk, validates with the Zod schema, and
 * returns a fully resolved config merged with defaults.
 */
export function loadConfig(configPath: string): ResolvedConfig {
  let raw: string;
  raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file as JSON at "${configPath}": ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
        return `${path}${i.message}`;
      })
      .join("; ");
    throw new Error(`Invalid config at "${configPath}": ${messages}`);
  }

  return resolveConfig(result.data);
}

/**
 * Merges a validated (Zod-parsed) config with defaults to produce a
 * fully resolved config with all fields present.
 */
export function resolveConfig(parsed: ConfigParsed): ResolvedConfig {
  const d = DEFAULT_CONFIG;
  const da = d.agents;

  return {
    pipeline: {
      runtimeDir: parsed.pipeline.runtimeDir,
      agentsDir: parsed.pipeline.agentsDir ?? d.pipeline.agentsDir,
      dashboardRepoLocal: parsed.pipeline.dashboardRepoLocal ?? d.pipeline.dashboardRepoLocal,
      dashboardRepoUrl: parsed.pipeline.dashboardRepoUrl ?? d.pipeline.dashboardRepoUrl,
    },
    repos: {
      root: parsed.repos?.root ?? d.repos.root,
      aliases: parsed.repos?.aliases ?? d.repos.aliases,
    },
    ado: {
      org: parsed.ado?.org ?? d.ado.org,
      project: parsed.ado?.project ?? d.ado.project,
      defaultArea: parsed.ado?.defaultArea ?? d.ado.defaultArea,
    },
    slack: {
      enabled: parsed.slack?.enabled ?? d.slack.enabled,
      channel: parsed.slack?.channel ?? d.slack.channel,
      channelId: parsed.slack?.channelId ?? d.slack.channelId,
      pollIntervalActiveSec: parsed.slack?.pollIntervalActiveSec ?? d.slack.pollIntervalActiveSec,
      pollIntervalIdleSec: parsed.slack?.pollIntervalIdleSec ?? d.slack.pollIntervalIdleSec,
      notifyLevel: parsed.slack?.notifyLevel ?? d.slack.notifyLevel,
      allowDMs: parsed.slack?.allowDMs ?? d.slack.allowDMs,
      requirePrefix: parsed.slack?.requirePrefix ?? d.slack.requirePrefix,
      prefix: parsed.slack?.prefix ?? d.slack.prefix,
      dmUserIds: parsed.slack?.dmUserIds ?? d.slack.dmUserIds,
    },
    agents: {
      names: { ...DEFAULT_AGENT_NAMES, ...parsed.agents?.names },
      defaultStages: parsed.agents?.defaultStages ?? [...da.defaultStages],
      defaultReviewAfter: parsed.agents?.defaultReviewAfter ?? da.defaultReviewAfter,
      maxConcurrentTotal: parsed.agents?.maxConcurrentTotal ?? da.maxConcurrentTotal,
      maxTurns: { ...da.maxTurns, ...parsed.agents?.maxTurns },
      timeoutsMinutes: { ...da.timeoutsMinutes, ...parsed.agents?.timeoutsMinutes },
      heartbeatTimeoutMinutes: parsed.agents?.heartbeatTimeoutMinutes ?? da.heartbeatTimeoutMinutes,
      retryCount: parsed.agents?.retryCount ?? da.retryCount,
      maxValidateRetries: parsed.agents?.maxValidateRetries ?? da.maxValidateRetries,
      maxSuggestionRetriesPerCycle: parsed.agents?.maxSuggestionRetriesPerCycle ?? da.maxSuggestionRetriesPerCycle,
      tools: { ...da.tools, ...parsed.agents?.tools },
      models: { ...da.models, ...parsed.agents?.models },
    },
    schedule: {
      rollupTime: parsed.schedule?.rollupTime ?? d.schedule.rollupTime,
      notionPushDay: parsed.schedule?.notionPushDay ?? d.schedule.notionPushDay,
      notionPushTime: parsed.schedule?.notionPushTime ?? d.schedule.notionPushTime,
      monthlyReportDay: parsed.schedule?.monthlyReportDay ?? d.schedule.monthlyReportDay,
      monthlyReportTime: parsed.schedule?.monthlyReportTime ?? d.schedule.monthlyReportTime,
    },
    worktree: {
      retentionDays: parsed.worktree?.retentionDays ?? d.worktree.retentionDays,
      cleanupOnStartup: parsed.worktree?.cleanupOnStartup ?? d.worktree.cleanupOnStartup,
    },
    review: {
      enforceSuggestions: parsed.review?.enforceSuggestions ?? d.review.enforceSuggestions,
    },
    quickTask: {
      requireReview: parsed.quickTask?.requireReview ?? d.quickTask.requireReview,
    },
  };
}

/**
 * Loads a .env file into process.env without overwriting existing variables.
 * Silently does nothing if the file does not exist.
 */
export function loadEnvFile(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    // File not found or unreadable — silently skip
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
