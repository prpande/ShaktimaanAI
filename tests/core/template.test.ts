import { describe, it, expect } from "vitest";
import { hydrateTemplate } from "../../src/core/template.js";

describe("hydrateTemplate", () => {
  it("replaces all {{VAR}} placeholders with provided values", () => {
    const template = "Hello {{NAME}}, your task is {{TASK}}.";
    const result = hydrateTemplate(template, { NAME: "Karigar", TASK: "build" });
    expect(result).toBe("Hello Karigar, your task is build.");
  });

  it("leaves unmatched placeholders unchanged", () => {
    const template = "Hello {{NAME}}, your score is {{SCORE}}.";
    const result = hydrateTemplate(template, { NAME: "Drona" });
    expect(result).toBe("Hello Drona, your score is {{SCORE}}.");
  });

  it("handles a template with no placeholders", () => {
    const template = "No variables here.";
    const result = hydrateTemplate(template, { NAME: "anyone" });
    expect(result).toBe("No variables here.");
  });

  it("handles empty vars object (leaves all placeholders unchanged)", () => {
    const template = "{{AGENT_NAME}} processes {{TASK_CONTENT}}";
    const result = hydrateTemplate(template, {});
    expect(result).toBe("{{AGENT_NAME}} processes {{TASK_CONTENT}}");
  });

  it("replaces multiple occurrences of the same placeholder", () => {
    const template = "{{ROLE}} does the work. {{ROLE}} does it well.";
    const result = hydrateTemplate(template, { ROLE: "Karigar" });
    expect(result).toBe("Karigar does the work. Karigar does it well.");
  });

  it("handles all standard pipeline placeholders", () => {
    const template =
      "{{PIPELINE_CONTEXT}} | {{AGENT_NAME}} | {{AGENT_ROLE}} | {{TASK_CONTENT}} | {{PREVIOUS_OUTPUT}} | {{OUTPUT_PATH}}";
    const vars = {
      PIPELINE_CONTEXT: "ctx",
      AGENT_NAME: "Narada",
      AGENT_ROLE: "questioner",
      TASK_CONTENT: "build feature",
      PREVIOUS_OUTPUT: "none",
      OUTPUT_PATH: "/tmp/out",
    };
    const result = hydrateTemplate(template, vars);
    expect(result).toBe("ctx | Narada | questioner | build feature | none | /tmp/out");
  });

  it("handles an empty template string", () => {
    const result = hydrateTemplate("", { NAME: "test" });
    expect(result).toBe("");
  });

  it("does not replace partial placeholder patterns (no braces mismatch)", () => {
    const template = "{{NAME} is {NAME}} not matched";
    // Only {{word}} pattern matches — neither of these should
    const result = hydrateTemplate(template, { NAME: "x" });
    // {{NAME} — opening double brace but no closing double brace → not a full match
    // {NAME}} — no opening double brace → not a match
    expect(result).toBe("{{NAME} is {NAME}} not matched");
  });
});
