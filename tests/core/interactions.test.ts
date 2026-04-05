import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendInteraction,
  appendDailyLogEntry,
  readDailyLog,
  type InteractionEntry,
  type DailyLogEntry,
} from "../../src/core/interactions.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-interactions-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// appendInteraction
// ---------------------------------------------------------------------------

describe("appendInteraction", () => {
  it("creates interactions.md with header on first write", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "build the auth module",
      action: "task created",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const filePath = join(TEST_DIR, "interactions.md");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("# Interactions — my-slug");
  });

  it("appends entry fields to interactions.md", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "build the auth module",
      action: "task created",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");
    expect(content).toContain("### 2026-04-05T10:00:00.000Z — cli");
    expect(content).toContain("**Intent:** create_task");
    expect(content).toContain('**Message:** "build the auth module"');
    expect(content).toContain("**Action:** task created");
  });

  it("appends a second entry without re-writing the header", () => {
    const entry1: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "first message",
      action: "task created",
    };
    const entry2: InteractionEntry = {
      timestamp: "2026-04-05T11:00:00.000Z",
      source: "slack",
      intent: "approve",
      message: "looks good",
      action: "stage approved",
    };

    appendInteraction(TEST_DIR, "my-slug", entry1);
    appendInteraction(TEST_DIR, "my-slug", entry2);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");

    // Header appears exactly once
    const headerCount = (content.match(/# Interactions — my-slug/g) ?? []).length;
    expect(headerCount).toBe(1);

    // Both entries are present
    expect(content).toContain("first message");
    expect(content).toContain("looks good");
    expect(content).toContain("### 2026-04-05T11:00:00.000Z — slack");
  });

  it("includes optional targetStage when provided", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "retry",
      message: "retry the build stage",
      action: "stage retried",
      targetStage: "build",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");
    expect(content).toContain("**Target stage:** build");
  });

  it("omits targetStage line when not provided", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "hello",
      action: "task created",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");
    expect(content).not.toContain("**Target stage:**");
  });

  it("includes optional stageHints when provided", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "slack",
      intent: "create_task",
      message: "new task with hints",
      action: "task created",
      stageHints: "design,build",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");
    expect(content).toContain("**Stage hints:** design,build");
  });

  it("omits stageHints line when not provided", () => {
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "no hints here",
      action: "task created",
    };

    appendInteraction(TEST_DIR, "my-slug", entry);

    const content = readFileSync(join(TEST_DIR, "interactions.md"), "utf8");
    expect(content).not.toContain("**Stage hints:**");
  });

  it("creates directory if it does not exist", () => {
    const nestedDir = join(TEST_DIR, "deeply", "nested");
    const entry: InteractionEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      source: "cli",
      intent: "create_task",
      message: "hello",
      action: "task created",
    };

    appendInteraction(nestedDir, "slug", entry);

    expect(existsSync(join(nestedDir, "interactions.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendDailyLogEntry
// ---------------------------------------------------------------------------

describe("appendDailyLogEntry", () => {
  it("creates YYYY-MM-DD.jsonl on first write", () => {
    const entry: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "interaction",
      slug: "my-slug",
    };

    appendDailyLogEntry(TEST_DIR, entry);

    const filePath = join(TEST_DIR, "2026-04-05.jsonl");
    expect(existsSync(filePath)).toBe(true);
  });

  it("creates a valid JSONL file containing the entry on first write", () => {
    const entry: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "interaction",
      slug: "my-slug",
      extra: "value",
    };

    appendDailyLogEntry(TEST_DIR, entry);

    const parsed = readDailyLog(TEST_DIR, "2026-04-05");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("interaction");
    expect(parsed[0].slug).toBe("my-slug");
    expect(parsed[0].extra).toBe("value");
  });

  it("appends a second entry to an existing daily log", () => {
    const entry1: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "interaction",
      slug: "slug-a",
    };
    const entry2: DailyLogEntry = {
      timestamp: "2026-04-05T11:00:00.000Z",
      type: "agent_started",
      slug: "slug-b",
      agent: "builder",
    };

    appendDailyLogEntry(TEST_DIR, entry1);
    appendDailyLogEntry(TEST_DIR, entry2);

    const parsed = readDailyLog(TEST_DIR, "2026-04-05");
    expect(parsed).toHaveLength(2);
    expect(parsed[0].slug).toBe("slug-a");
    expect(parsed[1].slug).toBe("slug-b");
    expect(parsed[1].agent).toBe("builder");
  });

  it("writes entries to separate files for different dates", () => {
    const entry1: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "interaction",
      slug: "slug-a",
    };
    const entry2: DailyLogEntry = {
      timestamp: "2026-04-06T10:00:00.000Z",
      type: "agent_completed",
      slug: "slug-b",
    };

    appendDailyLogEntry(TEST_DIR, entry1);
    appendDailyLogEntry(TEST_DIR, entry2);

    expect(existsSync(join(TEST_DIR, "2026-04-05.jsonl"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "2026-04-06.jsonl"))).toBe(true);

    const day1 = readDailyLog(TEST_DIR, "2026-04-05");
    const day2 = readDailyLog(TEST_DIR, "2026-04-06");
    expect(day1).toHaveLength(1);
    expect(day2).toHaveLength(1);
  });

  it("creates directory if it does not exist", () => {
    const nestedDir = join(TEST_DIR, "logs", "daily");
    const entry: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "interaction",
      slug: "my-slug",
    };

    appendDailyLogEntry(nestedDir, entry);

    expect(existsSync(join(nestedDir, "2026-04-05.jsonl"))).toBe(true);
  });

  it("preserves all extra fields on DailyLogEntry", () => {
    const entry: DailyLogEntry = {
      timestamp: "2026-04-05T10:00:00.000Z",
      type: "agent_completed",
      slug: "my-slug",
      durationMs: 1234,
      exitCode: 0,
      nested: { a: 1 },
    };

    appendDailyLogEntry(TEST_DIR, entry);

    const parsed = readDailyLog(TEST_DIR, "2026-04-05");
    expect(parsed[0].durationMs).toBe(1234);
    expect(parsed[0].exitCode).toBe(0);
    expect(parsed[0].nested).toEqual({ a: 1 });
  });
});
