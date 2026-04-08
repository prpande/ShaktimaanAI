import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  tryResolveConfigPath,
  checkGhAuth,
  checkAzAuth,
  checkConfig,
  checkEnvFile,
  checkRuntimeDirs,
  checkAgentPrompts,
  fixMissingDirs,
  fixMissingConfigDefaults,
  runDoctor,
  REQUIRED_ENV_KEYS,
  EXPECTED_AGENT_FILES,
} from "../../src/commands/doctor.js";
import { createRuntimeDirs, verifyRuntimeDirs } from "../../src/runtime/dirs.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

const TEST_DIR = join(tmpdir(), "shkmn-test-doctor-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mockExecSync.mockReset();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── S1: tryResolveConfigPath ──────────────────────────────────────────

describe("tryResolveConfigPath", () => {
  it("returns null when no config found at any location", () => {
    const origCwd = process.cwd;
    const origEnv = process.env.SHKMN_CONFIG;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      const result = tryResolveConfigPath();
      expect(result).toBeNull();
    } finally {
      process.cwd = origCwd;
      if (origEnv !== undefined) process.env.SHKMN_CONFIG = origEnv;
    }
  });

  it("returns path when shkmn.config.json exists in CWD", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, JSON.stringify({ pipeline: { runtimeDir: "/tmp/rt" } }));

    const origCwd = process.cwd;
    const origEnv = process.env.SHKMN_CONFIG;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      const result = tryResolveConfigPath();
      expect(result).toBe(configPath);
    } finally {
      process.cwd = origCwd;
      if (origEnv !== undefined) process.env.SHKMN_CONFIG = origEnv;
    }
  });

  it("returns path when SHKMN_CONFIG env var points to existing file", () => {
    const configPath = join(TEST_DIR, "custom.config.json");
    writeFileSync(configPath, JSON.stringify({ pipeline: { runtimeDir: "/tmp/rt" } }));

    const origCwd = process.cwd;
    const origEnv = process.env.SHKMN_CONFIG;
    const emptyDir = join(TEST_DIR, "empty-subdir");
    mkdirSync(emptyDir, { recursive: true });
    process.cwd = () => emptyDir;
    process.env.SHKMN_CONFIG = configPath;

    try {
      const result = tryResolveConfigPath();
      expect(result).toBe(configPath);
    } finally {
      process.cwd = origCwd;
      if (origEnv !== undefined) {
        process.env.SHKMN_CONFIG = origEnv;
      } else {
        delete process.env.SHKMN_CONFIG;
      }
    }
  });
});

// ── S2: checkGhAuth ──────────────────────────────────────────────────

describe("checkGhAuth", () => {
  it("returns passed: true when gh auth status succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from("Logged in to github.com as user"));
    const result = checkGhAuth();
    expect(result.name).toBe("GitHub CLI authenticated");
    expect(result.passed).toBe(true);
    expect(result.fixable).toBe(false);
  });

  it("returns passed: false when gh auth status fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("You are not logged into any GitHub hosts");
    });
    const result = checkGhAuth();
    expect(result.passed).toBe(false);
    expect(result.fixable).toBe(false);
    expect(result.message).toContain("not logged into");
  });

  it("returns passed: false with not-installed message when command not found", () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error("gh: command not found") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });
    const result = checkGhAuth();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/not installed|command not found/i);
  });

  it("returns passed: false with timeout message when execSync times out", () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error("TIMEOUT") as Error & { killed?: boolean };
      err.killed = true;
      throw err;
    });
    const result = checkGhAuth();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });
});

// ── S2: checkAzAuth ──────────────────────────────────────────────────

describe("checkAzAuth", () => {
  it("returns passed: true when az account show succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from('{"id": "sub-123"}'));
    const result = checkAzAuth();
    expect(result.name).toBe("Azure CLI authenticated");
    expect(result.passed).toBe(true);
    expect(result.fixable).toBe(false);
  });

  it("returns passed: false when az account show fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("Please run 'az login'");
    });
    const result = checkAzAuth();
    expect(result.passed).toBe(false);
    expect(result.fixable).toBe(false);
    expect(result.message).toContain("az login");
  });

  it("returns passed: false with not-installed message when az not found", () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error("az: command not found") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });
    const result = checkAzAuth();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/not installed|command not found/i);
  });
});

