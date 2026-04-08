import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { type Pipeline } from "./pipeline.js";
import { type TaskLogger } from "./logger.js";
import { type ResolvedConfig } from "../config/loader.js";
import { type AgentRunnerFn } from "./types.js";
import { stripPrefix } from "../surfaces/slack-surface.js";
import { runAstraTriage, type AstraInput } from "./astra-triage.js";
import { createTask } from "./task-creator.js";
import { buildNaradaPayload, readInbox, clearInbox, readSentLog, loadThreadMap, saveThreadMap } from "./slack-queue.js";

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
  /** Triggers an immediate Narada send cycle (outbox flush + inbox read). */
  triggerSlackSend(): void;
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
  let slackInterval: ReturnType<typeof setTimeout> | null = null;

  // Deduplication: track processed Slack message timestamps
  const processedTsPath = join(runtimeDir, "slack-processed.json");
  let processedTs: Set<string>;
  try {
    const raw = readFileSync(processedTsPath, "utf-8");
    processedTs = new Set(JSON.parse(raw) as string[]);
  } catch {
    processedTs = new Set();
  }
  function markProcessed(ts: string): void {
    processedTs.add(ts);
    // Keep only the last 500 entries to avoid unbounded growth
    if (processedTs.size > 500) {
      const arr = Array.from(processedTs);
      processedTs = new Set(arr.slice(arr.length - 500));
    }
    writeFileSync(processedTsPath, JSON.stringify(Array.from(processedTs)), "utf-8");
  }

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
    const responsesDir = join(runtimeDir, "astra-responses");
    if (!existsSync(responsesDir)) {
      mkdirSync(responsesDir, { recursive: true });
    }
  }

  function writeOutboxEntry(channel: string, text: string, threadTs: string | null): void {
    const entry: import("./slack-queue.js").OutboxEntry = {
      id: randomUUID(),
      slug: "astra-response",
      type: "astra_reply",
      channel,
      text,
      thread_ts: threadTs,
      addedAt: new Date().toISOString(),
    };
    const outboxPath = join(runtimeDir, "slack-outbox.jsonl");
    appendFileSync(outboxPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  function notifySlackError(channel: string, threadTs: string | null, message: string): void {
    writeOutboxEntry(channel, message, threadTs);
    triggerNaradaSend().catch((err: unknown) => {
      logger.error(`[watcher] Failed to trigger Narada send for error notification: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function triggerNaradaSend(): Promise<void> {
    if (!runner) return;
    // Reuse pollSlack which handles both outbox sends and inbox reads
    if (slackPollInProgress) return;
    await pollSlack();
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
        outboundPrefix: config.slack.outboundPrefix,
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
        // Skip malformed entries (e.g., sent log entries written to inbox by mistake)
        if (!entry.text || !entry.user || !entry.channel) {
          continue;
        }

        // Skip already-processed messages (prevents duplicate task creation)
        if (processedTs.has(entry.ts)) {
          continue;
        }
        markProcessed(entry.ts);

        // Handle Slack approvals (unchanged)
        if (entry.isApproval && entry.slug) {
          if (existsSync(join(runtimeDir, "12-hold", entry.slug))) {
            const controlPath = join(runtimeDir, "00-inbox", `slack-approve-${entry.ts.replace(".", "-")}.control`);
            writeFileSync(controlPath, JSON.stringify({
              operation: "approve",
              slug: entry.slug,
              feedback: `Approved via Slack by ${entry.user}`,
            }), "utf-8");
            logger.info(`[watcher] Slack approval detected for ${entry.slug}`);
          }
          continue;
        }

        const text = config.slack.requirePrefix
          ? stripPrefix(entry.text, config.slack.prefix)
          : entry.text;

        // Call Astra triage instead of keyword classification
        const astraInput: AstraInput = {
          message: text,
          threadTs: entry.thread_ts ?? entry.ts,
          channelId: entry.channel,
          userId: entry.user,
          source: "slack",
        };

        const triageResult = await runAstraTriage(astraInput, runner, config, logger);

        if (!triageResult) {
          notifySlackError(
            entry.channel,
            entry.thread_ts ?? entry.ts,
            "I couldn't process your message — could you rephrase?",
          );
          logger.warn(`[watcher] Astra triage failed for message ${entry.ts}`);
          continue;
        }

        switch (triageResult.action) {
          case "control_command": {
            if (triageResult.controlOp && triageResult.extractedSlug) {
              const controlPayload: Record<string, unknown> = {
                operation: triageResult.controlOp,
                slug: triageResult.extractedSlug,
              };
              const controlPath = join(runtimeDir, "00-inbox", `slack-${entry.ts.replace(".", "-")}.control`);
              writeFileSync(controlPath, JSON.stringify(controlPayload), "utf-8");
              logger.info(`[watcher] Astra: control command ${triageResult.controlOp} for ${triageResult.extractedSlug}`);
            } else if (triageResult.controlOp && !triageResult.extractedSlug) {
              notifySlackError(
                entry.channel,
                entry.thread_ts ?? entry.ts,
                "I couldn't find an active task matching that command. Which task did you mean?",
              );
              logger.warn(`[watcher] Astra: control command ${triageResult.controlOp} but no slug extracted`);
            }
            break;
          }

          case "answer": {
            try {
              const outputDir = join(runtimeDir, "astra-responses");
              mkdirSync(outputDir, { recursive: true });
              const executeResult = await runner({
                stage: "quick-execute",
                slug: `astra-exec-${entry.ts.replace(".", "-")}`,
                taskContent: astraInput.message,
                previousOutput: triageResult.enrichedContext ?? "",
                outputPath: join(outputDir, `${entry.ts.replace(".", "-")}.md`),
                cwd: process.cwd(),
                config,
                logger: { info() {}, warn() {}, error() {} },
              });

              if (executeResult.success && executeResult.output) {
                writeOutboxEntry(
                  entry.channel,
                  executeResult.output,
                  entry.thread_ts ?? entry.ts,
                );
                triggerNaradaSend().catch((err: unknown) => {
                  logger.error(`[watcher] Failed to trigger Narada send: ${err instanceof Error ? err.message : String(err)}`);
                });
              } else {
                notifySlackError(
                  entry.channel,
                  entry.thread_ts ?? entry.ts,
                  `I ran into a problem while working on that — ${executeResult.error ?? "unknown error"}. Let me know if you'd like me to try again.`,
                );
              }
              // Track conversation thread so follow-up replies are visible
              const answerThreadTs = entry.thread_ts ?? entry.ts;
              const threadMap = loadThreadMap(runtimeDir);
              threadMap[`astra-${entry.ts.replace(".", "-")}`] = answerThreadTs;
              saveThreadMap(runtimeDir, threadMap);

              logger.info(`[watcher] Astra: answered message ${entry.ts} directly`);
            } catch (err: unknown) {
              notifySlackError(
                entry.channel,
                entry.thread_ts ?? entry.ts,
                `I ran into a problem — ${err instanceof Error ? err.message : String(err)}. Let me know if you'd like me to try again.`,
              );
              logger.error(`[watcher] Astra execute failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            break;
          }

          case "route_pipeline": {
            createTask(
              {
                source: "slack",
                content: text,
                repo: process.cwd(),
                slackThread: entry.thread_ts ?? entry.ts,
                stages: triageResult.recommendedStages ?? undefined,
                stageHints: triageResult.stageHints ?? undefined,
                requiredMcpServers: triageResult.requiredMcpServers ?? undefined,
              },
              runtimeDir,
              config,
              triageResult.enrichedContext ?? undefined,
              triageResult.repoSummary ?? undefined,
            );
            logger.info(`[watcher] Astra: routed message ${entry.ts} to pipeline`);
            break;
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
              await pipeline.startRun(filePath);
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
        const getInterval = () => {
          const hasActiveTasks = pipeline.getActiveRuns().length > 0;
          return (hasActiveTasks ? config.slack.pollIntervalActiveSec : config.slack.pollIntervalIdleSec) * 1000;
        };

        const schedulePoll = () => {
          slackInterval = setTimeout(() => {
            if (slackPollInProgress) {
              schedulePoll();
              return;
            }
            slackPollInProgress = true;
            pollSlack()
              .catch((err: unknown) => {
                logger.error(`[watcher] Slack poll error: ${err instanceof Error ? err.message : String(err)}`);
              })
              .finally(() => {
                slackPollInProgress = false;
                schedulePoll();
              });
          }, getInterval());
        };

        schedulePoll();
        logger.info(`[watcher] Slack adaptive polling enabled (active: ${config.slack.pollIntervalActiveSec}s, idle: ${config.slack.pollIntervalIdleSec}s)`);
      }

      running = true;
    },

    async stop(): Promise<void> {
      if (slackInterval) {
        clearTimeout(slackInterval);
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

    triggerSlackSend(): void {
      triggerNaradaSend().catch((err: unknown) => {
        logger.error(`[watcher] triggerSlackSend failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  };
}
