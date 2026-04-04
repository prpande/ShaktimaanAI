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

## Instructions

[Describe the agent's purpose and responsibilities here.]

[Describe the inputs the agent receives and what it should do with them.]

[Describe the expected output format.]

## Self-Validation

Before finishing, verify:
- [List verification checks here]
