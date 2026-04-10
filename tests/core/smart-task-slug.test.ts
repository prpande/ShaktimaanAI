import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/loader.js";
import {
  type CreateTaskInput,
  generateSlug,
  buildTaskFileContent,
  createTask,
} from "../../src/core/task-creator.js";
import { parseTriageResult } from "../../src/core/astra-triage.js";

// ─── test setup ─────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "shkmn-test-smart-slug-" + Date.now());

function makeConfig() {
  return resolveConfig(
    configSchema.parse({ pipeline: { runtimeDir: TEST_DIR } }),
  );
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "00-inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. triageResultSchema accepts taskTitle
// ═══════════════════════════════════════════════════════════════════════════

describe("triageResultSchema accepts taskTitle", () => {
  it("parses taskTitle from triage JSON", () => {
    const json = JSON.stringify({
      action: "route_pipeline",
      controlOp: null,
      extractedSlug: null,
      taskTitle: "spec4-dashboard-kanban-view",
      recommendedStages: ["questions", "research", "design", "structure", "plan", "impl", "review", "validate", "pr"],
      stageHints: null,
      enrichedContext: "Dashboard with kanban view",
      repoSummary: null,
      requiredMcpServers: [],
      confidence: 0.9,
      reasoning: "Code change requiring full pipeline",
    });

    const result = parseTriageResult(json);
    expect(result).not.toBeNull();
    expect(result!.taskTitle).toBe("spec4-dashboard-kanban-view");
  });

  it("accepts null taskTitle", () => {
    const json = JSON.stringify({
      action: "answer",
      controlOp: null,
      extractedSlug: null,
      taskTitle: null,
      recommendedStages: null,
      stageHints: null,
      enrichedContext: null,
      repoSummary: null,
      requiredMcpServers: [],
      confidence: 0.9,
      reasoning: "Simple question",
    });

    const result = parseTriageResult(json);
    expect(result).not.toBeNull();
    expect(result!.taskTitle).toBeNull();
  });

  it("accepts missing taskTitle (optional)", () => {
    const json = JSON.stringify({
      action: "answer",
      controlOp: null,
      extractedSlug: null,
      recommendedStages: null,
      stageHints: null,
      enrichedContext: null,
      repoSummary: null,
      requiredMcpServers: [],
      confidence: 0.9,
      reasoning: "Simple question",
    });

    const result = parseTriageResult(json);
    expect(result).not.toBeNull();
    expect(result!.taskTitle).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. createTask prefers taskTitle over extractTitle
// ═══════════════════════════════════════════════════════════════════════════

describe("createTask prefers taskTitle", () => {
  it("uses taskTitle for slug when provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "I would like to implement the spec 4 described in the docs",
      taskTitle: "spec4-dashboard-kanban-view",
    };

    const slug = createTask(input, join(TEST_DIR, "00-inbox"), config);

    // Slug should be based on taskTitle, not the long content
    expect(slug).toMatch(/^spec4-dashboard-kanban-view-\d{14}$/);
  });

  it("falls back to extractTitle when taskTitle is undefined", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Fix the login bug",
    };

    const slug = createTask(input, join(TEST_DIR, "00-inbox"), config);

    expect(slug).toMatch(/^fix-the-login-bug-\d{14}$/);
  });

  it("falls back to extractTitle when taskTitle is empty string", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "Fix the login bug",
      taskTitle: "",
    };

    const slug = createTask(input, join(TEST_DIR, "00-inbox"), config);

    expect(slug).toMatch(/^fix-the-login-bug-\d{14}$/);
  });

  it("falls back to extractTitle when taskTitle is whitespace-only", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "Fix the login bug",
      taskTitle: "   ",
    };

    const slug = createTask(input, join(TEST_DIR, "00-inbox"), config);

    expect(slug).toMatch(/^fix-the-login-bug-\d{14}$/);
  });

  it("strips newlines from taskTitle", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "Some long message",
      taskTitle: "fix auth\ntoken refresh",
    };

    const slug = createTask(input, join(TEST_DIR, "00-inbox"), config);

    expect(slug).toMatch(/^fix-auth-token-refresh-\d{14}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. buildTaskFileContent uses taskTitle in header
// ═══════════════════════════════════════════════════════════════════════════

describe("buildTaskFileContent uses taskTitle", () => {
  it("uses taskTitle in the # Task: header when provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "slack",
      content: "I would like to implement the spec 4 described in the docs",
      taskTitle: "Dashboard Kanban View",
    };

    const content = buildTaskFileContent(input, config);

    expect(content).toContain("# Task: Dashboard Kanban View");
    // Original content should still be in the body
    expect(content).toContain("I would like to implement the spec 4 described in the docs");
  });

  it("falls back to extractTitle for header when taskTitle not provided", () => {
    const config = makeConfig();
    const input: CreateTaskInput = {
      source: "cli",
      content: "Fix the login bug\n\nMore details here",
    };

    const content = buildTaskFileContent(input, config);

    expect(content).toContain("# Task: Fix the login bug");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. generateSlug produces clean slug from Astra-style titles
// ═══════════════════════════════════════════════════════════════════════════

describe("generateSlug with Astra-style titles", () => {
  it("produces clean slug from short descriptive title", () => {
    const slug = generateSlug("spec4-dashboard-kanban-view");
    expect(slug).toMatch(/^spec4-dashboard-kanban-view-\d{14}$/);
  });

  it("produces clean slug from spaced title", () => {
    const slug = generateSlug("Fix Auth Token Refresh");
    expect(slug).toMatch(/^fix-auth-token-refresh-\d{14}$/);
  });

  it("handles already-kebab-cased titles", () => {
    const slug = generateSlug("add-retry-logic");
    expect(slug).toMatch(/^add-retry-logic-\d{14}$/);
  });
});
