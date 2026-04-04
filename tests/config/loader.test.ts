import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveConfig } from "../../src/config/loader.js";
import { DEFAULT_AGENT_NAMES } from "../../src/config/defaults.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-config-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid config file and merges with defaults", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, JSON.stringify({
      pipeline: { runtimeDir: "/tmp/shkmn-runtime" },
      agents: { names: { questions: "MyBot" } },
    }));
    const config = loadConfig(configPath);
    expect(config.pipeline.runtimeDir).toBe("/tmp/shkmn-runtime");
    expect(config.agents.names.questions).toBe("MyBot");
  });

  it("throws if config file does not exist", () => {
    expect(() => loadConfig(join(TEST_DIR, "nonexistent.json"))).toThrow();
  });

  it("throws if config is invalid JSON", () => {
    const configPath = join(TEST_DIR, "bad.json");
    writeFileSync(configPath, "not json {{{");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws if runtimeDir is missing", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, JSON.stringify({ pipeline: {} }));
    expect(() => loadConfig(configPath)).toThrow(/runtimeDir/);
  });
});

describe("resolveConfig", () => {
  it("merges user agent names with defaults (user overrides win)", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: { questions: "AskBot" } },
      schedule: {},
    };
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.names.questions).toBe("AskBot");
    expect(resolved.agents.names.research).toBe(DEFAULT_AGENT_NAMES.research);
    expect(resolved.agents.names.watcher).toBe(DEFAULT_AGENT_NAMES.watcher);
  });

  it("fills in all default agent names when none provided", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: {} },
      schedule: {},
    };
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.names).toEqual(DEFAULT_AGENT_NAMES);
  });

  it("fills in default stages when not specified", () => {
    const parsed = {
      pipeline: { runtimeDir: "/tmp/rt", dashboardRepoLocal: "", dashboardRepoUrl: "" },
      repos: { root: "", aliases: {} },
      ado: { org: "", project: "", defaultArea: "" },
      slack: { enabled: false, channel: "#agent-pipeline", channelId: "", pollIntervalSeconds: 30 },
      agents: { names: {} },
      schedule: {},
    };
    const resolved = resolveConfig(parsed);
    expect(resolved.agents.defaultStages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(resolved.agents.defaultReviewAfter).toBe("design");
  });
});
