import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeInitConfig, writeInitEnv } from "../../src/commands/init.js";
import { loadConfig } from "../../src/config/loader.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-init-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("writeInitConfig", () => {
  it("writes shkmn.config.json with provided values", () => {
    writeInitConfig(TEST_DIR, {
      runtimeDir: "/home/user/.shkmn/runtime",
      dashboardRepoUrl: "https://github.com/user/dash.git",
      dashboardRepoLocal: "/home/user/dash",
      reposRoot: "/home/user/code",
      adoOrg: "https://dev.azure.com/myorg",
      adoProject: "MyProject",
      adoArea: "MyArea",
    });

    const configPath = join(TEST_DIR, "shkmn.config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.pipeline.runtimeDir).toBe("/home/user/.shkmn/runtime");
    expect(config.pipeline.dashboardRepoUrl).toBe("https://github.com/user/dash.git");
    expect(config.ado.org).toBe("https://dev.azure.com/myorg");
    expect(config.agents.names.questions).toBe("Narada");
  });

  it("writes valid JSON that passes config loader validation", () => {
    writeInitConfig(TEST_DIR, {
      runtimeDir: "/tmp/rt",
      dashboardRepoUrl: "",
      dashboardRepoLocal: "",
      reposRoot: "",
      adoOrg: "",
      adoProject: "",
      adoArea: "",
    });

    const configPath = join(TEST_DIR, "shkmn.config.json");
    const config = loadConfig(configPath);
    expect(config.pipeline.runtimeDir).toBe("/tmp/rt");
  });
});

describe("writeInitEnv", () => {
  it("writes .env file with placeholder keys", () => {
    writeInitEnv(TEST_DIR);
    const envPath = join(TEST_DIR, ".env");
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ADO_PAT=");
    expect(content).toContain("ANTHROPIC_API_KEY=");
  });

  it("does not overwrite existing .env", () => {
    const envPath = join(TEST_DIR, ".env");
    writeFileSync(envPath, "EXISTING=value\n");

    writeInitEnv(TEST_DIR);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toBe("EXISTING=value\n");
  });
});
