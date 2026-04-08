import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STAGE_TOOLS } from "../config/defaults.js";

const VALID_STAGES = new Set(Object.keys(DEFAULT_STAGE_TOOLS));

/**
 * Loads the agent prompt body from {agentDir}/{stage}.md.
 * Returns the raw file content — no frontmatter parsing, no variable substitution.
 * Agent MD files are pure prompt instructions.
 */
export function loadAgentPrompt(agentDir: string, stage: string): string {
  if (!VALID_STAGES.has(stage)) {
    throw new Error(
      `Invalid stage name "${stage}". Must be one of: ${[...VALID_STAGES].join(", ")}`,
    );
  }
  const filePath = join(agentDir, `${stage}.md`);

  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Agent prompt not found for stage "${stage}" at "${filePath}". ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
