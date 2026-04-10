import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findConfigPath, loadConfig } from "../config/loader.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function getShkmnDir(): string {
  return join(homedir(), ".shkmn");
}

function getScriptPath(): string {
  return join(getShkmnDir(), "shkmn-watchdog.sh");
}

function getLogPath(): string {
  return join(getShkmnDir(), "watchdog.log");
}

function getCrashFilePath(): string {
  return join(getShkmnDir(), "crash-state");
}

const TASK_NAME = "ShaktimaanAI-Watchdog";

function findTemplatePath(): string {
  // Try relative to package dist location first
  const distTemplates = join(dirname(dirname(fileURLToPath(import.meta.url))), "templates", "shkmn-watchdog.sh");
  if (existsSync(distTemplates)) return distTemplates;

  // Fallback: relative to cwd (for development with source mode)
  const cwdTemplates = join(process.cwd(), "templates", "shkmn-watchdog.sh");
  if (existsSync(cwdTemplates)) return cwdTemplates;

  throw new Error(
    "Cannot find shkmn-watchdog.sh template. Tried:\n" +
    `  ${distTemplates}\n` +
    `  ${cwdTemplates}`,
  );
}

function generateScript(
  pidFile: string,
  repoPath: string,
  mode: "source" | "package",
): string {
  const templatePath = findTemplatePath();
  let template = readFileSync(templatePath, "utf-8");

  template = template.replace(/\{\{PID_FILE\}\}/g, pidFile);
  template = template.replace(/\{\{LOG_FILE\}\}/g, getLogPath());
  template = template.replace(/\{\{REPO_PATH\}\}/g, repoPath);
  template = template.replace(/\{\{CRASH_FILE\}\}/g, getCrashFilePath());
  template = template.replace(/\{\{MODE\}\}/g, mode);

  return template;
}

// ─── registerServiceCommand ────────────────────────────────────────────────

export function registerServiceCommand(program: Command): void {
  const svc = program
    .command("service")
    .description("Manage the ShaktimaanAI watchdog service");

  svc
    .command("install")
    .description("Install the watchdog as a Windows Scheduled Task")
    .action(() => {
      const configPath = findConfigPath();
      const config = loadConfig(configPath);

      const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");
      const mode = config.service.mode;
      const repoPath = config.service.repoPath || process.cwd();
      const intervalMinutes = config.service.checkIntervalMinutes;

      // Generate script
      const script = generateScript(pidFile, repoPath, mode);
      const shkmnDir = getShkmnDir();
      mkdirSync(shkmnDir, { recursive: true });
      const scriptPath = getScriptPath();
      writeFileSync(scriptPath, script, "utf-8");
      console.log(`Watchdog script written to: ${scriptPath}`);

      // Register as Windows Task Scheduler job
      // Uses bash.exe to run the shell script
      const bashExe = "C:\\Program Files\\Git\\bin\\bash.exe";
      const scriptWinPath = scriptPath.replace(/\//g, "\\");

      try {
        execSync(
          `schtasks /Create /TN "${TASK_NAME}" /TR "\\"${bashExe}\\" \\"${scriptWinPath}\\"" ` +
          `/SC MINUTE /MO ${intervalMinutes} /F`,
          { stdio: "pipe" },
        );
        console.log(`Scheduled task "${TASK_NAME}" created (every ${intervalMinutes} minutes).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to create scheduled task: ${msg}`);
        console.error("You may need to run this command as Administrator.");
        process.exit(1);
      }
    });

  svc
    .command("uninstall")
    .description("Remove the watchdog scheduled task and script")
    .action(() => {
      // Remove scheduled task
      try {
        execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe" });
        console.log(`Scheduled task "${TASK_NAME}" removed.`);
      } catch {
        console.warn(`Scheduled task "${TASK_NAME}" not found or already removed.`);
      }

      // Remove script file
      const scriptPath = getScriptPath();
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        console.log(`Watchdog script removed: ${scriptPath}`);
      }
    });

  svc
    .command("status")
    .description("Check the status of the watchdog scheduled task")
    .action(() => {
      try {
        const output = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST /V`, {
          stdio: "pipe",
        }).toString("utf-8");
        console.log(output);
      } catch {
        console.log(`Scheduled task "${TASK_NAME}" is not installed.`);
      }
    });

  svc
    .command("logs")
    .description("Show recent watchdog log entries")
    .option("-n, --lines <count>", "Number of lines to show", "50")
    .action((options: { lines: string }) => {
      const logPath = getLogPath();
      if (!existsSync(logPath)) {
        console.log("No watchdog log file found.");
        return;
      }

      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n");
      const count = parseInt(options.lines, 10) || 50;
      const tail = lines.slice(-count).join("\n");
      console.log(tail);
    });
}
