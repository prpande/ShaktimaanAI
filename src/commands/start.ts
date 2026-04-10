import { Command } from "commander";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { findConfigPath, loadConfig, loadEnvFile } from "../config/loader.js";
import { verifyRuntimeDirs } from "../runtime/dirs.js";
import { createSystemLogger } from "../core/logger.js";
import { createAgentRegistry } from "../core/registry.js";
import { createPipeline } from "../core/pipeline.js";
import { runAgent } from "../core/agent-runner.js";
import { createWatcher, type Watcher } from "../core/watcher.js";
import { createConsoleNotifier } from "../surfaces/console-notifier.js";
import { showBanner } from "../ui/banner.js";
import { runRecovery, runRecoveryStartupScan } from "../core/recovery.js";
import { cleanupExpired } from "../core/worktree.js";

// ─── Module-level watcher reference ─────────────────────────────────────────

let activeWatcher: Watcher | null = null;

// ─── registerStartCommand ────────────────────────────────────────────────────

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the ShaktimaanAI pipeline watcher")
    .action(async (_opts: unknown, cmd: Command) => {
      // 1. Resolve config and load env
      const configPath = findConfigPath();
      const config = loadConfig(configPath);
      const envPath = join(dirname(configPath), ".env");
      loadEnvFile(envPath);

      // 2. Verify runtime dirs
      const { valid, missing } = verifyRuntimeDirs(config.paths);
      if (!valid) {
        console.error(
          "Runtime directories are missing. Run 'shkmn init' first.\nMissing:\n" +
            missing.map((d) => `  ${d}`).join("\n"),
        );
        process.exit(1);
      }

      // 3. Show banner (after validation so errors aren't hidden behind animation)
      const noBanner = cmd.optsWithGlobals().banner === false;
      await showBanner({ noBanner, version: program.version() ?? "" });

      // 4. Create system logger and agent registry
      const logDir = join(config.pipeline.runtimeDir, "logs");
      const logger = createSystemLogger(logDir);
      const registry = createAgentRegistry(config.agents.maxConcurrentTotal);

      // 4. Run worktree cleanup on startup if enabled
      if (config.worktree.cleanupOnStartup) {
        const manifestPath = join(config.pipeline.runtimeDir, "worktree-manifest.json");
        const removed = cleanupExpired(manifestPath, config.worktree.retentionDays);
        if (removed.length > 0) {
          logger.info(`[startup] Cleaned up ${removed.length} expired worktree(s)`);
        }
      }

      // 5. Create pipeline
      const pipeline = createPipeline({
        config,
        registry,
        runner: runAgent,
        logger,
      });

      // 5b. Run recovery startup scan (diagnose failures, check issues, log pending)
      // Note: notifiers aren't registered yet, so emitNotify is a no-op logger
      const scanResult = await runRecoveryStartupScan(
        config.pipeline.runtimeDir,
        config,
        runAgent,
        logger,
        (event) => {
          logger.info(`[startup-scan] Event: ${event.type} slug=${event.slug ?? "n/a"}`);
        },
      );
      if (scanResult.recovered.length || scanResult.terminal.length || scanResult.pending.length) {
        logger.info(
          `[startup] Recovery scan: ${scanResult.recovered.length} recovered, ` +
          `${scanResult.terminal.length} terminal, ${scanResult.pending.length} pending`,
        );
      }

      // 6. Run crash recovery
      await runRecovery(config.pipeline.runtimeDir, pipeline, logger);

      // 6b. Create watcher (before notifiers so we can wire triggerSlackSend)
      activeWatcher = createWatcher({
        runtimeDir: config.pipeline.runtimeDir,
        pipeline,
        logger,
        config,
        runner: runAgent,
      });

      // 6c. Register notifiers
      pipeline.addNotifier(createConsoleNotifier());

      if (config.slack.enabled && config.slack.channelId) {
        const { createSlackNotifier } = await import("../surfaces/slack-notifier.js");
        pipeline.addNotifier(createSlackNotifier({
          channelId: config.slack.channelId,
          notifyLevel: config.slack.notifyLevel,
          runtimeDir: config.pipeline.runtimeDir,
          timezone: config.slack.timezone,
          onOutboxWrite: () => activeWatcher?.triggerSlackSend(),
        }));
        logger.info("[start] SlackNotifier registered (file-based outbox, on-demand send)");
      }

      // 7. Start watcher
      activeWatcher.start();

      // 8. Write PID file (with stale PID detection)
      const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");
      if (existsSync(pidFile)) {
        const existingPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (!isNaN(existingPid)) {
          try {
            process.kill(existingPid, 0);  // Signal 0 = check if alive, don't kill
            // Process is alive — another instance is running
            console.error(
              `Pipeline already running (PID ${existingPid}). ` +
              `If this is stale, delete ${pidFile} and retry.`,
            );
            process.exit(1);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ESRCH") {
              // Process is dead — stale PID file, safe to overwrite
              logger.warn(`[startup] Removed stale PID file (PID ${existingPid} is not running)`);
              unlinkSync(pidFile);
            } else if (code === "EPERM") {
              // Process exists but cannot be signaled — treat as already running
              console.error(
                `Pipeline already running (PID ${existingPid}). ` +
                `If this is stale, delete ${pidFile} and retry.`,
              );
              process.exit(1);
            } else {
              // Unknown error — remove stale file (fail-safe for Windows)
              logger.warn(`[startup] Removed stale PID file (PID ${existingPid}, signal check error: ${code})`);
              unlinkSync(pidFile);
            }
          }
        } else {
          // Malformed PID file — remove it
          unlinkSync(pidFile);
        }
      }
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
