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
    expect(() => loadAgentPrompt(TEST_DIR, "validate")).toThrow(/Agent prompt not found/);
  });

  it("returns content with no frontmatter processing (raw file read)", () => {
    const content = "---\nstage: test\n---\nBody here";
    writeFileSync(join(TEST_DIR, "design.md"), content, "utf-8");

    const result = loadAgentPrompt(TEST_DIR, "design");
    expect(result).toBe(content);
  });

  it("handles empty file gracefully", () => {
    writeFileSync(join(TEST_DIR, "impl.md"), "", "utf-8");
    const result = loadAgentPrompt(TEST_DIR, "impl");
    expect(result).toBe("");
  });

  it("rejects path traversal in stage name", () => {
    expect(() => loadAgentPrompt(TEST_DIR, "../../etc/passwd")).toThrow(
      /Invalid stage name/,
    );
  });

  it("rejects stage name not in allowlist", () => {
    expect(() => loadAgentPrompt(TEST_DIR, "unknown-stage")).toThrow(
      /Invalid stage name/,
    );
  });

  it("accepts valid stage names", () => {
    // This will throw "not found" (file doesn't exist) but NOT "Invalid stage name"
    expect(() => loadAgentPrompt("/nonexistent", "impl")).toThrow(
      /Agent prompt not found/,
    );
    expect(() => loadAgentPrompt("/nonexistent", "impl")).not.toThrow(
      /Invalid stage name/,
    );
  });
});
