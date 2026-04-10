import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { intro, text, confirm, select, outro, isCancel, log } from "@clack/prompts";
import { DEFAULT_CONFIG, DEFAULT_AGENT_NAMES } from "../config/defaults.js";
import { createRuntimeDirs } from "../runtime/dirs.js";
import { checkAllTools } from "./auth.js";

export interface InitAnswers {
  runtimeDir: string;
  dashboardRepoUrl: string;
  dashboardRepoLocal: string;
  reposRoot: string;
  adoOrg: string;
  adoProject: string;
  adoArea: string;
  slackEnabled: boolean;
  slackChannel: string;
  slackChannelId: string;
  slackNotifyLevel: "minimal" | "bookends" | "stages";
}

/**
 * Writes a shkmn.config.json file to `dir` with the provided answers merged
 * into the DEFAULT_CONFIG structure.
 */
export function writeInitConfig(dir: string, answers: InitAnswers): void {
  const d = DEFAULT_CONFIG;

  const config = {
    pipeline: {
      runtimeDir: answers.runtimeDir,
      dashboardRepoLocal: answers.dashboardRepoLocal,
      dashboardRepoUrl: answers.dashboardRepoUrl,
    },
    repos: {
      root: answers.reposRoot,
      aliases: {},
    },
    ado: {
      org: answers.adoOrg,
      project: answers.adoProject,
      defaultArea: answers.adoArea,
    },
    slack: {
      enabled: answers.slackEnabled,
      channel: answers.slackChannel,
      channelId: answers.slackChannelId,
      pollIntervalActiveSec: d.slack.pollIntervalActiveSec,
      pollIntervalIdleSec: d.slack.pollIntervalIdleSec,
      notifyLevel: answers.slackNotifyLevel,
      requirePrefix: d.slack.requirePrefix,
      prefix: d.slack.prefix,
      allowDMs: d.slack.allowDMs,
      dmUserIds: d.slack.dmUserIds,
    },
    agents: {
      names: { ...DEFAULT_AGENT_NAMES },
      defaultStages: [...d.agents.defaultStages],
      defaultReviewAfter: d.agents.defaultReviewAfter,
      maxConcurrentTotal: d.agents.maxConcurrentTotal,
      maxTurns: { ...d.agents.maxTurns },
      timeoutsMinutes: { ...d.agents.timeoutsMinutes },
      retryCount: d.agents.retryCount,
    },
    schedule: {
      rollupTime: d.schedule.rollupTime,
      notionPushDay: d.schedule.notionPushDay,
      notionPushTime: d.schedule.notionPushTime,
      monthlyReportDay: d.schedule.monthlyReportDay,
      monthlyReportTime: d.schedule.monthlyReportTime,
    },
  };

  const configPath = join(dir, "shkmn.config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Writes a .env template with empty placeholder keys to `dir`.
 * Skips writing if a .env file already exists.
 */
export function writeInitEnv(dir: string): void {
  const envPath = join(dir, ".env");
  if (existsSync(envPath)) {
    return;
  }

  const template = [
    "# ShaktimaanAI environment variables",
    "# Fill in the values below before running 'shkmn start'",
    "",
    "ADO_PAT=",
    "GITHUB_PAT=",
    "SLACK_TOKEN=  # Not required when using MCP-based Slack integration",
    "SLACK_WEBHOOK_URL=  # Optional — Slack webhook for notifications",
    "ANTHROPIC_API_KEY=",
    "",
  ].join("\n");

  writeFileSync(envPath, template, "utf-8");
}

/**
 * Interactive setup wizard using @clack/prompts.
 * Prompts the user for all required config values, creates runtime dirs,
 * writes config and .env files.
 */
export async function runInitWizard(): Promise<void> {
  intro("ShaktimaanAI Setup");

  // Check required tools
  const toolResults = checkAllTools();
  for (const result of toolResults) {
    if (result.ok) {
      log.success(`${result.name}: ${result.version ?? "ok"}`);
    } else {
      log.warn(`${result.name}: NOT FOUND — ${result.error ?? "unknown error"}`);
    }
  }

  // Prompt for runtime directory
  const runtimeDir = await text({
    message: "Runtime directory (where task files and logs are stored)",
    placeholder: "~/.shkmn/runtime",
    validate: (val) => (val.trim() ? undefined : "Runtime directory is required"),
  });
  if (isCancel(runtimeDir)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for repos root
  const reposRoot = await text({
    message: "Repos root directory (parent folder for all git repositories)",
    placeholder: "~/code",
  });
  if (isCancel(reposRoot)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for ADO org
  const adoOrg = await text({
    message: "Azure DevOps organisation URL",
    placeholder: "https://dev.azure.com/myorg",
  });
  if (isCancel(adoOrg)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for ADO project
  const adoProject = await text({
    message: "Azure DevOps project name",
    placeholder: "MyProject",
  });
  if (isCancel(adoProject)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for ADO area
  const adoArea = await text({
    message: "Azure DevOps default area path",
    placeholder: "MyProject\\MyArea",
  });
  if (isCancel(adoArea)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for dashboard repo URL
  const dashboardRepoUrl = await text({
    message: "Dashboard git repository URL (optional)",
    placeholder: "https://github.com/user/dashboard.git",
  });
  if (isCancel(dashboardRepoUrl)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Prompt for dashboard repo local path
  const dashboardRepoLocal = await text({
    message: "Dashboard local clone path (optional)",
    placeholder: "~/dashboard",
  });
  if (isCancel(dashboardRepoLocal)) {
    log.warn("Setup cancelled.");
    return;
  }

  // Slack integration
  const slackEnabled = await confirm({
    message: "Enable Slack integration?",
    initialValue: false,
  });
  if (isCancel(slackEnabled)) {
    log.warn("Setup cancelled.");
    return;
  }

  let slackChannel = "#agent-pipeline";
  let slackChannelId = "";
  let slackNotifyLevel: "minimal" | "bookends" | "stages" = "bookends";

  if (slackEnabled) {
    const channelVal = await text({
      message: "Slack channel name",
      placeholder: "#agent-pipeline",
    });
    if (isCancel(channelVal)) {
      log.warn("Setup cancelled.");
      return;
    }
    slackChannel = String(channelVal).trim() || "#agent-pipeline";

    const channelIdVal = await text({
      message: "Slack channel ID (from channel details in Slack)",
      placeholder: "C0123456789",
      validate: (val) =>
        String(val).trim()
          ? undefined
          : "Slack channel ID is required when Slack is enabled",
    });
    if (isCancel(channelIdVal)) {
      log.warn("Setup cancelled.");
      return;
    }
    slackChannelId = String(channelIdVal).trim();

    const notifyLevelVal = await select({
      message: "Slack notification level",
      options: [
        { value: "minimal", label: "Minimal — only failures" },
        { value: "bookends", label: "Bookends — start + end of each task (default)" },
        { value: "stages", label: "Stages — every stage transition" },
      ],
      initialValue: "bookends",
    });
    if (isCancel(notifyLevelVal)) {
      log.warn("Setup cancelled.");
      return;
    }
    slackNotifyLevel = notifyLevelVal as "minimal" | "bookends" | "stages";
  }

  const answers: InitAnswers = {
    runtimeDir: String(runtimeDir),
    reposRoot: String(reposRoot),
    adoOrg: String(adoOrg),
    adoProject: String(adoProject),
    adoArea: String(adoArea),
    dashboardRepoUrl: String(dashboardRepoUrl),
    dashboardRepoLocal: String(dashboardRepoLocal),
    slackEnabled,
    slackChannel,
    slackChannelId,
    slackNotifyLevel,
  };

  // Create runtime directories
  createRuntimeDirs(answers.runtimeDir);
  log.success(`Created runtime directories at: ${answers.runtimeDir}`);

  // Write config and .env
  writeInitConfig(answers.runtimeDir, answers);
  log.success(`Written shkmn.config.json to: ${answers.runtimeDir}`);

  writeInitEnv(answers.runtimeDir);
  log.success(`Written .env template to: ${answers.runtimeDir}`);

  outro("Setup complete! Run 'shkmn start' to begin.");
}
