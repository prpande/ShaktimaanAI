import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseFrontmatter, loadAgentConfig } from "../../src/core/agent-config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-config-" + Date.now());

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("parseFrontmatter", () => {
  it("parses frontmatter and returns config with prompt body", () => {
    const content = `---
stage: questions
description: Asks clarifying questions
tools:
  allowed: [Read, Glob, Grep, Bash]
  disallowed: [Write, Edit]
max_turns: 25
timeout_minutes: 10
---
# Questions Agent

This is the prompt body.
`;
    const { meta, body } = parseFrontmatter(content);

    expect(meta.stage).toBe("questions");
    expect(meta.description).toBe("Asks clarifying questions");
    expect(meta.max_turns).toBe(25);
    expect(meta.timeout_minutes).toBe(10);
    expect((meta.tools as Record<string, unknown>).allowed).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect((meta.tools as Record<string, unknown>).disallowed).toEqual(["Write", "Edit"]);
    expect(body.trim()).toBe("# Questions Agent\n\nThis is the prompt body.");
  });

  it("returns default tools when frontmatter has no tools section", () => {
    const content = `---
stage: review
description: Reviews output
---
Review prompt here.
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.stage).toBe("review");
    expect(meta.tools).toBeUndefined();
  });

  it("handles file with no frontmatter — entire content is the prompt", () => {
    const content = "Just a plain prompt with no frontmatter.\nSecond line.";
    const { meta, body } = parseFrontmatter(content);
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe(content);
  });

  it("parses MCP tool glob patterns in allowed tools", () => {
    const content = `---
stage: integration
description: Integration agent
tools:
  allowed: [Read, mcp__claude_ai_Slack__*, mcp__plugin_notion_notion__*]
  disallowed: []
---
Integration prompt.
`;
    const { meta } = parseFrontmatter(content);
    const tools = meta.tools as Record<string, unknown>;
    expect(tools.allowed).toEqual(["Read", "mcp__claude_ai_Slack__*", "mcp__plugin_notion_notion__*"]);
    expect(tools.disallowed).toEqual([]);
  });
});

describe("loadAgentConfig", () => {
  it("parses frontmatter and returns config with prompt body", () => {
    const content = `---
stage: questions
description: Asks clarifying questions
tools:
  allowed: [Read, Glob, Grep, Bash]
  disallowed: [Write, Edit]
max_turns: 25
timeout_minutes: 10
---
# Questions Agent

This is the prompt body.
`;
    writeFileSync(join(TEST_DIR, "questions.md"), content, "utf-8");

    const config = loadAgentConfig(TEST_DIR, "questions");

    expect(config.stage).toBe("questions");
    expect(config.description).toBe("Asks clarifying questions");
    expect(config.tools.allowed).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(config.tools.disallowed).toEqual(["Write", "Edit"]);
    expect(config.maxTurns).toBe(25);
    expect(config.timeoutMinutes).toBe(10);
    expect(config.promptTemplate.trim()).toBe("# Questions Agent\n\nThis is the prompt body.");
  });

  it("returns default tools when frontmatter has no tools section", () => {
    const content = `---
stage: review
description: Reviews output
---
Review prompt here.
`;
    writeFileSync(join(TEST_DIR, "review.md"), content, "utf-8");

    const config = loadAgentConfig(TEST_DIR, "review");

    expect(config.tools.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(config.tools.disallowed).toEqual([]);
  });

  it("handles file with no frontmatter — entire content is the prompt", () => {
    const content = "Just a plain prompt with no frontmatter.\nSecond line.";
    writeFileSync(join(TEST_DIR, "plain.md"), content, "utf-8");

    const config = loadAgentConfig(TEST_DIR, "plain");

    expect(config.promptTemplate).toBe(content);
    expect(config.tools.allowed).toEqual(["Read", "Glob", "Grep"]);
  });

  it("throws when agent file does not exist", () => {
    expect(() => loadAgentConfig(TEST_DIR, "nonexistent")).toThrow(/Agent config not found/);
  });

  it("uses stage parameter as fallback when frontmatter has no stage field", () => {
    const content = `---
description: Some agent
---
Prompt body.
`;
    writeFileSync(join(TEST_DIR, "karigar.md"), content, "utf-8");

    const config = loadAgentConfig(TEST_DIR, "karigar");

    expect(config.stage).toBe("karigar");
  });

  it("parses MCP tool glob patterns in allowed tools", () => {
    const content = `---
stage: integration
description: Integration agent
tools:
  allowed: [Read, mcp__claude_ai_Slack__*, mcp__plugin_notion_notion__*]
  disallowed: []
---
Integration prompt.
`;
    writeFileSync(join(TEST_DIR, "integration.md"), content, "utf-8");

    const config = loadAgentConfig(TEST_DIR, "integration");

    expect(config.tools.allowed).toEqual(["Read", "mcp__claude_ai_Slack__*", "mcp__plugin_notion_notion__*"]);
    expect(config.tools.disallowed).toEqual([]);
  });
});
