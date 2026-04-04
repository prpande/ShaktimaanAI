import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatLogLine,
  createTaskLogger,
  createSystemLogger,
  type TaskLogger,
} from "../../src/core/logger.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-logger-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("formatLogLine", () => {
  it("produces the correct format with ISO timestamp and uppercased level", () => {
    const before = new Date();
    const line = formatLogLine("info", "hello world");
    const after = new Date();

    // Format: [ISO_TIMESTAMP] [LEVEL_UPPER] message\n
    expect(line).toMatch(/^\[.+\] \[INFO\] hello world\n$/);

    // Timestamp should be a valid ISO string within the test range
    const match = line.match(/^\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const ts = new Date(match![1]);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("uppercases the level", () => {
    expect(formatLogLine("warn", "test")).toContain("[WARN]");
    expect(formatLogLine("error", "test")).toContain("[ERROR]");
    expect(formatLogLine("debug", "test")).toContain("[DEBUG]");
  });

  it("includes the message verbatim", () => {
    const msg = "some detailed message with special chars: @#$%";
    const line = formatLogLine("info", msg);
    expect(line).toContain(msg);
  });

  it("ends with a newline", () => {
    const line = formatLogLine("info", "msg");
    expect(line.endsWith("\n")).toBe(true);
  });
});

describe("createTaskLogger", () => {
  it("writes info lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.info("task started");

    const logPath = join(TEST_DIR, "my-task.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("[INFO] task started");
  });

  it("writes warn lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.warn("something odd");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("[WARN] something odd");
  });

  it("writes error lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.error("it broke");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("[ERROR] it broke");
  });

  it("creates the log directory if it does not exist", () => {
    const nestedDir = join(TEST_DIR, "deeply", "nested", "dir");
    expect(existsSync(nestedDir)).toBe(false);

    const logger: TaskLogger = createTaskLogger(nestedDir, "nested-task");
    logger.info("checking dir creation");

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, "nested-task.log"))).toBe(true);
  });

  it("appends to an existing log file rather than overwriting", () => {
    const logger1: TaskLogger = createTaskLogger(TEST_DIR, "append-test");
    logger1.info("first message");

    const logger2: TaskLogger = createTaskLogger(TEST_DIR, "append-test");
    logger2.info("second message");

    const content = readFileSync(join(TEST_DIR, "append-test.log"), "utf8");
    expect(content).toContain("first message");
    expect(content).toContain("second message");
  });

  it("writes multiple calls in order", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "order-test");
    logger.info("alpha");
    logger.warn("beta");
    logger.error("gamma");

    const content = readFileSync(join(TEST_DIR, "order-test.log"), "utf8");
    const alphaIdx = content.indexOf("alpha");
    const betaIdx = content.indexOf("beta");
    const gammaIdx = content.indexOf("gamma");
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(gammaIdx);
  });

  it("uses slug as the filename (slug.log)", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "special-slug-123");
    logger.info("checking filename");

    expect(existsSync(join(TEST_DIR, "special-slug-123.log"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "special-slug-123"))).toBe(false);
  });
});

describe("createSystemLogger", () => {
  it("writes to heimdall.log", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.info("system up");

    const logPath = join(TEST_DIR, "heimdall.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("[INFO] system up");
  });

  it("supports warn and error", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.warn("sys warn");
    logger.error("sys error");

    const content = readFileSync(join(TEST_DIR, "heimdall.log"), "utf8");
    expect(content).toContain("[WARN] sys warn");
    expect(content).toContain("[ERROR] sys error");
  });

  it("creates the log directory if it does not exist", () => {
    const nestedDir = join(TEST_DIR, "sys", "logs");
    const logger: TaskLogger = createSystemLogger(nestedDir);
    logger.info("boot");

    expect(existsSync(join(nestedDir, "heimdall.log"))).toBe(true);
  });
});
