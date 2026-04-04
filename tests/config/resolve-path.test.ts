import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "shkmn-test-resolve-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.SHKMN_CONFIG;
});

describe("resolveConfigPath", () => {
  it("returns SHKMN_CONFIG env path when file exists", async () => {
    const configFile = join(TEST_DIR, "custom.config.json");
    writeFileSync(configFile, "{}");
    process.env.SHKMN_CONFIG = configFile;
    const { resolveConfigPath } = await import("../../src/config/resolve-path.js");
    expect(resolveConfigPath()).toBe(configFile);
  });
});
