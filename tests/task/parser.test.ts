import { describe, it, expect } from "vitest";
import { parseTaskFile, type TaskMeta } from "../../src/task/parser.js";

const FULL_TASK = `# Task: Add retry logic to MindBodyApiClient

## What I want done
Add exponential backoff retry on transient HTTP errors (429, 503, 504).
Should be configurable: max retries and base delay. Add unit tests.

## Context
- MindBodyApiClient is in src/Services/MindBodyApiClient.cs
- Polly is already referenced — use it

## Repo
C:\\Code\\mindbody-businessapp

## ADO Item
1502604

## Slack Thread
1234567890.123456

## Pipeline Config
stages: research, design, impl, validate, review, pr
review_after: design
`;

const MINIMAL_TASK = `# Task: Document appointment API patterns

## What I want done
Research and document all appointment-related endpoints.

## Pipeline Config
stages: questions, research
review_after: none
`;

describe("parseTaskFile", () => {
  it("parses a full task file with all fields", () => {
    const meta = parseTaskFile(FULL_TASK);
    expect(meta.title).toBe("Add retry logic to MindBodyApiClient");
    expect(meta.description).toContain("exponential backoff");
    expect(meta.context).toContain("MindBodyApiClient");
    expect(meta.repo).toBe("C:\\Code\\mindbody-businessapp");
    expect(meta.adoItem).toBe("1502604");
    expect(meta.slackThread).toBe("1234567890.123456");
    expect(meta.stages).toEqual(["research", "design", "impl", "validate", "review", "pr"]);
    expect(meta.reviewAfter).toBe("design");
  });

  it("parses a minimal task file with defaults for missing fields", () => {
    const meta = parseTaskFile(MINIMAL_TASK);
    expect(meta.title).toBe("Document appointment API patterns");
    expect(meta.description).toContain("Research and document");
    expect(meta.context).toBe("");
    expect(meta.repo).toBe("");
    expect(meta.adoItem).toBe("");
    expect(meta.slackThread).toBe("");
    expect(meta.stages).toEqual(["questions", "research"]);
    expect(meta.reviewAfter).toBe("none");
  });

  it("returns default stages when Pipeline Config section is missing", () => {
    const bare = "# Task: Quick fix\n\n## What I want done\nFix the bug.\n";
    const meta = parseTaskFile(bare);
    expect(meta.title).toBe("Quick fix");
    expect(meta.stages).toEqual([
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ]);
    expect(meta.reviewAfter).toBe("design");
  });

  it("returns 'Unnamed Task' when title line is missing", () => {
    const noTitle = "## What I want done\nDo something.\n";
    const meta = parseTaskFile(noTitle);
    expect(meta.title).toBe("Unnamed Task");
  });

  it("trims whitespace from all parsed fields", () => {
    const padded = "# Task:   Padded Title  \n\n## Repo\n  C:\\Code\\app  \n";
    const meta = parseTaskFile(padded);
    expect(meta.title).toBe("Padded Title");
    expect(meta.repo).toBe("C:\\Code\\app");
  });
});
