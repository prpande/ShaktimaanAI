import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAgentPrompt } from "../../src/core/agent-config.js";

const TEST_DIR = join(tmpdir(), "shkmn-test-agent-config-" + Date.now());

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("loadAgentPrompt", () => {
  it("returns the full file content as a string", () => {
    const content = "## Instructions\n\nDo the thing.\n\n## Self-Validation\n\n- Check it.";
    writeFileSync(join(TEST_DIR, "questions.md"), content, "utf-8");

    const result = loadAgentPrompt(TEST_DIR, "questions");
    expect(result).toBe(content);
  });

  it("throws when agent file does not exist", () => {
    expect(() => loadAgentPrompt(TEST_DIR, "nonexistent")).toThrow(/Agent prompt not found/);
  });

  it("returns content with no frontmatter processing (raw file read)", () => {
    const content = "---\nstage: test\n---\nBody here";
    writeFileSync(join(TEST_DIR, "raw.md"), content, "utf-8");

    const result = loadAgentPrompt(TEST_DIR, "raw");
    expect(result).toBe(content);
  });

  it("handles empty file gracefully", () => {
    writeFileSync(join(TEST_DIR, "empty.md"), "", "utf-8");
    const result = loadAgentPrompt(TEST_DIR, "empty");
    expect(result).toBe("");
  });
});
