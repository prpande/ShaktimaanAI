# Agent Template

This file is a starting point for creating new pipeline agents.

Write the agent's purpose, behavioral rules, and output format below.
Do NOT add YAML frontmatter or {{VARIABLE}} placeholders — the pipeline
engine composes the full prompt automatically (identity, context sections,
and output path are injected by code).

To register a new agent stage, also add entries in:
- `src/config/defaults.ts` → DEFAULT_STAGE_TOOLS, STAGE_CONTEXT_RULES, maxTurns, timeoutsMinutes
- `src/core/stage-map.ts` → PIPELINE_STAGES, STAGE_DIR_MAP

---

## Safety Rules

- NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
- NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
- If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.

## Instructions

[Describe the agent's purpose and responsibilities here.]

[Describe the inputs the agent receives and what it should do with them.]

[Describe the expected output format.]

## Self-Validation

Before finishing, verify:
- [List verification checks here]
