import { Command } from "commander";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig, loadEnvFile } from "../config/loader.js";
import { verifyRuntimeDirs } from "../runtime/dirs.js";
import { createSystemLogger } from "../core/logger.js";
import { createAgentRegistry } from "../core/registry.js";
import { createPipeline } from "../core/pipeline.js";
import { runAgent } from "../core/agent-runner.js";
import { createWatcher, type Watcher } from "../core/watcher.js";
import { runRecovery } from "../core/recovery.js";

// ─── Module-level watcher reference ─────────────────────────────────────────

let activeWatcher: Watcher | null = null;

// ─── registerStartCommand ────────────────────────────────────────────────────

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the ShaktimaanAI pipeline watcher")
    .action(async () => {
      // 1. Resolve config and load env
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const envPath = join(dirname(configPath), ".env");
      loadEnvFile(envPath);

      // 2. Verify runtime dirs
      const { valid, missing } = verifyRuntimeDirs(config.pipeline.runtimeDir);
      if (!valid) {
        console.error(
          "Runtime directories are missing. Run 'shkmn init' first.\nMissing:\n" +
            missing.map((d) => `  ${d}`).join("\n"),
        );
        process.exit(1);
      }

      // 3. Create system logger and agent registry
      const logDir = join(config.pipeline.runtimeDir, "logs");
      const logger = createSystemLogger(logDir);
      const registry = createAgentRegistry(
        config.agents.maxConcurrentTotal,
        config.agents.maxConcurrentValidate,
      );

      // 4. Resolve template dir (relative to this compiled file)
      const templateDir = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "templates",
      );

      // 5. Create pipeline
      const pipeline = createPipeline({
        config,
        registry,
        runner: runAgent,
        logger,
      });

      // 6. Run crash recovery
      await runRecovery(config.pipeline.runtimeDir, pipeline, logger);

      // 7. Create and start watcher
      activeWatcher = createWatcher({
        runtimeDir: config.pipeline.runtimeDir,
        pipeline,
        logger,
      });
      activeWatcher.start();

      // 8. Write PID file
      const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");
      writeFileSync(pidFile, String(process.pid), "utf-8");

      // 9. Confirm startup
      console.log("ShaktimaanAI pipeline started. Watching for tasks...");

      // 10. Graceful shutdown on SIGINT/SIGTERM
      const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal} — shutting down`);
        registry.abortAll();

        // Grace period: wait up to 5 seconds for agents to finish
        const graceMs = 5_000;
        const pollMs = 250;
        const deadline = Date.now() + graceMs;
        while (registry.getActiveCount() > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
        }
        if (registry.getActiveCount() > 0) {
          logger.warn(`[shutdown] ${registry.getActiveCount()} agent(s) still running after grace period — forcing exit`);
        }

        if (activeWatcher) {
          await activeWatcher.stop();
          activeWatcher = null;
        }
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    });
}
