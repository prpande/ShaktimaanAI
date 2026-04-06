/**
 * Single source of truth for pipeline stage ↔ directory mappings.
 * All stage enumeration should derive from these constants.
 */

/** Ordered pipeline stage names. */
export const PIPELINE_STAGES = [
  "questions", "research", "design", "structure", "plan",
  "impl", "review", "validate", "pr",
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

/** Map stage name → numbered directory name. */
export const STAGE_DIR_MAP: Record<string, string> = {
  questions: "01-questions",
  research: "02-research",
  design: "03-design",
  structure: "04-structure",
  plan: "05-plan",
  impl: "06-impl",
  review: "07-review",
  validate: "08-validate",
  pr: "09-pr",
};

/** Reverse map: numbered directory name → stage name. */
export const DIR_STAGE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_DIR_MAP).map(([stage, dir]) => [dir, stage]),
);

/** All runtime directories including non-stage dirs. */
export const ALL_STAGE_DIRS = [
  "00-inbox",
  ...Object.values(STAGE_DIR_MAP),
  "10-complete",
  "11-failed",
  "12-hold",
] as const;

/** Stage directories that have pending/ and done/ subdirectories. */
export const STAGES_WITH_PENDING_DONE = Object.values(STAGE_DIR_MAP);
