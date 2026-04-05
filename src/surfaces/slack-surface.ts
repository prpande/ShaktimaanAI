import * as fs from "node:fs";
import * as path from "node:path";

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

const CURSOR_FILENAME = "slack-cursor.json";
const DEFAULT_CURSOR: SlackCursor = { channelTs: "now", dmTs: "now" };

export function loadCursor(runtimeDir: string): SlackCursor {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SlackCursor;
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}

export function saveCursor(runtimeDir: string, cursor: SlackCursor): void {
  const filePath = path.join(runtimeDir, CURSOR_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf8");
}
