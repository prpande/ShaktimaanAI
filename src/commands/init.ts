import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { intro, text, outro, isCancel, log } from "@clack/prompts";
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
      enabled: d.slack.enabled,
      channel: d.slack.channel,
      channelId: d.slack.channelId,
      pollIntervalSeconds: d.slack.pollIntervalSeconds,
    },
    agents: {
      names: { ...DEFAULT_AGENT_NAMES },
      defaultStages: [...d.agents.defaultStages],
      defaultReviewAfter: d.agents.defaultReviewAfter,
      maxConcurrentTotal: d.agents.maxConcurrentTotal,
      maxConcurrentValidate: d.agents.maxConcurrentValidate,
      maxTurns: { ...d.agents.maxTurns },
      timeoutsMinutes: { ...d.agents.timeoutsMinutes },
      heartbeatTimeoutMinutes: d.agents.heartbeatTimeoutMinutes,
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
    "SLACK_TOKEN=",
    "SLACK_WEBHOOK_URL=",
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

  const answers: InitAnswers = {
    runtimeDir: String(runtimeDir),
    reposRoot: String(reposRoot),
    adoOrg: String(adoOrg),
    adoProject: String(adoProject),
    adoArea: String(adoArea),
    dashboardRepoUrl: String(dashboardRepoUrl),
    dashboardRepoLocal: String(dashboardRepoLocal),
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
