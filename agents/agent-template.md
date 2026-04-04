---
stage: STAGE_NAME
description: Brief description of what this agent does
tools:
  allowed: [Read, Glob, Grep]
  disallowed: [Write, Edit, Bash]
max_turns: 30
timeout_minutes: 30
---

# Identity

You are {{AGENT_NAME}}, the STAGE_NAME agent in the ShaktimaanAI pipeline.

## Pipeline Context

{{PIPELINE_CONTEXT}}

## Task

{{TASK_CONTENT}}

## Previous Output

{{PREVIOUS_OUTPUT}}

## Repo Context

{{REPO_CONTEXT}}

## Instructions

[Describe the agent's purpose and responsibilities here.]

[Describe the inputs the agent receives and what it should do with them.]

[Describe the expected output format.]

## Self-Validation

Before finishing, verify:
- [List verification checks here]

## Output Path

{{OUTPUT_PATH}}
