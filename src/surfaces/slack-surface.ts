import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  thread_ts: string | undefined;
}

export interface SlackCursor {
  channelTs: string;
  dmTs: string;
}

// ─── filterMessages ───────────────────────────────────────────────────────────

export function filterMessages(
  messages: SlackMessage[],
  botUserId: string,
  lastSeenTs: string,
  requirePrefix: boolean,
  prefix: string,
): SlackMessage[] {
  return messages.filter((msg) => {
    // Skip bot's own messages
    if (msg.user === botUserId) return false;

    // Skip already-processed messages (compare numerically — Slack timestamps are decimal strings)
    if (parseFloat(msg.ts) <= parseFloat(lastSeenTs)) return false;

    // Thread replies always pass (prefix not required)
    if (msg.thread_ts !== undefined) return true;

    // Non-thread messages: apply prefix filter if required
    if (requirePrefix) {
      return msg.text.toLowerCase().startsWith(prefix.toLowerCase());
    }

    return true;
  });
}

// ─── stripPrefix ─────────────────────────────────────────────────────────────

export function stripPrefix(text: string, prefix: string): string {
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return text.slice(prefix.length).trim();
  }
  return text;
}

// ─── Cursor persistence ───────────────────────────────────────────────────────

const DEFAULT_CURSOR: SlackCursor = { channelTs: "now", dmTs: "now" };

const slackCursorSchema = z.object({
  channelTs: z.string(),
  dmTs: z.string(),
});

/**
 * Loads the Slack cursor from disk.
 * Accepts either a runtimeDir (derives path as join(runtimeDir, "slack-cursor.json"))
 * or an explicit cursorPath (from config.paths.slackCursor).
 */
export function loadCursor(runtimeDirOrPath: string, cursorPath?: string): SlackCursor {
  const filePath = cursorPath ?? path.join(runtimeDirOrPath, "slack-cursor.json");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = slackCursorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_CURSOR };
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}

/**
 * Saves the Slack cursor to disk.
 * Accepts either a runtimeDir (derives path as join(runtimeDir, "slack-cursor.json"))
 * or an explicit cursorPath (from config.paths.slackCursor).
 */
export function saveCursor(runtimeDirOrPath: string, cursor: SlackCursor, cursorPath?: string): void {
  const filePath = cursorPath ?? path.join(runtimeDirOrPath, "slack-cursor.json");
  fs.writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf8");
}
