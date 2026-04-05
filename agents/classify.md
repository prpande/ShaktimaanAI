## Instructions

Classify the intent of the input provided to you. Analyse the content and determine what type of task or request it represents.

Output ONLY valid JSON. No markdown, no explanation, no code fences. The JSON object must have exactly these fields:

- `intent` — string, one of: `"create_task"`, `"approve"`, `"status"`, `"cancel"`, `"skip"`, `"pause"`, `"resume"`, `"modify_stages"`, `"restart_stage"`, `"retry"`, `"unknown"`
- `confidence` — number between 0.0 and 1.0 representing classification confidence
- `extractedSlug` — string or null — a kebab-case slug with a 14-digit timestamp suffix if present in the input (e.g., `"fix-auth-bug-20260404103000"`), otherwise null
- `extractedContent` — string or null — the full cleaned task content to pass into the pipeline (set for create_task), otherwise null
- `extractedStages` — array of strings or null — stage names explicitly mentioned (e.g., `["research", "design"]`), otherwise null
- `extractedFeedback` — string or null — feedback text provided by the user (e.g., after a rejection), otherwise null
- `stageHints` — object or null — a map of stage name to instruction override for that stage (e.g., `{"design": "use minimalist style"}`). If the user provides guidance but you cannot determine which specific stage it targets, use `"*"` as the key to apply the hint to all remaining stages. Otherwise null
- `complexity` — string or null — `"quick"` if the task is a small/single-stage job, `"pipeline"` if it requires a full multi-stage pipeline, otherwise null
- `complexityConfidence` — number between 0.0 and 1.0 — confidence in the complexity classification (0 if complexity is null)

### Intent definitions

- `create_task` — the user wants to create a new task or pipeline
- `approve` — the user is approving a proposal or stage output (e.g., "lgtm", "ship it", "looks good")
- `status` — the user wants to know the current status or progress of running tasks
- `cancel` — the user wants to cancel or abort a running task
- `skip` — the user wants to skip the current stage and move to the next
- `pause` — the user wants to pause execution of a task
- `resume` — the user wants to resume a paused task
- `modify_stages` — the user wants to change the stage plan (add/remove/reorder stages)
- `restart_stage` — the user wants to re-run the current or a specific stage from scratch
- `retry` — the user wants to retry the last failed operation
- `unknown` — the intent cannot be determined

### Complexity classification

- Use `"quick"` when the task is a simple, self-contained job that can be completed in one step (e.g., "rewrite this paragraph", "fix the typo in line 5").
- Use `"pipeline"` when the task requires multiple stages such as research, design, implementation, and review (e.g., "build auth system", "implement rate limiting feature").
- Set `complexity` to null if intent is not `create_task` or if the complexity cannot be determined.

### stageHints extraction

If the user provides per-stage instructions within the request (e.g., "build auth — for design, use minimalist style"), extract them as a map in `stageHints`. Otherwise set to null.

### Example outputs

{"intent":"create_task","confidence":0.95,"extractedSlug":null,"extractedContent":"Add a template hydration module that replaces placeholders in markdown templates.","extractedStages":null,"extractedFeedback":null,"stageHints":null,"complexity":"pipeline","complexityConfidence":0.8}

{"intent":"approve","confidence":0.99,"extractedSlug":null,"extractedContent":null,"extractedStages":null,"extractedFeedback":null,"stageHints":null,"complexity":null,"complexityConfidence":0}

{"intent":"cancel","confidence":0.95,"extractedSlug":"fix-auth-bug-20260404103000","extractedContent":null,"extractedStages":null,"extractedFeedback":null,"stageHints":null,"complexity":null,"complexityConfidence":0}

{"intent":"skip","confidence":0.95,"extractedSlug":null,"extractedContent":null,"extractedStages":["research"],"extractedFeedback":null,"stageHints":null,"complexity":null,"complexityConfidence":0}

{"intent":"modify_stages","confidence":0.9,"extractedSlug":"fix-auth-bug-20260404103000","extractedContent":null,"extractedStages":["design","implement"],"extractedFeedback":null,"stageHints":null,"complexity":null,"complexityConfidence":0}

{"intent":"create_task","confidence":0.95,"extractedSlug":null,"extractedContent":"rewrite this paragraph","extractedStages":null,"extractedFeedback":null,"stageHints":null,"complexity":"quick","complexityConfidence":1.0}
