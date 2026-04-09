import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_DIR = join(__dirname, "../../agents");
const WRITE_ACCESS_STAGES = ["impl", "quick-execute", "pr"];

describe("agent safety preamble", () => {
  const agentFiles = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));

  it("finds at least 13 agent prompt files", () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of agentFiles) {
    it(`${file} contains the safety preamble`, () => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      expect(content).toContain("## Safety Rules");
      expect(content).toContain("NEVER include API keys");
      expect(content).toContain("NEVER include personally identifiable information");
    });

    const stageName = file.replace(".md", "");
    if (WRITE_ACCESS_STAGES.includes(stageName)) {
      it(`${file} contains the write-access verification line`, () => {
        const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
        expect(content).toContain("Before committing or writing files");
      });
    }
  }
});
