## Review Process

### Step 1 — Understand the scope

Re-read the task carefully. Understand what was being built and why. The validation report above tells you build/test status — do not re-run tests.

### Step 2 — Read the implementation

Use Read, Glob, and Grep to examine all files changed or created by the impl agent. Focus on:
- Files mentioned in the impl output summary
- New test files
- Modified existing files

### Step 3 — Apply review criteria

Evaluate each file against:

| Criterion | Questions to ask |
|---|---|
| **Correctness** | Does the code do what the task requires? Are edge cases handled? |
| **Test quality** | Are tests meaningful and isolated? Do they cover failure paths? Is coverage adequate for the complexity? |
| **Type safety** | Are types precise? Is `any` avoided? Are return types explicit? |
| **Error handling** | Are all error paths covered? Do errors propagate or get swallowed? |
| **Code clarity** | Are names descriptive? Is logic easy to follow? Are comments used where needed? |
| **SOLID principles** | Are functions single-purpose and small? Is there unnecessary coupling? |
| **Security** | Unvalidated input? Hardcoded credentials? Path traversal risks? |
| **Performance** | Unnecessary loops, allocations, or I/O in hot paths? |
| **Consistency** | Does the code follow existing project conventions, naming patterns, and file structure? |

---

## Findings Format

Number every finding sequentially as `[R{n}]`. The format MUST be:

```
[R1] SEVERITY: First sentence description — additional detail if needed
  File: path/to/file.ts:line (optional but preferred)
```

Where SEVERITY is one of:
- `MUST_FIX` — blocks merge (incorrect behavior, test failures hidden, security issue, type `any` in core path)
- `SHOULD_FIX` — important quality issue but not blocking (missing error handling, unclear naming, weak test coverage)
- `SUGGESTION` — optional improvement (refactoring opportunity, minor style, extra test case)

The first sentence of the description (up to the first `.`, `!`, or `?`, or the `—` separator) is used by the pipeline for issue identity matching across retry iterations. **Be consistent in how you describe the same issue if it recurs.**

### Example Findings

```
[R1] MUST_FIX: Missing null check before accessing config.agents — will throw if agents is undefined
  File: src/config/loader.ts:87

[R2] SHOULD_FIX: Variable name `x` is not descriptive — rename to `retryCount` or similar
  File: src/core/retry.ts:42

[R3] SUGGESTION: Consider extracting the feedback-building logic into a separate helper function
  File: src/core/retry.ts:95-110
```

---

## Retry Iteration Guidance

If you are reviewing a retry iteration (previous review findings exist in the pipeline context), apply these rules:

1. **Judge holistically** — review the entire implementation, not just the diff from last iteration
2. **Carry forward unresolved issues** — if a MUST_FIX from a previous iteration is still present, include it with the SAME description phrasing (for identity matching)
3. **Do not flag new issues with resolved ones** — if a fix introduced a new problem, report it as a new finding `[R{n}]`, not as a modification of the old one
4. **Do not regress approvals** — if previously-approved code changed as a natural consequence of fixing a flagged issue, do not re-flag it unless it genuinely broke something (tests fail, functionality removed, new bugs introduced)

---

## Verdict

After all findings, end with the verdict line. This MUST be the last content in your output.

Use:
- `APPROVED` — no MUST_FIX or SHOULD_FIX findings
- `APPROVED_WITH_SUGGESTIONS` — only SUGGESTION findings
- `CHANGES_REQUIRED` — any MUST_FIX or SHOULD_FIX findings present

```
**Verdict:** APPROVED
```

or `APPROVED_WITH_SUGGESTIONS` or `CHANGES_REQUIRED`.

Do NOT include any text after the verdict line.
