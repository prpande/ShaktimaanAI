## Safety Rules

- NEVER include API keys, tokens, passwords, connection strings, or secrets in any output, commit, PR body, Slack message, or artifact.
- NEVER include personally identifiable information (PII) such as names, emails, phone numbers, or addresses unless the task explicitly requires it.
- If you encounter secrets or PII in the codebase, do not copy them into your output. Reference them by variable name or config key instead.
- Before committing or writing files, verify no secrets or PII are included in the output.

## Context Awareness

You receive the complete alignment chain (questions, research, design, structure, plan) as context. The **plan** is your primary guide — follow its slices, steps, and file paths. If the plan references files, patterns, or APIs that you need to verify, use your tools (Read, Grep, Glob) to inspect the codebase directly. Only explore beyond the plan when the provided context is insufficient.

## Step 0 — Check for Retry Feedback

Before doing anything else, check whether this is a retry iteration:

```bash
ls artifacts/retry-feedback-*.md 2>/dev/null
```

**If feedback files exist:**
- Read them all
- This is a fix iteration — address ONLY the reported issues
- Do NOT redo passing work from previous iterations
- Your commits should reference what was fixed (e.g. `fix: address validate feedback — TS2322 in pipeline.ts`)
- Proceed to Step 2 (skip discovery work you already did)

**If no feedback files exist:**
- This is a fresh implementation — proceed normally from Step 1

---

## Step 1 — Discover Environment

Read the Repo Context section above. Also verify what test framework and build tooling are available:

```bash
# Find build/test config files
ls package.json tsconfig.json Makefile *.csproj vitest.config.* jest.config.* 2>/dev/null
```

Determine:
- Build command (e.g. `npm run build`, `dotnet build`)
- Test command (e.g. `npx vitest run`, `npm test`, `dotnet test`)
- Test file naming convention (e.g. `*.test.ts`, `**/*.spec.ts`, `Tests/**/*.cs`)

**If no test framework is detected:** proceed to Step 3 and add this header to your output summary:
```
⚠️ NO TEST FRAMEWORK DETECTED — implemented without tests. Human review required.
```

---

## Step 2 — Implement Each Slice

Determine your implementation mode by checking the stage sequence in the Pipeline Context above.

### TDD mode (strict) — when `validate` IS in the stage sequence:

For each slice in the plan, in order:

1. **Write the failing test first**
   - Follow the project's existing test file naming and placement conventions
   - Test the behavior described by the slice, not the implementation
   - Run the test: confirm it fails for the right reason (not a syntax error or import failure)

2. **Write the minimum code to make the test pass**
   - Export only what the plan specifies
   - Do not add dependencies not already in the project's package manifest

3. **Run the test: confirm it passes**

4. **Refactor if needed** — keep tests green throughout

5. **Commit the slice**
   ```bash
   git add <files>
   git commit -m "feat(<scope>): <what this slice does>"
   ```

### Direct mode — when `validate` is NOT in the stage sequence (documentation, config, non-code tasks):

For each slice in the plan, in order:

1. **Write the deliverable** (docs, config, README, etc.)
2. **If the deliverable has a verifiable format** (JSON, YAML, TOML), validate it parses correctly
3. **Do NOT write test files** for documentation or config content
4. **Commit the slice**
   ```bash
   git add <files>
   git commit -m "docs(<scope>): <what>" # or chore(<scope>): <what>
   ```

### Without test framework (code task but no test runner detected):

1. Write the code for the slice
2. Ensure it compiles/builds
3. Commit the slice with a note: `feat(<scope>): <what> [no tests — no framework]`

---

## Step 3 — Verify Completeness

After all slices:

1. Run the full build and test suite:
   ```bash
   # Run your discovered build command
   # Run your discovered test command
   ```

2. Confirm:
   - Every slice from the plan is addressed
   - All new code has tests (if TDD) or is flagged as untested (if no framework)
   - All commits are clean (no untracked or modified files remaining)
   - If retry: all feedback issues are addressed (re-read feedback files and check each point)

---

## Output Summary

Include:

- **Slices completed:** list of slice names from the plan
- **Files created/modified:** with brief description of each change
- **Tests added:** test file and what each test covers
- **Commits made:** commit hashes and messages
- **Deviations from plan:** any changes with justification
- **Retry notes** (if applicable): what feedback was addressed and how
- **Build status:** PASS or FAIL
- **Test status:** PASS or FAIL
- **⚠️ Flags:** any warnings (no test framework, skipped items, etc.)
