import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findConfigPath, loadConfig } from "../config/loader.js";

// ─── registerStopCommand ─────────────────────────────────────────────────────

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the ShaktimaanAI pipeline watcher")
    .action(async () => {
      // 1. Resolve config
      const configPath = findConfigPath();
      const config = loadConfig(configPath);

      const pidFile = config.paths.pidFile;

      // 2. Check for PID file
      if (!existsSync(pidFile)) {
        console.error("ShaktimaanAI is not running (no PID file found).");
        process.exit(1);
      }

      let pid: number;
      try {
        const raw = readFileSync(pidFile, "utf-8").trim();
        pid = parseInt(raw, 10);
        if (isNaN(pid)) {
          throw new Error(`Invalid PID value in file: "${raw}"`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to read PID file: ${message}`);
        if (existsSync(pidFile)) unlinkSync(pidFile);
        process.exit(1);
        return; // unreachable, for TS
      }

      // 3. Verify process is alive
      try {
        process.kill(pid, 0);
      } catch {
        console.error(`ShaktimaanAI (PID ${pid}) is not running. Cleaning up stale PID file.`);
        unlinkSync(pidFile);
        process.exit(1);
        return;
      }

      // 4. Write shutdown.control file to trigger graceful drain
      mkdirSync(config.paths.terminals.inbox, { recursive: true });
      const controlPath = join(config.paths.terminals.inbox, "shutdown.control");
      writeFileSync(
        controlPath,
        JSON.stringify({ operation: "shutdown", slug: "system" }),
        "utf-8",
      );
      console.log("Shutdown signal sent via control file. Waiting for graceful drain...");

      // 5. Poll for process exit (10-minute timeout)
      const TIMEOUT_MS = 10 * 60 * 1000;
      const POLL_MS = 1_000;
      const deadline = Date.now() + TIMEOUT_MS;
      let alive = true;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try {
          process.kill(pid, 0);
          // Still alive — keep waiting
        } catch {
          alive = false;
          break;
        }
      }

      // 6. Force kill if timeout exceeded
      if (alive) {
        console.warn(`Graceful drain timed out after 10 minutes. Sending SIGTERM to PID ${pid}...`);
        try {
          process.kill(pid, "SIGTERM");
          // Wait briefly for forced shutdown
          const forceDeadline = Date.now() + 5_000;
          while (Date.now() < forceDeadline) {
            await new Promise((r) => setTimeout(r, 250));
            try {
              process.kill(pid, 0);
            } catch {
              alive = false;
              break;
            }
          }
        } catch {
          alive = false;
        }

      }

      // 7. Clean up PID file only if process has exited
      if (!alive) {
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }

        // Clean up control file if still present
        if (existsSync(controlPath)) {
          try { unlinkSync(controlPath); } catch { /* may already be gone */ }
        }

        console.log(`ShaktimaanAI (PID ${pid}) stopped.`);
      } else {
        // Process still alive after force kill — keep PID file to prevent watchdog double-launch
        console.error(`Process ${pid} could not be stopped. PID file retained to prevent duplicate instances.`);
        process.exit(2);
      }
    });
}
