import { readFileSync, writeFileSync } from "node:fs";

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

export function readOutbox(outboxPath: string): OutboxEntry[] {
  return readJsonl<OutboxEntry>(outboxPath);
}

export function readInbox(inboxPath: string): InboxEntry[] {
  return readJsonl<InboxEntry>(inboxPath);
}

export function clearInbox(inboxPath: string): void {
  writeFileSync(inboxPath, "", "utf-8");
}

export function readSentLog(sentPath: string): SentEntry[] {
  return readJsonl<SentEntry>(sentPath);
}

export function loadThreadMap(threadsPath: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(threadsPath, "utf-8"));
  } catch {
    return {};
  }
}

export function saveThreadMap(threadsPath: string, map: Record<string, string>): void {
  writeFileSync(threadsPath, JSON.stringify(map, null, 2), "utf-8");
}

// ─── Payload builder ────────────────────────────────────────────────────────

export interface NaradaPayloadPaths {
  outbox: string;
  inbox: string;
  sent: string;
  threads: string;
  cursor: string;
}

/**
 * Builds a Narada payload from explicit file paths (from config.paths).
 */
export function buildNaradaPayload(
  filePaths: NaradaPayloadPaths,
  opts: {
    channelId: string;
    allowDMs: boolean;
    dmUserIds: string[];
    heldSlugs: string[];
    outboundPrefix?: string;
  },
): NaradaPayload {
  const outbox = readOutbox(filePaths.outbox);
  const threadMap = loadThreadMap(filePaths.threads);

  const nowTs = String(Date.now() / 1000);
  let channelTs = nowTs;
  let dmTs = nowTs;
  try {
    const cursor = JSON.parse(readFileSync(filePaths.cursor, "utf-8"));
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
    files: filePaths,
  };
}
