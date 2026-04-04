import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigValue, setConfigValue } from "../../src/commands/config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-configcmd-" + Date.now());
let configPath: string;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  configPath = join(TEST_DIR, "shkmn.config.json");
  writeFileSync(configPath, JSON.stringify({
    pipeline: { runtimeDir: "/tmp/rt" },
    agents: { names: { questions: "Narada" } },
  }));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("getConfigValue", () => {
  it("reads a nested value by dot path", () => {
    const value = getConfigValue(configPath, "pipeline.runtimeDir");
    expect(value).toBe("/tmp/rt");
  });

  it("reads a deeply nested value", () => {
    const value = getConfigValue(configPath, "agents.names.questions");
    expect(value).toBe("Narada");
  });

  it("returns undefined for nonexistent path", () => {
    const value = getConfigValue(configPath, "nonexistent.path");
    expect(value).toBeUndefined();
  });
});

describe("setConfigValue", () => {
  it("sets a nested value by dot path", () => {
    setConfigValue(configPath, "agents.names.questions", "MyBot");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agents.names.questions).toBe("MyBot");
  });

  it("creates intermediate objects if needed", () => {
    setConfigValue(configPath, "repos.root", "/home/code");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.repos.root).toBe("/home/code");
  });

  it("preserves existing values when setting a new key", () => {
    setConfigValue(configPath, "agents.names.research", "Scout");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.agents.names.questions).toBe("Narada");
    expect(raw.agents.names.research).toBe("Scout");
  });
});
