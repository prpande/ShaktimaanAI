## Alignment Context

You receive all findings from prior stages. Rely primarily on the most recent stage's output, but reference earlier findings when you need to understand the reasoning behind decisions or verify assumptions.

## Instructions

### Input Handling

The design document may contain one or two designs:
- **Design A only** — decompose it.
- **Design A and Design B** — decompose BOTH independently. The review gate will choose which to implement.

### Decomposition Rules

1. **Vertical slices** — each slice delivers thin end-to-end functionality, not a horizontal layer. A slice that "adds the types" without behavior is wrong. A slice that "adds type + one function that uses it + test" is right.

2. **Independent and testable** — each slice must compile, pass its tests, and be verifiable on its own. Do not create slices that only work when combined with a later slice.

3. **Dependency ordering** — order slices so no slice depends on a later one. If S3 depends on S1, S1 comes first. Circular dependencies mean your decomposition is wrong.

4. **Right-sized** — no slice should exceed what a coding agent can complete in a single focused session (~30-60 minutes). If a slice feels too large, split it.

5. **Complete coverage** — the sum of all slices must cover 100% of the design. Nothing from the design should be missing from the slice list.

### Per-Slice Fields

For each slice, provide:

- **Slice ID** — sequential identifier (S1, S2, S3, ...)
- **Name** — concise description of what the slice delivers
- **Files** — exact file paths to create or modify
- **Acceptance Criteria** — specific, testable conditions. Write them as "Given X, when Y, then Z" or as concrete assertions.
- **Dependencies** — which earlier slices must be completed first (by ID). Use "none" if independent.
- **Complexity** — small (< 15 min), medium (15-30 min), or large (30-60 min)

## Self-Validation

Before finishing, verify:
- Each slice can be independently tested (has at least one concrete acceptance criterion)
- The dependency graph is acyclic (no circular dependencies)
- The sum of all slices covers every component, interface, and behavior in the design
- Acceptance criteria are specific enough to be turned into automated tests (not "works correctly" but "returns 404 when user ID is not found")
- No slice is too large (if complexity is "large", consider splitting)

## Output Format

For each design (A, and optionally B):

```
# Slices for Design A

## S1: [Name]
- **Files:** `path/to/file.ts` (create), `path/to/other.ts` (modify)
- **Acceptance Criteria:**
  - Given [input], when [action], then [result]
  - [assertion]
- **Dependencies:** none
- **Complexity:** small

## S2: [Name]
- **Files:** [...]
- **Acceptance Criteria:** [...]
- **Dependencies:** S1
- **Complexity:** medium
```
