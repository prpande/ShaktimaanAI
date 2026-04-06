import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `shkmn-slack-queue-${randomUUID()}`);
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readOutbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readOutbox(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines into array", () => {
    writeFileSync(join(TEST_DIR, "slack-outbox.jsonl"), '{"id":"a","text":"hello"}\n{"id":"b","text":"world"}\n');
    const entries = readOutbox(TEST_DIR);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("a");
    expect(entries[1].id).toBe("b");
  });

  it("skips blank lines", () => {
    writeFileSync(join(TEST_DIR, "slack-outbox.jsonl"), '{"id":"a"}\n\n{"id":"b"}\n');
    expect(readOutbox(TEST_DIR)).toHaveLength(2);
  });
});

describe("readInbox", () => {
  it("returns empty array when file does not exist", () => {
    expect(readInbox(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(join(TEST_DIR, "slack-inbox.jsonl"), '{"ts":"1","text":"hi"}\n');
    expect(readInbox(TEST_DIR)).toHaveLength(1);
  });
});

describe("clearInbox", () => {
  it("writes empty file", () => {
    writeFileSync(join(TEST_DIR, "slack-inbox.jsonl"), '{"ts":"1"}\n');
    clearInbox(TEST_DIR);
    expect(readFileSync(join(TEST_DIR, "slack-inbox.jsonl"), "utf-8")).toBe("");
  });
});

describe("readSentLog", () => {
  it("returns empty array when file does not exist", () => {
    expect(readSentLog(TEST_DIR)).toEqual([]);
  });

  it("parses JSONL lines", () => {
    writeFileSync(join(TEST_DIR, "slack-sent.jsonl"), '{"id":"evt-1","ts":"1.1"}\n');
    expect(readSentLog(TEST_DIR)).toHaveLength(1);
  });
});

describe("loadThreadMap / saveThreadMap", () => {
  it("returns empty object when file does not exist", () => {
    expect(loadThreadMap(TEST_DIR)).toEqual({});
  });

  it("round-trips thread map", () => {
    saveThreadMap(TEST_DIR, { "slug-a": "1.1", "slug-b": "2.2" });
    expect(loadThreadMap(TEST_DIR)).toEqual({ "slug-a": "1.1", "slug-b": "2.2" });
  });
});

describe("buildNaradaPayload", () => {
  it("builds correct payload from queue state", () => {
    writeFileSync(join(TEST_DIR, "slack-outbox.jsonl"), '{"id":"evt-1","slug":"s1","text":"hi","channel":"C1","thread_ts":null}\n');
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');
    saveThreadMap(TEST_DIR, { "held-task": "200.0" });

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: false,
      dmUserIds: [],
      heldSlugs: ["held-task"],
    });

    expect(payload.outbox).toHaveLength(1);
    expect(payload.inbound.channelId).toBe("C1");
    expect(payload.inbound.oldest).toBe("100.0");
    expect(payload.approvalChecks).toHaveLength(1);
    expect(payload.approvalChecks[0].slug).toBe("held-task");
    expect(payload.approvalChecks[0].thread_ts).toBe("200.0");
  });

  it("skips approval checks for held tasks without threads", () => {
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"100.0"}');

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: false,
      dmUserIds: [],
      heldSlugs: ["no-thread-task"],
    });

    expect(payload.approvalChecks).toHaveLength(0);
  });

  it("includes DM user IDs when allowDMs is true", () => {
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"100.0","dmTs":"50.0"}');

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: true,
      dmUserIds: ["U111", "U222"],
      heldSlugs: [],
    });

    expect(payload.inbound.dmUserIds).toEqual(["U111", "U222"]);
    expect(payload.inbound.dmOldest).toBe("50.0");
  });

  it("includes file paths in payload", () => {
    writeFileSync(join(TEST_DIR, "slack-cursor.json"), '{"channelTs":"1.0","dmTs":"1.0"}');

    const payload = buildNaradaPayload(TEST_DIR, {
      channelId: "C1",
      allowDMs: false,
      dmUserIds: [],
      heldSlugs: [],
    });

    expect(payload.files.outbox).toContain("slack-outbox.jsonl");
    expect(payload.files.inbox).toContain("slack-inbox.jsonl");
    expect(payload.files.sent).toContain("slack-sent.jsonl");
    expect(payload.files.threads).toContain("slack-threads.json");
    expect(payload.files.cursor).toContain("slack-cursor.json");
  });
});
