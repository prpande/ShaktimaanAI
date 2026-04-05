// ─── NotifyLevel ─────────────────────────────────────────────────────────────

export type NotifyLevel = "minimal" | "bookends" | "stages";

// ─── NotifyEvent base ────────────────────────────────────────────────────────

interface EventBase {
  slug: string;
  timestamp: string;
}

// ─── NotifyEvent discriminated union ─────────────────────────────────────────

export type NotifyEvent =
  | ({ type: "task_created";    title: string; source: string; stages: string[] } & EventBase)
  | ({ type: "stage_started";   stage: string } & EventBase)
  | ({ type: "stage_completed"; stage: string; artifactPath: string } & EventBase)
  | ({ type: "task_held";       stage: string; artifactUrl: string } & EventBase)
  | ({ type: "task_approved";   approvedBy: string; feedback?: string } & EventBase)
  | ({ type: "task_completed";  prUrl?: string } & EventBase)
  | ({ type: "task_failed";     stage: string; error: string } & EventBase)
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
