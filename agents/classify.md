## Instructions

Classify the intent of the input provided to you. Analyse the content and determine what type of task or request it represents.

Output ONLY valid JSON. No markdown, no explanation, no code fences. The JSON object must have exactly these fields:

- `intent` — string, one of: `"implement"`, `"bugfix"`, `"refactor"`, `"docs"`, `"question"`, `"unknown"`
- `confidence` — number between 0.0 and 1.0 representing classification confidence
- `extractedSlug` — string, a short kebab-case identifier derived from the task (e.g., `"add-user-auth"`)
- `extractedContent` — string, the full cleaned task content to pass into the pipeline

Example output:
{"intent":"implement","confidence":0.95,"extractedSlug":"add-template-hydrator","extractedContent":"Add a template hydration module that replaces placeholders in markdown templates."}
