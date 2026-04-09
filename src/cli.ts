#!/usr/bin/env node
import { Command } from "commander";
import { runInitWizard } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerHistoryCommand } from "./commands/history.js";
import { getConfigValue, setConfigValue } from "./commands/config.js";
import { resolveConfigPath } from "./config/resolve-path.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerSkipCommand } from "./commands/skip.js";
import { registerPauseCommand } from "./commands/pause.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerModifyStagesCommand } from "./commands/modify-stages.js";
import { registerRestartStageCommand } from "./commands/restart-stage.js";
import { registerRetryCommand } from "./commands/retry.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerRecoverCommand } from "./commands/recover.js";

const program = new Command();

program
  .name("shkmn")
  .description("ShaktimaanAI — Agentic development pipeline")
  .version("0.1.0");

program
  .command("init")
  .description("Interactive setup wizard — creates config, runtime dirs, dashboard repo")
  .action(async () => {
    await runInitWizard();
  });

const configCmd = program
  .command("config")
  .description("View or edit configuration");

configCmd
  .command("get")
  .description("Get a config value by dot-path")
  .argument("<path>", "Dot-separated config path (e.g. agents.names.questions)")
  .action((path: string) => {
    const configPath = resolveConfigPath();
    const value = getConfigValue(configPath, path);
    if (value === undefined) {
      console.error(`Key not found: ${path}`);
      process.exit(1);
    }
    console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
  });

configCmd
  .command("set")
  .description("Set a config value by dot-path")
  .argument("<path>", "Dot-separated config path")
  .argument("<value>", "New value (strings, numbers, booleans)")
  .action((path: string, value: string) => {
    const configPath = resolveConfigPath();
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (!isNaN(Number(value)) && value.trim() !== "") parsed = Number(value);

    setConfigValue(configPath, path, parsed);
    console.log(`Set ${path} = ${JSON.stringify(parsed)}`);
  });

registerStartCommand(program);
registerStopCommand(program);
registerTaskCommand(program);
registerApproveCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);
registerHistoryCommand(program);
registerCancelCommand(program);
registerSkipCommand(program);
registerPauseCommand(program);
registerResumeCommand(program);
registerModifyStagesCommand(program);
registerRestartStageCommand(program);
registerRetryCommand(program);
registerDoctorCommand(program);
registerStatsCommand(program);
registerRecoverCommand(program);

program.parse();
