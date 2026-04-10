import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  readOutbox,
  readInbox,
  clearInbox,
  readSentLog,
  loadThreadMap,
  saveThreadMap,
  buildNaradaPayload,
} from "../../src/core/slack-queue.js";

let TEST_DIR: string;

// Convenience helpers — full file paths
let outboxPath: string;
let inboxPath: string;
let sentPath: string;
let threadsPath: string;
let cursorPath: string;

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-slack-queue-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
  outboxPath  = join(TEST_DIR, "slack-outbox.jsonl");
  inboxPath   = join(TEST_DIR, "slack-inbox.jsonl");
  sentPath    = join(TEST_DIR, "slack-sent.jsonl");
  threadsPath = join(TEST_DIR, "slack-threads.json");
  cursorPath  = join(TEST_DIR, "slack-cursor.json");
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readOutbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readOutbox(outboxPath)).toEqual([]);
  });

  it("parses JSONL lines into array", () => {
    writeFileSync(outboxPath, '{"id":"a","text":"hello"}\n{"id":"b","text":"world"}\n');
    const entries = readOutbox(outboxPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("a");
    expect(entries[1].id).toBe("b");
  });

  it("skips blank lines", () => {
    writeFileSync(outboxPath, '{"id":"a"}\n\n{"id":"b"}\n');
    expect(readOutbox(outboxPath)).toHaveLength(2);
  });
});

describe("readInbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readInbox(inboxPath)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(inboxPath, '{"ts":"1","text":"hi"}\n');
    expect(readInbox(inboxPath)).toHaveLength(1);
  });
});

describe("clearInbox", () => {
  it("writes empty file", () => {
    writeFileSync(inboxPath, '{"ts":"1"}\n');
    clearInbox(inboxPath);
    expect(readFileSync(inboxPath, "utf-8")).toBe("");
  });
});

describe("readSentLog", () => {
  it("returns empty array when file does not exist", () => {
    expect(readSentLog(sentPath)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(sentPath, '{"id":"evt-1","ts":"1.1"}\n');
    expect(readSentLog(sentPath)).toHaveLength(1);
  });
});

describe("loadThreadMap / saveThreadMap", () => {
  it("returns empty object when file does not exist", () => {
    expect(loadThreadMap(threadsPath)).toEqual({});
  });

  it("round-trips thread map", () => {
    saveThreadMap(threadsPath, { "slug-a": "1.1", "slug-b": "2.2" });
    expect(loadThreadMap(threadsPath)).toEqual({ "slug-a": "1.1", "slug-b": "2.2" });
  });
});

describe("buildNaradaPayload", () => {
  it("builds correct payload from queue state", () => {
    writeFileSync(outboxPath, '{"id":"evt-1","slug":"s1","text":"hi","channel":"C1","thread_ts":null}\n');
    writeFileSync(cursorPath, '{"channelTs":"100.0","dmTs":"100.0"}');
    saveThreadMap(threadsPath, { "held-task": "200.0" });

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: ["held-task"],
      },
    );

    expect(payload.outbox).toHaveLength(1);
    expect(payload.inbound.channelId).toBe("C1");
    expect(payload.inbound.oldest).toBe("100.0");
    expect(payload.approvalChecks).toHaveLength(1);
    expect(payload.approvalChecks[0].slug).toBe("held-task");
    expect(payload.approvalChecks[0].thread_ts).toBe("200.0");
  });

  it("skips approval checks for held tasks without threads", () => {
    writeFileSync(cursorPath, '{"channelTs":"100.0","dmTs":"100.0"}');

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: ["no-thread-task"],
      },
    );

    expect(payload.approvalChecks).toHaveLength(0);
  });

  it("includes DM user IDs when allowDMs is true", () => {
    writeFileSync(cursorPath, '{"channelTs":"100.0","dmTs":"50.0"}');

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: true,
        dmUserIds: ["U111", "U222"],
        heldSlugs: [],
      },
    );

    expect(payload.inbound.dmUserIds).toEqual(["U111", "U222"]);
    expect(payload.inbound.dmOldest).toBe("50.0");
  });

  it("includes outboundPrefix in payload when provided", () => {
    writeFileSync(cursorPath, '{"channelTs":"1.0","dmTs":"1.0"}');

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: [],
        outboundPrefix: "🤖 [TestBot]",
      },
    );

    expect(payload.outboundPrefix).toBe("🤖 [TestBot]");
  });

  it("uses default outboundPrefix when not provided", () => {
    writeFileSync(cursorPath, '{"channelTs":"1.0","dmTs":"1.0"}');

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: [],
      },
    );

    expect(payload.outboundPrefix).toBe("🤖 [ShaktimaanAI]");
  });

  it("includes astra-* threads in conversationChecks", () => {
    writeFileSync(cursorPath, '{"channelTs":"100.0","dmTs":"100.0"}');
    saveThreadMap(threadsPath, {
      "held-task": "200.0",
      "astra-1775638845-450169": "300.0",
      "astra-1775639000-123456": "400.0",
    });

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: ["held-task"],
      },
    );

    expect(payload.approvalChecks).toHaveLength(1);
    expect(payload.conversationChecks).toHaveLength(2);
    expect(payload.conversationChecks[0].key).toBe("astra-1775638845-450169");
    expect(payload.conversationChecks[0].thread_ts).toBe("300.0");
    expect(payload.conversationChecks[1].key).toBe("astra-1775639000-123456");
    expect(payload.conversationChecks[1].thread_ts).toBe("400.0");
  });

  it("returns empty conversationChecks when no astra threads exist", () => {
    writeFileSync(cursorPath, '{"channelTs":"1.0","dmTs":"1.0"}');
    saveThreadMap(threadsPath, { "task-slug": "200.0" });

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: [],
      },
    );

    expect(payload.conversationChecks).toHaveLength(0);
  });

  it("includes file paths in payload", () => {
    writeFileSync(cursorPath, '{"channelTs":"1.0","dmTs":"1.0"}');

    const payload = buildNaradaPayload(
      { outbox: outboxPath, inbox: inboxPath, sent: sentPath, threads: threadsPath, cursor: cursorPath },
      {
        channelId: "C1",
        allowDMs: false,
        dmUserIds: [],
        heldSlugs: [],
      },
    );

    expect(payload.files.outbox).toContain("slack-outbox.jsonl");
    expect(payload.files.inbox).toContain("slack-inbox.jsonl");
    expect(payload.files.sent).toContain("slack-sent.jsonl");
    expect(payload.files.threads).toContain("slack-threads.json");
    expect(payload.files.cursor).toContain("slack-cursor.json");
  });
});
