import { Command } from "commander";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigPath } from "../config/resolve-path.js";
import { loadConfig } from "../config/loader.js";

// ─── registerStopCommand ─────────────────────────────────────────────────────

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the ShaktimaanAI pipeline watcher")
    .action(async () => {
      // 1. Resolve config
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      const pidFile = join(config.pipeline.runtimeDir, "shkmn.pid");

      // 2. Check for PID file
      if (!existsSync(pidFile)) {
        console.error("ShaktimaanAI is not running (no PID file found).");
        process.exit(1);
      }

      // 3. Read PID, send signal, clean up
      let pid: number;
      try {
        const raw = readFileSync(pidFile, "utf-8").trim();
        pid = parseInt(raw, 10);
        if (isNaN(pid)) {
          throw new Error(`Invalid PID value in file: "${raw}"`);
        }

        process.kill(pid, "SIGTERM");

        // Wait briefly and verify the process has stopped
        const deadline = Date.now() + 3_000;
        let alive = true;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0); // signal 0 = check if alive
            await new Promise((r) => setTimeout(r, 250));
          } catch {
            alive = false;
            break;
          }
        }

        unlinkSync(pidFile);

        if (alive) {
          console.warn(`Warning: ShaktimaanAI (PID ${pid}) may still be running after SIGTERM.`);
        } else {
          console.log(`ShaktimaanAI (PID ${pid}) stopped.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to stop ShaktimaanAI: ${message}`);
        // Clean up stale PID file if it still exists
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
        }
        process.exit(1);
      }
    });
}
