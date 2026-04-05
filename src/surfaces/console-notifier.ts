import type { Notifier, NotifyEvent } from "./types.js";
import { shouldNotify } from "./types.js";

// ─── formatEvent ─────────────────────────────────────────────────────────────

function formatEvent(event: NotifyEvent): string {
  const prefix = `${event.timestamp} [${event.type}] ${event.slug}`;

  switch (event.type) {
    case "task_created":
      return `${prefix} title="${event.title}" source=${event.source} stages=[${event.stages.join(",")}]`;

    case "stage_started":
      return `${prefix} stage=${event.stage}`;

    case "stage_completed":
      return `${prefix} stage=${event.stage} artifact=${event.artifactPath}`;

    case "task_held":
      return `${prefix} stage=${event.stage} url=${event.artifactUrl}`;

    case "task_approved": {
      const fb = event.feedback != null ? ` feedback="${event.feedback}"` : "";
      return `${prefix} approvedBy=${event.approvedBy}${fb}`;
    }

    case "task_completed": {
      const pr = event.prUrl != null ? ` prUrl=${event.prUrl}` : "";
      return `${prefix}${pr}`;
    }

    case "task_failed":
      return `${prefix} stage=${event.stage} error="${event.error}"`;

    case "task_cancelled":
      return `${prefix} cancelledBy=${event.cancelledBy}`;

    case "task_paused":
      return `${prefix} pausedBy=${event.pausedBy}`;

    case "task_resumed":
      return `${prefix} resumedBy=${event.resumedBy}`;

    case "stage_retried":
      return `${prefix} stage=${event.stage} attempt=${event.attempt} feedback="${event.feedback}"`;

    case "stage_skipped":
      return `${prefix} stage=${event.stage}`;

    case "stages_modified":
      return `${prefix} old=[${event.oldStages.join(",")}] new=[${event.newStages.join(",")}]`;
  }
}

// ─── ConsoleNotifier factory ──────────────────────────────────────────────────

export function createConsoleNotifier(): Notifier {
  return {
    async notify(event: NotifyEvent): Promise<void> {
      if (!shouldNotify("stages", event)) return;
      console.log(formatEvent(event));
    },
  };
}
