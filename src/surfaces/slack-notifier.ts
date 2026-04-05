import type { Notifier, NotifyEvent, NotifyLevel } from "./types.js";
import { shouldNotify } from "./types.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SlackNotifierOptions {
  channelId: string;
  notifyLevel: NotifyLevel;
  sendMessage: (params: { channel: string; text: string; thread_ts?: string }) => Promise<{ ts: string }>;
}

// ─── formatEvent ─────────────────────────────────────────────────────────────

function formatEvent(event: NotifyEvent): string {
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
  const { channelId, notifyLevel, sendMessage } = options;
  const threadMap = new Map<string, string>();

  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify(notifyLevel, event)) return;

      const text = formatEvent(event);
      const thread_ts = event.type === "task_created" ? undefined : threadMap.get(event.slug);

      try {
        const result = await sendMessage({ channel: channelId, text, thread_ts });
        if (event.type === "task_created") {
          threadMap.set(event.slug, result.ts);
        }
      } catch {
        // swallow errors silently
      }
    },
  };
}
