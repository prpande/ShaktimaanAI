import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Watcher {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface WatcherOptions {
  runtimeDir: string;
  pipeline: Pipeline;
  logger: TaskLogger;
}

// ─── createWatcher ────────────────────────────────────────────────────────────

export function createWatcher(options: WatcherOptions): Watcher {
  const { runtimeDir, pipeline, logger } = options;
  let running = false;
  let fsWatcher: FSWatcher | null = null;

  return {
    start(): void {
      if (running) {
        return; // no-op if already running
      }

      const inboxDir = join(runtimeDir, "00-inbox");

      fsWatcher = chokidar.watch(inboxDir, {
        ignored: (path: string, stats?: { isFile(): boolean }) =>
          !!stats?.isFile() && !path.endsWith(".task"),
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      fsWatcher.on("add", (filePath: string) => {
        if (filePath.endsWith(".task")) {
          pipeline.startRun(filePath).catch((err: unknown) => {
            logger.error(
              `Failed to start run for "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      });

      fsWatcher.on("error", (err: unknown) => {
        logger.error(
          `Watcher error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      fsWatcher.on("ready", () => {
        logger.info(`Watching inbox: ${inboxDir}`);
      });

      running = true;
    },

    async stop(): Promise<void> {
      if (fsWatcher) {
        await fsWatcher.close();
        fsWatcher = null;
      }
      running = false;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
