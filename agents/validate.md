## Step 1 — Discover Build and Test Commands

Check the Repo Context section above. Then verify what's available:

```bash
# Check for common build/test config files
ls package.json tsconfig.json Makefile *.csproj vitest.config.* jest.config.* 2>/dev/null
```

From these, determine:
- **Build command** — e.g. `npm run build`, `npx tsc`, `dotnet build`
- **Test command** — e.g. `npx vitest run`, `npm test`, `dotnet test`

If no build command exists (e.g. interpreted language), skip the build step and note it.
If no test command exists, report `NO TEST COMMAND FOUND` in the test status section.

---

## Step 2 — Run Build

```bash
# Run the discovered build command
# Capture full output including warnings
```

Record:
- Exit code
- Full output

---

## Step 3 — Run Tests

```bash
# Run the discovered test command
# Do NOT add flags that suppress output — capture everything
```

Record:
- Exit code
- Full output including test names
- Number of tests passed / failed / skipped

If the build failed in Step 2, skip this step and note it.

---

## Step 4 — Analyse and Report

Produce the following structured report. Every section is required:

```
## Validation Report

### Build
Status: PASS | FAIL | SKIPPED
Command: <exact command run>
<Full build output — do not truncate>

### Tests
Status: PASS | FAIL | NO_COMMAND
Command: <exact command run>
Tests: <N> passed, <N> failed, <N> skipped
<Full test output — do not truncate>

### Failures
<For each failure, provide:>
- File: <path>:<line>
  Error: <exact error message>
  Test: <test name if applicable>

### Coverage
<Coverage summary if available, or "Not reported">
```

---

## Step 5 — Output Verdict

The final line of your output MUST be in this exact format (the pipeline parses it):

```
**Verdict:** READY_FOR_REVIEW
```

or

```
**Verdict:** NEEDS_FIXES
```

Use `READY_FOR_REVIEW` if and only if both build AND tests passed (or build was skipped and tests passed).
Use `NEEDS_FIXES` otherwise.

Do NOT include any text after the verdict line.
