import { mkdirSync, existsSync, readFileSync, appendFileSync, readdirSync } from "fs";
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
 * Appends an entry to {dir}/YYYY-MM-DD.jsonl (derived from entry.timestamp).
 * Each line is a self-contained JSON object. Concurrent writes are safe because
 * appendFileSync is atomic at the OS level for a single line with no read-modify-write.
 */
export function appendDailyLogEntry(dir: string, entry: DailyLogEntry): void {
  mkdirSync(dir, { recursive: true });

  // Extract YYYY-MM-DD from the ISO timestamp
  const dateStr = entry.timestamp.slice(0, 10);
  const filePath = join(dir, `${dateStr}.jsonl`);

  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// readDailyLog
// ---------------------------------------------------------------------------

/**
 * Reads {dir}/{date}.jsonl and parses each non-empty line into a DailyLogEntry.
 * Returns an empty array if the file does not exist.
 */
export function readDailyLog(dir: string, date: string): DailyLogEntry[] {
  const filePath = join(dir, `${date}.jsonl`);

  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DailyLogEntry);
}

// ---------------------------------------------------------------------------
// readAllDailyLogs
// ---------------------------------------------------------------------------

/**
 * Reads all JSONL daily log files from dir, optionally filtered by date range.
 * Returns entries sorted by timestamp ascending. Skips malformed lines with
 * a stderr warning. Returns [] if the directory doesn't exist or has no files.
 */
export function readAllDailyLogs(
  dir: string,
  options?: { from?: string; to?: string },
): DailyLogEntry[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort(); // alphabetical = chronological for YYYY-MM-DD.jsonl

  const entries: DailyLogEntry[] = [];

  for (const file of files) {
    // Extract date from filename (e.g., "2026-04-01.jsonl" → "2026-04-01")
    const date = file.replace(/\.jsonl$/, "");

    // Apply date range filter at the file level
    if (options?.from && date < options.from) continue;
    if (options?.to && date > options.to) continue;

    const filePath = join(dir, file);
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as DailyLogEntry);
      } catch {
        process.stderr.write(
          `Warning: skipping malformed line in ${file}: ${line.slice(0, 80)}\n`,
        );
      }
    }
  }

  // Sort by timestamp ascending
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries;
}
