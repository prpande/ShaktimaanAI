import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeDirs, verifyRuntimeDirs } from "../../src/runtime/dirs.js";
import { buildPaths } from "../../src/config/paths.js";
import { ALL_STAGE_DIRS } from "../../src/core/stage-map.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-dirs-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ALL_STAGE_DIRS", () => {
  it("has 13 top-level stage directories", () => {
    expect(ALL_STAGE_DIRS).toHaveLength(13);
  });

  it("starts with 00-inbox and ends with 12-hold", () => {
    expect(ALL_STAGE_DIRS[0]).toBe("00-inbox");
    expect(ALL_STAGE_DIRS[ALL_STAGE_DIRS.length - 1]).toBe("12-hold");
  });
});

describe("createRuntimeDirs", () => {
  it("creates all stage directories with pending/done subdirs", () => {
    const paths = buildPaths(TEST_DIR);
    createRuntimeDirs(paths);

    expect(existsSync(join(TEST_DIR, "00-inbox"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "01-questions", "pending"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "01-questions", "done"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "06-impl", "pending"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "06-impl", "done"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "10-complete"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "11-failed"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "12-hold"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "logs"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history", "daily-log"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "history", "monthly-reports"))).toBe(true);
  });

  it("is idempotent — safe to run multiple times", () => {
    const paths = buildPaths(TEST_DIR);
    createRuntimeDirs(paths);
    createRuntimeDirs(paths);
    expect(existsSync(join(TEST_DIR, "00-inbox"))).toBe(true);
  });
});

describe("verifyRuntimeDirs", () => {
  it("returns missing dirs when runtime is not initialized", () => {
    const paths = buildPaths(TEST_DIR);
    const result = verifyRuntimeDirs(paths);
    expect(result.valid).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("returns valid when all dirs exist", () => {
    const paths = buildPaths(TEST_DIR);
    createRuntimeDirs(paths);
    const result = verifyRuntimeDirs(paths);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});
