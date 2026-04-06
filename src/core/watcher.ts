import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { parseTaskFile } from "../task/parser.js";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";
import { type ResolvedConfig } from "../config/loader.js";

// ─── Control file schema ──────────────────────────────────────────────────────

const controlSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("cancel"), slug: z.string() }),
  z.object({ operation: z.literal("skip"), slug: z.string(), stage: z.string().optional() }),
  z.object({ operation: z.literal("pause"), slug: z.string() }),
  z.object({ operation: z.literal("resume"), slug: z.string() }),
  z.object({ operation: z.literal("approve"), slug: z.string(), feedback: z.string().optional() }),
  z.object({ operation: z.literal("modify_stages"), slug: z.string(), stages: z.array(z.string()) }),
  z.object({ operation: z.literal("restart_stage"), slug: z.string(), stage: z.string().optional() }),
  z.object({ operation: z.literal("retry"), slug: z.string(), feedback: z.string() }),
]);

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
  config: ResolvedConfig;
}

// ─── createWatcher ────────────────────────────────────────────────────────────

export function createWatcher(options: WatcherOptions): Watcher {
  const { runtimeDir, pipeline, logger, config } = options;
  let running = false;
  let fsWatcher: FSWatcher | null = null;
  let slackInterval: ReturnType<typeof setInterval> | null = null;
  const processingFiles = new Set<string>();

  async function handleControlFile(filePath: string): Promise<void> {
    const content = readFileSync(filePath, "utf-8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      logger.error(`[watcher] Invalid JSON in control file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      try { unlinkSync(filePath); } catch { /* may already be gone */ }
      return;
    }

    const result = controlSchema.safeParse(parsed);
    if (!result.success) {
      logger.error(`[watcher] Malformed control file "${filePath}": ${result.error.message}`);
      try { unlinkSync(filePath); } catch { /* may already be gone */ }
      return;
    }

    const cmd = result.data;
    switch (cmd.operation) {
      case "cancel": await pipeline.cancel(cmd.slug); break;
      case "skip": await pipeline.skip(cmd.slug, cmd.stage); break;
      case "pause": await pipeline.pause(cmd.slug); break;
      case "resume": await pipeline.resume(cmd.slug); break;
      case "approve": await pipeline.approveAndResume(cmd.slug, cmd.feedback); break;
      case "modify_stages": await pipeline.modifyStages(cmd.slug, cmd.stages); break;
      case "restart_stage": await pipeline.restartStage(cmd.slug, cmd.stage); break;
      case "retry": await pipeline.retry(cmd.slug, cmd.feedback); break;
    }

    // Delete only after successful processing
    try { unlinkSync(filePath); } catch { /* may already be gone */ }
  }

  return {
    start(): void {
      if (running) {
        return; // no-op if already running
      }

      const inboxDir = join(runtimeDir, "00-inbox");

      fsWatcher = chokidar.watch(inboxDir, {
        ignored: (path: string, stats?: { isFile(): boolean }) =>
          !!stats?.isFile() && !path.endsWith(".task") && !path.endsWith(".control"),
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      fsWatcher.on("add", (filePath: string) => {
        if (filePath.endsWith(".task")) {
          // Guard against duplicate chokidar events for the same file (common on Windows)
          if (processingFiles.has(filePath)) return;
          processingFiles.add(filePath);

          const runTask = async () => {
            try {
              const taskContent = readFileSync(filePath, "utf-8");
              const meta = parseTaskFile(taskContent);
              if (meta.stages.length === 1 && meta.stages[0] === "quick") {
                await pipeline.startQuickRun(filePath, taskContent);
              } else {
                await pipeline.startRun(filePath);
              }
            } catch (err: unknown) {
              logger.error(
                `Failed to start run for "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // Never remove task files from the set — each slug is unique, so
            // duplicate chokidar events for the same file should always be ignored.
          };
          runTask();
        } else if (filePath.endsWith(".control")) {
          if (processingFiles.has(filePath)) return;
          processingFiles.add(filePath);

          handleControlFile(filePath)
            .catch((err: unknown) => {
              logger.error(`Failed to handle control "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => processingFiles.delete(filePath));
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

      if (config.slack.enabled) {
        const pollMs = config.slack.pollIntervalSeconds * 1000;
        slackInterval = setInterval(() => {
          logger.info("[watcher] Slack poll tick");
        }, pollMs);
        logger.info(`[watcher] Slack polling enabled (${config.slack.pollIntervalSeconds}s interval)`);
      }

      running = true;
    },

    async stop(): Promise<void> {
      if (slackInterval) {
        clearInterval(slackInterval);
        slackInterval = null;
      }
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