// ── S3: checkConfig ──────────────────────────────────────────────────

describe("checkConfig", () => {
  it("returns passed: false and fixable: false when configPath is null", () => {
    const result = checkConfig(null);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/config.*not found/i);
    expect(result.fixable).toBe(false);
  });

  it("returns fixable: true when configPath exists but validation fails", () => {
    const configPath = join(TEST_DIR, "fixable.config.json");
    writeFileSync(configPath, JSON.stringify({ repos: { root: "/x" } }));
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.fixable).toBe(true);
  });

  it("returns passed: true for valid config file", () => {
    const configPath = join(TEST_DIR, "valid.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ pipeline: { runtimeDir: "/tmp/test" } }),
    );
    const result = checkConfig(configPath);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("Config validation");
  });

  it("returns passed: false with parse error for malformed JSON", () => {
    const configPath = join(TEST_DIR, "bad.json");
    writeFileSync(configPath, "{ not valid json }}}");
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/JSON|parse/i);
  });

  it("returns passed: false with Zod error when pipeline is missing", () => {
    const configPath = join(TEST_DIR, "invalid.config.json");
    writeFileSync(configPath, JSON.stringify({ repos: { root: "/x" } }));
    const result = checkConfig(configPath);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/pipeline|Invalid/i);
  });
});

// ── S3: checkEnvFile ──────────────────────────────────────────────────

describe("checkEnvFile", () => {
  it("returns passed: false when configPath is null", () => {
    const result = checkEnvFile(null);
    expect(result.passed).toBe(false);
    expect(result.fixable).toBe(false);
  });

  it("returns passed: true when .env has all required keys", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, "{}");
    const envPath = join(TEST_DIR, ".env");
    writeFileSync(
      envPath,
      "ADO_PAT=x\nGITHUB_PAT=y\nSLACK_TOKEN=z\nSLACK_WEBHOOK_URL=w\nANTHROPIC_API_KEY=k\n",
    );
    const result = checkEnvFile(configPath);
    expect(result.passed).toBe(true);
  });

  it("returns passed: false listing missing keys when some are absent", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, "{}");
    const envPath = join(TEST_DIR, ".env");
    writeFileSync(envPath, "ADO_PAT=x\nGITHUB_PAT=y\nANTHROPIC_API_KEY=k\n");
    const result = checkEnvFile(configPath);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("SLACK_TOKEN");
    expect(result.message).toContain("SLACK_WEBHOOK_URL");
  });

  it("returns passed: false when .env file does not exist", () => {
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(configPath, "{}");
    // Do NOT create .env
    const result = checkEnvFile(configPath);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/\.env.*not found/i);
  });
});

// ── S4: checkRuntimeDirs ──────────────────────────────────────────────

