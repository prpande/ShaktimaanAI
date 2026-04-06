import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { parseTaskFile } from "../task/parser.js";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn } from "./types.js";
import { stripPrefix } from "../surfaces/slack-surface.js";
import { classifyByKeywords } from "./intent-classifier.js";
import { createTask } from "./task-creator.js";
import { buildNaradaPayload, readInbox, clearInbox, readSentLog } from "./slack-queue.js";

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
  runner?: AgentRunnerFn;
}

// ─── createWatcher ────────────────────────────────────────────────────────────

export function createWatcher(options: WatcherOptions): Watcher {
  const { runtimeDir, pipeline, logger, config, runner } = options;
  let running = false;
  let fsWatcher: FSWatcher | null = null;
  const processingFiles = new Set<string>();
  let slackPollInProgress = false;
  let slackInterval: ReturnType<typeof setInterval> | null = null;

  function ensureSlackFiles(): void {
    const files = [
      { name: "slack-outbox.jsonl", content: "" },
      { name: "slack-inbox.jsonl", content: "" },
      { name: "slack-sent.jsonl", content: "" },
      { name: "slack-threads.json", content: "{}" },
      { name: "slack-cursor.json", content: JSON.stringify({ channelTs: String(Date.now() / 1000), dmTs: String(Date.now() / 1000) }) },
    ];
    for (const f of files) {
      const p = join(runtimeDir, f.name);
      if (!existsSync(p)) {
        writeFileSync(p, f.content, "utf-8");
      }
    }
  }

  async function pollSlack(): Promise<void> {
    if (!runner) return;
    slackPollInProgress = true;

    try {
      // Ensure queue files exist before spawning Narada
      ensureSlackFiles();

      // Find held task slugs for approval checking
      const holdDir = join(runtimeDir, "12-hold");
      let heldSlugs: string[] = [];
      try {
        heldSlugs = readdirSync(holdDir).filter((f) => !f.startsWith("."));
      } catch { /* no hold dir */ }

      // Build Narada payload
      const payload = buildNaradaPayload(runtimeDir, {
        channelId: config.slack.channelId,
        allowDMs: config.slack.allowDMs,
        dmUserIds: config.slack.dmUserIds,
        heldSlugs,
      });

      // Warn if DMs enabled but no user IDs
      if (config.slack.allowDMs && config.slack.dmUserIds.length === 0) {
        logger.warn("[watcher] Slack DM polling enabled but no dmUserIds configured — skipping DMs");
      }

      // Spawn Narada
      const abortController = new AbortController();
      await runner({
        stage: "slack-io",
        slug: "slack-io-poll",
        taskContent: JSON.stringify(payload, null, 2),
        previousOutput: "",
        outputPath: join(runtimeDir, "slack-io-output.md"),
        cwd: runtimeDir,
        config,
        abortController,
        logger: { info() {}, warn() {}, error() {} },
      });

      // Post-process inbox
      const inboxEntries = readInbox(runtimeDir);

      for (const entry of inboxEntries) {
        if (entry.isApproval && entry.slug) {
          // Verify task is actually held
          if (existsSync(join(runtimeDir, "12-hold", entry.slug))) {
            const controlPath = join(runtimeDir, "00-inbox", `slack-approve-${entry.ts.replace(".", "-")}.control`);
            writeFileSync(controlPath, JSON.stringify({
              operation: "approve",
              slug: entry.slug,
              feedback: `Approved via Slack by ${entry.user}`,
            }), "utf-8");
            logger.info(`[watcher] Slack approval detected for ${entry.slug}`);
          }
        } else {
          const text = config.slack.requirePrefix
            ? stripPrefix(entry.text, config.slack.prefix)
            : entry.text;

          const classified = classifyByKeywords(text);
          const intent = classified?.intent ?? "create_task";

          if (intent === "create_task" || intent === "unknown") {
            createTask(
              { source: "slack", content: text, slackThread: entry.thread_ts ?? entry.ts },
              runtimeDir,
              config,
            );
            logger.info(`[watcher] Slack: created task from message ${entry.ts}`);
          } else if (classified?.extractedSlug) {
            const controlPayload: Record<string, unknown> = { operation: intent, slug: classified.extractedSlug };
            if (classified.extractedFeedback) controlPayload.feedback = classified.extractedFeedback;
            if (classified.extractedStages) controlPayload.stages = classified.extractedStages;

            const controlPath = join(runtimeDir, "00-inbox", `slack-${entry.ts.replace(".", "-")}.control`);
            writeFileSync(controlPath, JSON.stringify(controlPayload), "utf-8");
            logger.info(`[watcher] Slack: wrote control file for ${intent} on ${classified.extractedSlug}`);
          } else {
            logger.warn(`[watcher] Slack: classified as "${intent}" but no slug extracted from: "${text}"`);
          }
        }
      }

      // Clear inbox after processing
      if (inboxEntries.length > 0) {
        clearInbox(runtimeDir);
      }

      // Log sent confirmations
      const sentEntries = readSentLog(runtimeDir);
      if (sentEntries.length > 0) {
        logger.info(`[watcher] Slack: ${sentEntries.length} message(s) confirmed sent`);
      }
    } finally {
      slackPollInProgress = false;
    }
  }

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

      if (config.slack.enabled && config.slack.channelId && runner) {
        const pollMs = config.slack.pollIntervalSeconds * 1000;
        slackInterval = setInterval(() => {
          if (slackPollInProgress) return;
          pollSlack().catch((err: unknown) => {
            logger.error(`[watcher] Slack poll error: ${err instanceof Error ? err.message : String(err)}`);
          });
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
