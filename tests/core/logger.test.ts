import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  it("produces valid JSON with expected fields", () => {
    const line = formatLogLine("info", "hello world");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.time).toBeDefined();
  });

  it("includes the level as-is", () => {
    const line = formatLogLine("warn", "test");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("warn");
  });

  it("includes the message verbatim", () => {
    const msg = "some detailed message with special chars: @#$%";
    const line = formatLogLine("info", msg);
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe(msg);
  });
});

describe("createTaskLogger", () => {
  it("writes info lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.info("task started");

    const logPath = join(TEST_DIR, "my-task.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("task started");
  });

  it("writes warn lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.warn("something odd");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("something odd");
  });

  it("writes error lines to the correct file", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "my-task");
    logger.error("it broke");

    const content = readFileSync(join(TEST_DIR, "my-task.log"), "utf8");
    expect(content).toContain("it broke");
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
  });

  it("writes structured JSON lines", () => {
    const logger: TaskLogger = createTaskLogger(TEST_DIR, "json-test", { slug: "my-slug", module: "pipeline" });
    logger.info("structured check");

    const content = readFileSync(join(TEST_DIR, "json-test.log"), "utf8").trim();
    const lines = content.split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.msg).toBe("structured check");
    expect(last.slug).toBe("my-slug");
    expect(last.module).toBe("pipeline");
  });
});

describe("createSystemLogger", () => {
  it("writes to heimdall.log", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.info("system up");

    const logPath = join(TEST_DIR, "heimdall.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("system up");
  });

  it("supports warn and error", () => {
    const logger: TaskLogger = createSystemLogger(TEST_DIR);
    logger.warn("sys warn");
    logger.error("sys error");

    const content = readFileSync(join(TEST_DIR, "heimdall.log"), "utf8");
    expect(content).toContain("sys warn");
    expect(content).toContain("sys error");
  });
});
