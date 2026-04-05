import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractionEntry {
  timestamp: string;
  source: string;      // "cli" | "slack"
  intent: string;      // "create_task", "approve", etc.
  message: string;     // raw user message
  action: string;      // what happened
  stageHints?: string; // optional
  targetStage?: string; // optional
}

export interface DailyLogEntry {
  timestamp: string;  // ISO 8601
  type: string;       // "interaction", "agent_started", "agent_completed", etc.
  slug: string;
  [key: string]: unknown;  // additional fields vary by type
}

// ---------------------------------------------------------------------------
// appendInteraction
// ---------------------------------------------------------------------------

/**
 * Appends a human-initiated interaction entry to {dir}/interactions.md.
 * Creates the file with a header on first write.
 */
export function appendInteraction(dir: string, slug: string, entry: InteractionEntry): void {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "interactions.md");

  const isNew = !existsSync(filePath);

  const lines: string[] = [];

  if (isNew) {
    lines.push(`# Interactions — ${slug}`, "");
  }

  lines.push(`### ${entry.timestamp} — ${entry.source}`);
  lines.push("");
  lines.push(`**Intent:** ${entry.intent}`);

  if (entry.targetStage !== undefined) {
    lines.push(`**Target stage:** ${entry.targetStage}`);
  }

  lines.push(`**Message:** "${entry.message}"`);

  if (entry.stageHints !== undefined) {
    lines.push(`**Stage hints:** ${entry.stageHints}`);
  }

  lines.push(`**Action:** ${entry.action}`);
  lines.push("");

  appendFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// appendDailyLogEntry
// ---------------------------------------------------------------------------

/**
 * Appends an entry to {dir}/YYYY-MM-DD.json (derived from entry.timestamp).
 * Creates the file with an empty array on first write, then reads + pushes + writes.
 */
export function appendDailyLogEntry(dir: string, entry: DailyLogEntry): void {
  mkdirSync(dir, { recursive: true });

  // Extract YYYY-MM-DD from the ISO timestamp
  const dateStr = entry.timestamp.slice(0, 10);
  const filePath = join(dir, `${dateStr}.json`);

  let entries: DailyLogEntry[] = [];

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      entries = JSON.parse(raw) as DailyLogEntry[];
    } catch {
      // If the file is corrupt, start fresh
      entries = [];
    }
  }

  entries.push(entry);
  writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
}