describe("checkRuntimeDirs", () => {
  it("returns passed: false when runtimeDir is null", () => {
    const result = checkRuntimeDirs(null);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/no config/i);
    expect(result.fixable).toBe(true);
  });

  it("returns passed: true when all dirs exist", () => {
    const runtimeDir = join(TEST_DIR, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    createRuntimeDirs(runtimeDir);
    const result = checkRuntimeDirs(runtimeDir);
    expect(result.passed).toBe(true);
    expect(result.fixable).toBe(false);
    expect(result.message).toMatch(/present/);
  });

  it("returns passed: false listing missing dirs when some are absent", () => {
    const runtimeDir = join(TEST_DIR, "empty-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    // Don't create any subdirectories
    const result = checkRuntimeDirs(runtimeDir);
    expect(result.passed).toBe(false);
    expect(result.fixable).toBe(true);
    expect(result.message).toMatch(/missing/i);
  });
});

// ── S4: checkAgentPrompts ──────────────────────────────────────────────

describe("checkAgentPrompts", () => {
  it("returns passed: true when all 12 expected .md files exist", () => {
    const agentsDir = join(TEST_DIR, "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const file of EXPECTED_AGENT_FILES) {
      writeFileSync(join(agentsDir, file), "# Agent prompt");
    }
    const result = checkAgentPrompts(agentsDir);
    expect(result.passed).toBe(true);
    expect(result.message).toBe("13/13 present");
  });

  it("returns passed: false listing missing files when some are absent", () => {
    const agentsDir = join(TEST_DIR, "agents-partial");
    mkdirSync(agentsDir, { recursive: true });
    // Only create first 10 files
    for (const file of EXPECTED_AGENT_FILES.slice(0, 10)) {
      writeFileSync(join(agentsDir, file), "# Agent prompt");
    }
    const result = checkAgentPrompts(agentsDir);
    expect(result.passed).toBe(false);
    // The last 3 files: "review.md", "pr.md", and one of the new quick/slack files
    expect(result.message).toContain("pr.md");
  });

  it("returns passed: false when agents directory does not exist", () => {
    const agentsDir = join(TEST_DIR, "nonexistent-agents");
    const result = checkAgentPrompts(agentsDir);
    expect(result.passed).toBe(false);
  });
});

// ── S5: runDoctor orchestrator ──────────────────────────────────────

describe("runDoctor", () => {
  let logOutput: string[];
  const origLog = console.log;

  beforeEach(() => {
    logOutput = [];
    console.log = (...args: unknown[]) => {
      logOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
  });

  it("shows 6/6 passed when all checks pass", () => {
    // Mock execSync to pass auth checks
    mockExecSync.mockReturnValue(Buffer.from("ok"));

    const configPath = join(TEST_DIR, "shkmn.config.json");
    const runtimeDir = join(TEST_DIR, "runtime");
    const agentsDir = join(TEST_DIR, "agents");

    writeFileSync(
      configPath,
      JSON.stringify({ pipeline: { runtimeDir, agentsDir } }),
    );
    writeFileSync(
      join(TEST_DIR, ".env"),
      "ADO_PAT=x\nGITHUB_PAT=y\nSLACK_TOKEN=z\nSLACK_WEBHOOK_URL=w\nANTHROPIC_API_KEY=k\n",
    );

    // Create runtime dirs
    createRuntimeDirs(runtimeDir);

    // Create agent files
    mkdirSync(agentsDir, { recursive: true });
    for (const file of EXPECTED_AGENT_FILES) {
      writeFileSync(join(agentsDir, file), "# prompt");
    }

    // Override CWD so tryResolveConfigPath finds the config
    const origCwd = process.cwd;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      runDoctor({ fix: false });
    } finally {
      process.cwd = origCwd;
    }

    const output = logOutput.join("\n");
    expect(output).toContain("shkmn doctor");
    expect(output).toMatch(/6\/6.*passed/);
    expect(output).not.toContain("\u2717");
  });

  it("shows correct pass/fail counts when some checks fail", () => {
    // Auth checks fail
    mockExecSync.mockImplementation(() => {
      throw new Error("not logged in");
    });

    // Config exists but no .env, no runtime dirs, no agents
    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ pipeline: { runtimeDir: join(TEST_DIR, "runtime") } }),
    );

    const origCwd = process.cwd;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      runDoctor({ fix: false });
    } finally {
      process.cwd = origCwd;
    }

    const output = logOutput.join("\n");
    expect(output).toContain("\u2717");
    expect(output).toContain("\u2713"); // Config validation should pass
    expect(output).toMatch(/failed/);
  });

  it("fixes missing dirs and re-reports them as passing when --fix is used", () => {
    // Auth checks pass
    mockExecSync.mockReturnValue(Buffer.from("ok"));

    const runtimeDir = join(TEST_DIR, "runtime-fix");
    const agentsDir = join(TEST_DIR, "agents-fix");
    const configPath = join(TEST_DIR, "shkmn.config.json");

    writeFileSync(
      configPath,
      JSON.stringify({ pipeline: { runtimeDir, agentsDir } }),
    );
    writeFileSync(
      join(TEST_DIR, ".env"),
      "ADO_PAT=x\nGITHUB_PAT=y\nSLACK_TOKEN=z\nSLACK_WEBHOOK_URL=w\nANTHROPIC_API_KEY=k\n",
    );

    // Create agent files but NOT runtime dirs
    mkdirSync(agentsDir, { recursive: true });
    for (const file of EXPECTED_AGENT_FILES) {
      writeFileSync(join(agentsDir, file), "# prompt");
    }
    mkdirSync(runtimeDir, { recursive: true });
    // Runtime subdirs are missing — --fix should create them

    const origCwd = process.cwd;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      runDoctor({ fix: true });
    } finally {
      process.cwd = origCwd;
    }

    const output = logOutput.join("\n");
    expect(output).toMatch(/fix/i);

    // Verify dirs actually got created
    const { valid } = verifyRuntimeDirs(runtimeDir);
    expect(valid).toBe(true);
  });

  it("does not attempt fix for non-fixable checks like auth failures", () => {
    // Auth checks fail
    mockExecSync.mockImplementation(() => {
      throw new Error("not logged in");
    });

    const configPath = join(TEST_DIR, "shkmn.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ pipeline: { runtimeDir: join(TEST_DIR, "rt") } }),
    );

    const origCwd = process.cwd;
    process.cwd = () => TEST_DIR;
    delete process.env.SHKMN_CONFIG;

    try {
      runDoctor({ fix: true });
    } finally {
      process.cwd = origCwd;
    }

    const output = logOutput.join("\n");
    expect(output).toContain("\u2717");
    expect(output).toContain("GitHub CLI authenticated");
  });
});

