import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  id: string;
  slug: string;
  type: string;
  channel: string;
  text: string;
  thread_ts: string | null;
  addedAt: string;
}

export interface InboxEntry {
  ts: string;
  text: string;
  user: string;
  thread_ts?: string;
  channel: string;
  isApproval?: boolean;
  slug?: string;
}

export interface SentEntry {
  id: string;
  slug: string;
  ts: string;
  sentAt: string;
}

export interface NaradaPayload {
  outbox: OutboxEntry[];
  inbound: {
    channelId: string;
    oldest: string;
    dmUserIds: string[];
    dmOldest: string;
  };
  approvalChecks: Array<{ slug: string; thread_ts: string }>;
  conversationChecks: Array<{ key: string; thread_ts: string }>;
  outboundPrefix: string;
  files: {
    outbox: string;
    inbox: string;
    sent: string;
    threads: string;
    cursor: string;
  };
}

// ─── File helpers ───────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

// ─── Queue operations ───────────────────────────────────────────────────────

export function readOutbox(runtimeDir: string): OutboxEntry[] {
  return readJsonl<OutboxEntry>(join(runtimeDir, "slack-outbox.jsonl"));
}

export function readInbox(runtimeDir: string): InboxEntry[] {
  return readJsonl<InboxEntry>(join(runtimeDir, "slack-inbox.jsonl"));
}

export function clearInbox(runtimeDir: string): void {
  writeFileSync(join(runtimeDir, "slack-inbox.jsonl"), "", "utf-8");
}

export function readSentLog(runtimeDir: string): SentEntry[] {
  return readJsonl<SentEntry>(join(runtimeDir, "slack-sent.jsonl"));
}

export function loadThreadMap(runtimeDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "slack-threads.json"), "utf-8"));
  } catch {
    return {};
  }
}

export function saveThreadMap(runtimeDir: string, map: Record<string, string>): void {
  writeFileSync(join(runtimeDir, "slack-threads.json"), JSON.stringify(map, null, 2), "utf-8");
}

// ─── Payload builder ────────────────────────────────────────────────────────

export function buildNaradaPayload(
  runtimeDir: string,
  opts: {
    channelId: string;
    allowDMs: boolean;
    dmUserIds: string[];
    heldSlugs: string[];
    outboundPrefix?: string;
  },
): NaradaPayload {
  const outbox = readOutbox(runtimeDir);
  const threadMap = loadThreadMap(runtimeDir);

  const nowTs = String(Date.now() / 1000);
  let channelTs = nowTs;
  let dmTs = nowTs;
  try {
    const cursor = JSON.parse(readFileSync(join(runtimeDir, "slack-cursor.json"), "utf-8"));
    channelTs = cursor.channelTs === "now" ? nowTs : (cursor.channelTs ?? nowTs);
    dmTs = cursor.dmTs === "now" ? nowTs : (cursor.dmTs ?? nowTs);
  } catch { /* use defaults */ }

  const approvalChecks: Array<{ slug: string; thread_ts: string }> = [];
  for (const slug of opts.heldSlugs) {
    if (threadMap[slug]) {
      approvalChecks.push({ slug, thread_ts: threadMap[slug] });
    }
  }

  // Conversation threads: astra-* entries track threads where Astra answered directly
  const conversationChecks: Array<{ key: string; thread_ts: string }> = [];
  for (const [key, threadTs] of Object.entries(threadMap)) {
    if (key.startsWith("astra-")) {
      conversationChecks.push({ key, thread_ts: threadTs });
    }
  }

  return {
    outbox,
    inbound: {
      channelId: opts.channelId,
      oldest: channelTs,
      dmUserIds: opts.allowDMs ? opts.dmUserIds : [],
      dmOldest: dmTs,
    },
    approvalChecks,
    conversationChecks,
    outboundPrefix: opts.outboundPrefix ?? "🤖 [ShaktimaanAI]",
    files: {
      outbox: join(runtimeDir, "slack-outbox.jsonl"),
      inbox: join(runtimeDir, "slack-inbox.jsonl"),
      sent: join(runtimeDir, "slack-sent.jsonl"),
      threads: join(runtimeDir, "slack-threads.json"),
      cursor: join(runtimeDir, "slack-cursor.json"),
    },
  };
}
