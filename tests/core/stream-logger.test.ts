import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStreamLogger } from "../../src/core/stream-logger.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-stream-logger-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("createStreamLogger", () => {
  it("creates the JSONL file and writes a message with a ts field", () => {
    const filePath = join(TEST_DIR, "stream.jsonl");
    const logger = createStreamLogger(filePath);

    const before = new Date();
    logger.log({ type: "assistant", text: "hello" });
    const after = new Date();
    logger.close();

    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("assistant");
    expect(entry.text).toBe("hello");
    expect(typeof entry.ts).toBe("string");

    const ts = new Date(entry.ts);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("appends one JSON line per log() call", () => {
    const filePath = join(TEST_DIR, "multi.jsonl");
    const logger = createStreamLogger(filePath);

    logger.log({ type: "assistant", text: "line one" });
    logger.log({ type: "tool_use", name: "Read" });
    logger.log({ type: "result", subtype: "success" });
    logger.close();

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const [e1, e2, e3] = lines.map((l) => JSON.parse(l));
    expect(e1.type).toBe("assistant");
    expect(e2.type).toBe("tool_use");
    expect(e3.type).toBe("result");
  });

  it("handles 50 sequential writes without corruption (each line is valid JSON)", () => {
    const filePath = join(TEST_DIR, "stress.jsonl");
    const logger = createStreamLogger(filePath);

    for (let i = 0; i < 50; i++) {
      logger.log({ type: "assistant", index: i, text: `message ${i}` });
    }
    logger.close();

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(50);

    lines.forEach((line, idx) => {
      const entry = JSON.parse(line); // throws if invalid JSON
      expect(entry.index).toBe(idx);
      expect(entry.ts).toBeDefined();
    });
  });

  it("creates parent directory if missing", () => {
    const nestedPath = join(TEST_DIR, "deep", "nested", "dir", "stream.jsonl");
    expect(existsSync(join(TEST_DIR, "deep"))).toBe(false);

    const logger = createStreamLogger(nestedPath);
    logger.log({ type: "assistant", text: "test" });
    logger.close();

    expect(existsSync(nestedPath)).toBe(true);
    const lines = readFileSync(nestedPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("assistant");
  });

  it("adds ts field alongside all other message fields", () => {
    const filePath = join(TEST_DIR, "fields.jsonl");
    const logger = createStreamLogger(filePath);

    logger.log({ type: "tool_result", tool_use_id: "abc123", content: "file content" });
    logger.close();

    const entry = JSON.parse(readFileSync(filePath, "utf8").trim());
    expect(entry.type).toBe("tool_result");
    expect(entry.tool_use_id).toBe("abc123");
    expect(entry.content).toBe("file content");
    expect(typeof entry.ts).toBe("string");
  });

  it("close() is a no-op and does not throw", () => {
    const filePath = join(TEST_DIR, "close-noop.jsonl");
    const logger = createStreamLogger(filePath);
    logger.log({ type: "assistant", text: "test" });

    expect(() => logger.close()).not.toThrow();
    // calling close twice should also be safe
    expect(() => logger.close()).not.toThrow();
  });

  it("swallows write errors silently and does not throw", () => {
    // Create a logger pointing to a path inside a file (impossible directory)
    const filePath = join(TEST_DIR, "not-a-dir.txt");
    // Write a regular file at that path so subdirectory creation would fail
    writeFileSync(filePath, "i am a file");

    // Try to create a logger inside the file (impossible on any OS)
    const impossiblePath = join(filePath, "stream.jsonl");
    const logger = createStreamLogger(impossiblePath);

    // Should not throw even though writes will fail
    expect(() => logger.log({ type: "assistant", text: "test" })).not.toThrow();
    expect(() => logger.close()).not.toThrow();
  });
});
