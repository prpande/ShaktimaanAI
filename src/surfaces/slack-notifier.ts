import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Notifier, NotifyEvent, NotifyLevel } from "./types.js";
import { shouldNotify } from "./types.js";
import { loadThreadMap } from "../core/slack-queue.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  runtimeDir: string;
  /** Called after writing to outbox — wire to triggerNaradaSend for immediate delivery. */
  onOutboxWrite?: () => void;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

export function formatTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function formatTokens(input?: number, output?: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `${fmt(input ?? 0)} in / ${fmt(output ?? 0)} out`;
}

export function formatMetrics(m: {
  durationSeconds?: number;
  costUsd?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
}): string {
  const parts: string[] = [];
  if (m.durationSeconds != null) parts.push(`⏱ ${formatDuration(m.durationSeconds)}`);
  if (m.costUsd != null) parts.push(`💰 $${m.costUsd.toFixed(2)}`);
  if (m.turns != null) parts.push(`${m.turns} turns`);
  const line1 = parts.join(" · ");

  const line2 =
    m.inputTokens != null || m.outputTokens != null
      ? `📊 ${formatTokens(m.inputTokens, m.outputTokens)}`
      : "";

  return [line1, line2].filter(Boolean).join("\n");
}

// ─── formatEvent ─────────────────────────────────────────────────────────────

export function formatEvent(event: NotifyEvent): string {
  const slug = `\`${event.slug}\``;

  switch (event.type) {
    case "task_created":
      return `:rocket: *Task created* ${slug} — *${event.title}* (source: ${event.source}) stages: [${event.stages.join(", ")}]`;
    case "stage_started":
      return `:arrow_forward: *Stage started* ${slug} — \`${event.stage}\``;
    case "stage_completed":
      return `:white_check_mark: *Stage completed* ${slug} — \`${event.stage}\` artifact: ${event.artifactPath}`;
    case "task_held":
      return `:hand: *Task held* ${slug} — stage \`${event.stage}\` awaiting review: ${event.artifactUrl}`;
    case "task_approved": {
      const fb = event.feedback != null ? ` — feedback: "${event.feedback}"` : "";
      return `:thumbsup: *Task approved* ${slug} by ${event.approvedBy}${fb}`;
    }
    case "task_completed": {
      const pr = event.prUrl != null ? ` PR: ${event.prUrl}` : "";
      return `:tada: *Task completed* ${slug}${pr}`;
    }
    case "task_failed":
      return `:x: *Task failed* ${slug} — stage \`${event.stage}\` error: "${event.error}"`;
    case "task_cancelled":
      return `:no_entry_sign: *Task cancelled* ${slug} by ${event.cancelledBy}`;
    case "task_paused":
      return `:double_vertical_bar: *Task paused* ${slug} by ${event.pausedBy}`;
    case "task_resumed":
      return `:arrow_forward: *Task resumed* ${slug} by ${event.resumedBy}`;
    case "stage_retried":
      return `:repeat: *Stage retried* ${slug} — \`${event.stage}\` attempt ${event.attempt} feedback: "${event.feedback}"`;
    case "stage_skipped":
      return `:fast_forward: *Stage skipped* ${slug} — \`${event.stage}\``;
    case "stages_modified":
      return `:pencil: *Stages modified* ${slug} — old: [${event.oldStages.join(", ")}] new: [${event.newStages.join(", ")}]`;
  }
}

// ─── createSlackNotifier ──────────────────────────────────────────────────────

export function createSlackNotifier(options: SlackNotifierOptions): Notifier {
  const { channelId, notifyLevel, runtimeDir, onOutboxWrite } = options;
  const outboxPath = join(runtimeDir, "slack-outbox.jsonl");

  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify(notifyLevel, event)) return;

      const text = formatEvent(event);
      const threadMap = loadThreadMap(runtimeDir);

      let thread_ts: string | null = null;
      if (event.type === "task_created" && "slackThread" in event && event.slackThread) {
        thread_ts = event.slackThread;
      } else if (event.type !== "task_created") {
        thread_ts = threadMap[event.slug] ?? null;
      }

      const id = `evt-${Date.now()}-${randomBytes(3).toString("hex")}`;
      const entry = {
        id,
        slug: event.slug,
        type: event.type,
        channel: channelId,
        text,
        thread_ts,
        addedAt: new Date().toISOString(),
      };

      try {
        mkdirSync(dirname(outboxPath), { recursive: true });
        appendFileSync(outboxPath, JSON.stringify(entry) + "\n", "utf-8");
        onOutboxWrite?.();
      } catch {
        // swallow errors silently — never crash the pipeline
      }
    },
  };
}