// ── S6: fixMissingDirs ──────────────────────────────────────────────

describe("fixMissingDirs", () => {
  it("creates missing directories when called", () => {
    const runtimeDir = join(TEST_DIR, "fix-runtime");
    mkdirSync(runtimeDir, { recursive: true });

    // Verify dirs are missing initially
    const before = verifyRuntimeDirs(runtimeDir);
    expect(before.valid).toBe(false);

    const result = fixMissingDirs(runtimeDir);
    expect(result.success).toBe(true);

    // Verify dirs now exist
    const after = verifyRuntimeDirs(runtimeDir);
    expect(after.valid).toBe(true);
  });

  it("does not error when directories already exist", () => {
    const runtimeDir = join(TEST_DIR, "fix-existing");
    mkdirSync(runtimeDir, { recursive: true });
    createRuntimeDirs(runtimeDir);

    const result = fixMissingDirs(runtimeDir);
    expect(result.success).toBe(true);

    const after = verifyRuntimeDirs(runtimeDir);
    expect(after.valid).toBe(true);
  });
});

// ── S6: fixMissingConfigDefaults ────────────────────────────────────

describe("fixMissingConfigDefaults", () => {
  it("adds missing keys without overwriting existing values", () => {
    const configPath = join(TEST_DIR, "fix-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        pipeline: { runtimeDir: "/my/runtime" },
        repos: { root: "/my/repos" },
      }),
    );

    const result = fixMissingConfigDefaults(configPath);
    expect(result.success).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    // Existing values preserved
    expect(updated.pipeline.runtimeDir).toBe("/my/runtime");
    expect(updated.repos.root).toBe("/my/repos");
    // Default values added for missing sections
    expect(updated).toHaveProperty("slack");
    expect(updated.slack.enabled).toBe(false);
    expect(updated).toHaveProperty("worktree");
  });

  it("does not merge empty-string defaults from DEFAULT_CONFIG", () => {
    const configPath = join(TEST_DIR, "fix-no-blanks.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        pipeline: { runtimeDir: "/my/runtime" },
      }),
    );

    fixMissingConfigDefaults(configPath);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    // Empty-string defaults like pipeline.agentsDir, pipeline.dashboardRepoLocal
    // should NOT be added since they are placeholder empty strings
    expect(updated.pipeline.agentsDir).toBeUndefined();
    expect(updated.pipeline.dashboardRepoLocal).toBeUndefined();
    // But non-empty defaults should be added
    expect(updated.slack.channel).toBe("#agent-pipeline");
  });

  it("preserves existing user values — never overwrites", () => {
    const configPath = join(TEST_DIR, "fix-preserve.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        pipeline: { runtimeDir: "/my/runtime" },
        slack: { enabled: true, channel: "#custom-channel" },
      }),
    );

    fixMissingConfigDefaults(configPath);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.slack.enabled).toBe(true);
    expect(updated.slack.channel).toBe("#custom-channel");
  });
});
