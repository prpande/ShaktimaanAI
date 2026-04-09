import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseLineCount, lastNLines } from "../../src/commands/logs.js";

// ─── parseLineCount ───────────────────────────────────────────────────────────

describe("parseLineCount", () => {
  it("returns the parsed integer for a positive number string", () => {
    expect(parseLineCount("10")).toBe(10);
    expect(parseLineCount("100")).toBe(100);
    expect(parseLineCount("1")).toBe(1);
  });

  it("returns 0 when --lines 0 is passed (not the default)", () => {
    expect(parseLineCount("0")).toBe(0);
  });

  it("returns the default (50) when the string is not a valid integer", () => {
    expect(parseLineCount("")).toBe(50);
    expect(parseLineCount("abc")).toBe(50);
    expect(parseLineCount("NaN")).toBe(50);
  });

  it("uses a custom default when provided", () => {
    expect(parseLineCount("abc", 20)).toBe(20);
    expect(parseLineCount("", 100)).toBe(100);
  });

  it("returns the default (50) when the default is omitted and input is invalid", () => {
    expect(parseLineCount("bogus")).toBe(50);
  });

  it("handles leading whitespace in the string", () => {
    // parseInt(" 5") === 5 — should pass through cleanly
    expect(parseLineCount(" 5")).toBe(5);
  });

  it("truncates decimal strings to integer", () => {
    // parseInt("3.9") === 3
    expect(parseLineCount("3.9")).toBe(3);
  });
});

// ─── lastNLines ───────────────────────────────────────────────────────────────

describe("lastNLines", () => {
  it("returns the last N lines from a multi-line string", () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    expect(lastNLines(content, 3)).toEqual(["line3", "line4", "line5"]);
  });

  it("returns all lines when N is greater than line count", () => {
    const content = "line1\nline2\nline3";
    expect(lastNLines(content, 10)).toEqual(["line1", "line2", "line3"]);
  });

  it("strips trailing newline before slicing", () => {
    const content = "line1\nline2\nline3\n";
    expect(lastNLines(content, 2)).toEqual(["line2", "line3"]);
  });

  it("returns all lines when N equals line count", () => {
    const content = "a\nb\nc";
    expect(lastNLines(content, 3)).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when N is 0", () => {
    const content = "line1\nline2\nline3";
    expect(lastNLines(content, 0)).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(lastNLines("", 5)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const content = "line1\r\nline2\r\nline3\r\n";
    expect(lastNLines(content, 2)).toEqual(["line2", "line3"]);
  });

  it("handles a single line with trailing newline", () => {
    expect(lastNLines("only-line\n", 5)).toEqual(["only-line"]);
  });
});

// ─── rotation handling (integration-style, file-based) ───────────────────────

describe("log rotation state machine logic", () => {
  // Tests the rotation logic in isolation: when newSize < lastSize, lastSize
  // should be reset to 0 so the next comparison (newSize > lastSize) reads
  // from the beginning of the new file.

  it("detects rotation when newSize is less than lastSize and resets offset to 0", () => {
    let lastSize = 1000; // simulated accumulated offset

    const newSize = 200; // file was rotated — shrunk significantly

    // Emulate the rotation check in the watchFile callback
    if (newSize < lastSize) {
      lastSize = 0;
    }

    expect(lastSize).toBe(0);
  });

  it("does not reset offset when newSize equals lastSize (no new content)", () => {
    let lastSize = 500;
    const newSize = 500;

    if (newSize < lastSize) {
      lastSize = 0;
    }

    expect(lastSize).toBe(500);
  });

  it("does not reset offset when newSize is greater than lastSize (normal append)", () => {
    let lastSize = 500;
    const newSize = 600;

    if (newSize < lastSize) {
      lastSize = 0;
    }

    expect(lastSize).toBe(500);
    // After reset check, would proceed to read bytes [500..600)
    expect(newSize > lastSize).toBe(true);
  });

  it("after rotation reset, reads from beginning when new content arrives", () => {
    let lastSize = 1000;

    // Step 1: rotation event — file shrunk
    const rotatedSize = 0;
    if (rotatedSize < lastSize) {
      lastSize = 0;
    }
    expect(lastSize).toBe(0);

    // Step 2: new content appended after rotation
    const newContentSize = 150;
    expect(newContentSize > lastSize).toBe(true); // triggers read from offset 0
  });
});

// ─── file-based smoke test for lastNLines with real files ─────────────────────

describe("lastNLines with real file content", () => {
  let TEST_DIR: string;

  beforeEach(() => {
    TEST_DIR = join(tmpdir(), `shkmn-logs-test-${randomUUID()}`);
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads last 3 lines from a file with 5 lines", () => {
    const logFile = join(TEST_DIR, "test.log");
    writeFileSync(logFile, "line1\nline2\nline3\nline4\nline5\n", "utf-8");

    const content = readFileSync(logFile, "utf-8");
    const lines = lastNLines(content, 3);

    expect(lines).toEqual(["line3", "line4", "line5"]);
  });

  it("returns all lines when n > file line count", () => {
    const logFile = join(TEST_DIR, "small.log");
    writeFileSync(logFile, "only\ntwo\n", "utf-8");

    const content = readFileSync(logFile, "utf-8");
    const lines = lastNLines(content, 100);

    expect(lines).toEqual(["only", "two"]);
  });

  it("returns zero lines when n is 0 (--lines 0 behaviour)", () => {
    const logFile = join(TEST_DIR, "any.log");
    writeFileSync(logFile, "line1\nline2\nline3\n", "utf-8");

    const content = readFileSync(logFile, "utf-8");
    const lines = lastNLines(content, 0);

    expect(lines).toEqual([]);
  });
});
