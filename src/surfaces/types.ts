// ─── NotifyLevel ─────────────────────────────────────────────────────────────

export type NotifyLevel = "minimal" | "bookends" | "stages";

// ─── NotifyEvent base ────────────────────────────────────────────────────────

interface EventBase {
  slug: string;
  timestamp: string;
}

// ─── NotifyEvent discriminated union ─────────────────────────────────────────

export type NotifyEvent =
  | ({ type: "task_created";    title: string; source: string; stages: string[]; slackThread?: string } & EventBase)
  | ({ type: "stage_started";   stage: string; agentName?: string } & EventBase)
  | ({ type: "stage_completed"; stage: string; artifactPath: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       verdict?: string; agentName?: string } & EventBase)
  | ({ type: "task_held";       stage: string; artifactUrl: string;
       holdReason?: string; holdDetail?: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       agentName?: string } & EventBase)
  | ({ type: "task_approved";   approvedBy: string; feedback?: string } & EventBase)
  | ({ type: "task_completed";  prUrl?: string;
       completedStages?: Array<{ stage: string; completedAt: string;
         costUsd?: number; turns?: number; inputTokens?: number;
         outputTokens?: number; model?: string }>;
       startedAt?: string;
       agentNames?: Record<string, string> } & EventBase)
  | ({ type: "task_failed";     stage: string; error: string;
       durationSeconds?: number; costUsd?: number; model?: string;
       inputTokens?: number; outputTokens?: number; turns?: number;
       agentName?: string } & EventBase)
  | ({ type: "task_cancelled";  cancelledBy: string } & EventBase)
  | ({ type: "task_paused";     pausedBy: string } & EventBase)
  | ({ type: "task_resumed";    resumedBy: string } & EventBase)
  | ({ type: "stage_retried";   stage: string; attempt: number; feedback: string } & EventBase)
  | ({ type: "stage_skipped";   stage: string } & EventBase)
  | ({ type: "stages_modified"; oldStages: string[]; newStages: string[] } & EventBase);

// ─── Notifier interface ───────────────────────────────────────────────────────

export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}

// ─── shouldNotify ─────────────────────────────────────────────────────────────

const MINIMAL_EVENTS = new Set<NotifyEvent["type"]>([
  "task_held",
  "task_failed",
]);

const BOOKENDS_EVENTS = new Set<NotifyEvent["type"]>([
  ...MINIMAL_EVENTS,
  "task_created",
  "task_completed",
  "task_cancelled",
]);

export function shouldNotify(level: NotifyLevel, event: NotifyEvent): boolean {
  switch (level) {
    case "minimal":
      return MINIMAL_EVENTS.has(event.type);
    case "bookends":
      return BOOKENDS_EVENTS.has(event.type);
    case "stages":
      return true;
  }
}
