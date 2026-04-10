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
  timezone?: string;
  /** Explicit path to slack-outbox.jsonl — overrides join(runtimeDir, "slack-outbox.jsonl"). */
  outboxPath?: string;
  /** Called after writing to outbox — wire to triggerNaradaSend for immediate delivery. */
  onOutboxWrite?: () => void;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

export function formatTime(iso: string, timezone: string): string {
  const formatOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  try {
    const time = new Intl.DateTimeFormat("en-US", {
      ...formatOptions,
      timeZone: timezone,
    }).format(new Date(iso));
    return `${time} ${timezone}`;
  } catch {
    const time = new Intl.DateTimeFormat("en-US", {
      ...formatOptions,
      timeZone: "UTC",
    }).format(new Date(iso));
    return `${time} UTC`;
  }
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

export function formatEvent(event: NotifyEvent, timezone: string = "UTC"): string {
  const slug = `\`${event.slug}\``;
  const ts = `🕐 ${formatTime(event.timestamp, timezone)}`;

  switch (event.type) {
    case "task_created":
      return `\n${ts}\n🚀 *Task created* ${slug}\n📋 stages: ${event.stages.join(", ")}`;

    case "stage_started": {
      const agent = event.agentName ? ` — ${event.agentName}` : "";
      return `\n${ts}\n▶️ *${event.stage}* started ${slug}${agent}`;
    }

    case "stage_completed": {
      const model = event.model ? ` (${event.model})` : "";
      const agent = event.agentName ?? event.stage;
      const lines = [`\n${ts}`, `✅ *${event.stage}* completed ${slug} — ${agent}${model}`];
      if (event.verdict) lines.push(`📋 Verdict: ${event.verdict}`);
      const metrics = formatMetrics(event);
      if (metrics) lines.push(metrics);
      return lines.join("\n");
    }

    case "task_held": {
      if (event.holdReason === "budget_exhausted") {
        const model = event.model ? ` (${event.model})` : "";
        const agent = event.agentName ?? event.stage;
        const lines = [`\n${ts}`, `✋ *${event.stage}* held ${slug} — ${agent}${model}`];
        if (event.holdDetail) lines.push(`💸 Budget exhausted: ${event.holdDetail}`);
        return lines.join("\n");
      }
      if (event.holdReason === "approval_required") {
        return `\n${ts}\n✋ *${event.stage}* completed ${slug} — awaiting approval`;
      }
      // Fallback for any other hold reason
      return `\n${ts}\n✋ *${event.stage}* held ${slug} — awaiting review`;
    }

    case "task_approved": {
      const fb = event.feedback ? `\n📋 "${event.feedback}"` : "";
      return `\n${ts}\n👍 *Task approved* ${slug} by ${event.approvedBy}${fb}`;
    }

    case "task_completed": {
      const lines = [`\n${ts}`, `🎉 *Task completed* ${slug}`];
      if (event.prUrl) lines[1] += ` PR: ${event.prUrl}`;

      if (event.completedStages && event.completedStages.length > 0) {
        // Dedup: keep last entry per stage (handles retries)
        const stageMap = new Map<string, typeof event.completedStages[number]>();
        for (const s of event.completedStages) {
          stageMap.set(s.stage, s);
        }
        const stages = [...stageMap.values()];

        // Sum ALL entries including retries for accurate total cost
        const totalCost = event.completedStages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
        // Total duration from startedAt to event timestamp
        let totalDurationStr = "";
        if (event.startedAt) {
          const totalSec = Math.round(
            (new Date(event.timestamp).getTime() - new Date(event.startedAt).getTime()) / 1000,
          );
          if (totalSec > 0) totalDurationStr = `⏱ Total: ${formatDuration(totalSec)} · `;
        }

        lines.push("");
        lines.push(`📊 *Pipeline Summary*`);
        const retryCost = event.completedStages.length > stages.length ? " (incl. retries)" : "";
        lines.push(`${totalDurationStr}💰 $${totalCost.toFixed(2)}${retryCost}`);
        lines.push("");
        lines.push("| Stage | Agent | Model | Duration | Cost | Tokens |");
        lines.push("|-------|-------|-------|----------|------|--------|");

        for (const s of stages) {
          const agentName = event.agentNames?.[s.stage] ?? s.stage;
          const model = s.model ?? "-";
          const duration = s.durationSeconds != null ? formatDuration(s.durationSeconds) : "-";
          const totalTokens = ((s.inputTokens ?? 0) + (s.outputTokens ?? 0)).toLocaleString("en-US");
          const cost = s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : "-";
          lines.push(`| ${s.stage} | ${agentName} | ${model} | ${duration} | ${cost} | ${totalTokens} |`);
        }
      }

      return lines.join("\n");
    }

    case "task_failed": {
      const model = event.model ? ` (${event.model})` : "";
      const agent = event.agentName ?? event.stage;
      const lines = [`\n${ts}`, `❌ *${event.stage}* failed ${slug} — ${agent}${model}`];
      lines.push(`⚠️ ${event.error}`);
      const metrics = formatMetrics(event);
      if (metrics) lines.push(metrics);
      return lines.join("\n");
    }

    case "task_cancelled":
      return `\n${ts}\n🚫 *Task cancelled* ${slug} by ${event.cancelledBy}`;

    case "task_paused":
      return `\n${ts}\n⏸ *Task paused* ${slug} by ${event.pausedBy}`;

    case "task_resumed":
      return `\n${ts}\n▶️ *Task resumed* ${slug} by ${event.resumedBy}`;

    case "stage_retried":
      return `\n${ts}\n🔁 *${event.stage}* retried ${slug} — attempt ${event.attempt}\n📋 feedback: "${event.feedback}"`;

    case "stage_skipped":
      return `\n${ts}\n⏭ *${event.stage}* skipped ${slug}`;

    case "stages_modified":
      return `\n${ts}\n✏️ *Stages modified* ${slug}\n📋 old: ${event.oldStages.join(", ")}\n📋 new: ${event.newStages.join(", ")}`;

    case "recovery_diagnosed": {
      if (event.classification === "terminal") {
        return `\n${ts}\n🔬 *Recovery: terminal failure* ${slug} at *${event.stage}*\n📋 ${event.diagnosis}`;
      }
      const issueLine = event.issueUrl ? `\n🔗 Issue: ${event.issueUrl}` : "";
      const reentryLine = event.reEntryStage ? `\n🔄 Re-entry: \`${event.reEntryStage}\` after fix` : "";
      return `\n${ts}\n🔬 *Recovery: fixable* ${slug} at *${event.stage}*\n📋 ${event.diagnosis}${issueLine}${reentryLine}\n💡 Reply \`recover\` in this thread after merging the fix.`;
    }
  }
}

// ─── createSlackNotifier ──────────────────────────────────────────────────────

export function createSlackNotifier(options: SlackNotifierOptions): Notifier {
  const { channelId, notifyLevel, runtimeDir, onOutboxWrite } = options;
  const outboxPath = options.outboxPath ?? join(runtimeDir, "slack-outbox.jsonl");

  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify(notifyLevel, event)) return;

      const text = formatEvent(event, options.timezone);
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
      } catch (err) {
        console.warn(`[slack-notifier] Failed to write outbox entry: ${(err as Error).message}`);
      }
    },
  };
}
