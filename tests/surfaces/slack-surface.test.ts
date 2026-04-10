import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { filterMessages, stripPrefix, loadCursor, saveCursor } from "../../src/surfaces/slack-surface.js";
import type { SlackMessage } from "../../src/surfaces/slack-surface.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    ts: "1000.0001",
    text: "Hello world",
    user: "U_HUMAN",
    thread_ts: undefined,
    ...overrides,
  };
}

// ─── filterMessages ───────────────────────────────────────────────────────────

describe("filterMessages", () => {
  it("skips messages from botUserId", () => {
    const msgs = [makeMsg({ user: "U_BOT" }), makeMsg({ user: "U_HUMAN" })];
    const result = filterMessages(msgs, "U_BOT", "0", false, "!");
    expect(result).toHaveLength(1);
    expect(result[0].user).toBe("U_HUMAN");
  });

  it("skips messages with ts <= lastSeenTs", () => {
    const msgs = [
      makeMsg({ ts: "999.0000" }),
      makeMsg({ ts: "1000.0000" }),
      makeMsg({ ts: "1001.0000" }),
    ];
    const result = filterMessages(msgs, "U_BOT", "1000.0000", false, "!");
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe("1001.0000");
  });

  it("skips non-prefixed messages when requirePrefix=true", () => {
    const msgs = [makeMsg({ text: "hello world" })];
    const result = filterMessages(msgs, "U_BOT", "0", true, "!");
    expect(result).toHaveLength(0);
  });

  it("passes prefixed messages when requirePrefix=true", () => {
    const msgs = [makeMsg({ text: "! do something" })];
    const result = filterMessages(msgs, "U_BOT", "0", true, "!");
    expect(result).toHaveLength(1);
  });

  it("passes all non-bot messages when requirePrefix=false", () => {
    const msgs = [
      makeMsg({ text: "hello" }),
      makeMsg({ text: "world" }),
      makeMsg({ user: "U_BOT", text: "bot msg" }),
    ];
    const result = filterMessages(msgs, "U_BOT", "0", false, "!");
    expect(result).toHaveLength(2);
  });

  it("passes thread replies without prefix even when requirePrefix=true", () => {
    const msgs = [makeMsg({ text: "no prefix here", thread_ts: "1000.0000" })];
    const result = filterMessages(msgs, "U_BOT", "0", true, "!");
    expect(result).toHaveLength(1);
  });

  it("skips thread replies from bot even with requirePrefix=false", () => {
    const msgs = [makeMsg({ user: "U_BOT", text: "bot reply", thread_ts: "1000.0000" })];
    const result = filterMessages(msgs, "U_BOT", "0", false, "!");
    expect(result).toHaveLength(0);
  });

  it("skips thread replies with ts <= lastSeenTs", () => {
    const msgs = [makeMsg({ ts: "500.0000", thread_ts: "400.0000" })];
    const result = filterMessages(msgs, "U_BOT", "500.0000", false, "!");
    expect(result).toHaveLength(0);
  });
});

// ─── stripPrefix ─────────────────────────────────────────────────────────────

describe("stripPrefix", () => {
  it("removes prefix from start of text and trims", () => {
    expect(stripPrefix("! do something", "!")).toBe("do something");
  });

  it("removes prefix case-insensitively", () => {
    expect(stripPrefix("Hey do this", "hey")).toBe("do this");
  });

  it("returns text unchanged when no prefix match", () => {
    expect(stripPrefix("hello world", "!")).toBe("hello world");
  });

  it("handles prefix with trailing space in text", () => {
    expect(stripPrefix("!   trim me", "!")).toBe("trim me");
  });

  it("handles multi-character prefix", () => {
    expect(stripPrefix("@bot do something", "@bot")).toBe("do something");
  });

  it("does not strip prefix that appears in middle of text", () => {
    expect(stripPrefix("hello ! world", "!")).toBe("hello ! world");
  });
});

// ─── loadCursor / saveCursor ─────────────────────────────────────────────────

describe("loadCursor", () => {
  it("returns defaults when file is missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    const cursor = loadCursor(path.join(tmpDir, "slack-cursor.json"));
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
    fs.rmdirSync(tmpDir);
  });

  it("returns defaults when file is corrupt JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    fs.writeFileSync(path.join(tmpDir, "slack-cursor.json"), "not-json");
    const cursor = loadCursor(path.join(tmpDir, "slack-cursor.json"));
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
    fs.rmdirSync(tmpDir, { recursive: true } as fs.RmDirOptions);
  });

  it("returns defaults when JSON has wrong shape (missing fields)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    fs.writeFileSync(path.join(tmpDir, "slack-cursor.json"), JSON.stringify({ foo: "bar" }));
    const cursor = loadCursor(path.join(tmpDir, "slack-cursor.json"));
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when field types are wrong", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    fs.writeFileSync(path.join(tmpDir, "slack-cursor.json"), JSON.stringify({ channelTs: 123, dmTs: true }));
    const cursor = loadCursor(path.join(tmpDir, "slack-cursor.json"));
    expect(cursor).toEqual({ channelTs: "now", dmTs: "now" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid cursor correctly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    fs.writeFileSync(path.join(tmpDir, "slack-cursor.json"), JSON.stringify({ channelTs: "1234.5678", dmTs: "9876.5432" }));
    const cursor = loadCursor(path.join(tmpDir, "slack-cursor.json"));
    expect(cursor).toEqual({ channelTs: "1234.5678", dmTs: "9876.5432" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("saveCursor / loadCursor round-trip", () => {
  it("persists cursor and reads it back", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shai-test-"));
    const cursorPath = path.join(tmpDir, "slack-cursor.json");
    const cursor = { channelTs: "1234.5678", dmTs: "9999.0000" };
    saveCursor(cursorPath, cursor);
    const loaded = loadCursor(cursorPath);
    expect(loaded).toEqual(cursor);
    fs.rmdirSync(tmpDir, { recursive: true } as fs.RmDirOptions);
  });
});
