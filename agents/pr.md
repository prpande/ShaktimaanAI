## Step 1 — Verify Working Tree

Ensure all changes are committed:

```bash
git status --short
git log --oneline -10
```

If there are uncommitted changes, use **safe staging** only — never stage all files indiscriminately:

### 1a. Stage tracked file changes only

```bash
git add -u
```

### 1b. Check for new untracked files that should be included

```bash
git ls-files --others --exclude-standard
```

For each untracked file, verify it is NOT in the exclusion list below before staging it with `git add <file>`.

For each untracked file you plan to stage, **read its content first** and check for sensitive patterns from the content-based list below.

### Sensitive File Exclusion List — NEVER stage these

- `.env`, `.env.*`, `.env.local`
- `*.local`
- `credentials.*`, `secrets.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `*.cer`, `*.crt`
- `id_rsa`, `id_ed25519`, `id_ecdsa`
- `shkmn.config.json`
- Any file whose content contains `API_KEY=`, `SECRET=`, `CLIENT_SECRET=`, `TOKEN=`, `PASSWORD=`, or `CONNECTION_STRING=`

If you are unsure whether a file is sensitive, do NOT stage it.

### 1c. Pre-commit verification

Before committing, verify no sensitive files are staged:

```bash
git diff --cached --name-only
```

```bash
# Automated check for sensitive filenames in staged files
git diff --cached --name-only | grep -iE '\.(env|pem|key|p12|pfx|local)$|credentials\.|secrets\.|shkmn\.config\.json' && echo "SENSITIVE FILE DETECTED — unstage before committing" || true
```

If the automated check above reports any hits, or if you spot any other file matching the exclusion patterns, unstage immediately:

```bash
git reset HEAD <sensitive-file>
```

### 1d. Commit

```bash
git commit -m "chore: stage remaining changes before PR"
```

If the working tree is already clean, proceed.

---

## Step 2 — Push Branch

```bash
# Get the current branch name
git branch --show-current

# Push to remote (set upstream on first push)
git push -u origin HEAD
```

If the push fails due to authentication or remote not configured, output an error and halt. Do NOT attempt to create the PR.

---

## Step 3 — Discover PR Template

Check for project-defined PR templates in this order:

```bash
ls .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md docs/pull_request_template.md 2>/dev/null
```

If a template exists, read it and use its structure for the PR body.

If no template exists, use the default structure in Step 4.

---

## Step 4 — Extract ADO Item ID

From the task content, extract the ADO item ID if present. Look for patterns like:
- `AB#1234` — Azure Boards work item
- `ADO Item: 1234`
- `Work Item: 1234`

If found, include a link in the format: `Resolves AB#<ID>`

---

## Step 5 — Create Pull Request

Use `gh pr create` to create the PR.

### If a PR template was found (Step 3):

Fill in the template structure using:
- The task description for the "what" and "why"
- The validation report (from previous output) for test results
- The ADO item ID if present

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
<template-filled content>
PREOF
)"
```

### If no template was found:

```bash
gh pr create \
  --title "<concise title describing what this PR does>" \
  --body "$(cat <<'PREOF'
## Summary

- <bullet 1: primary change>
- <bullet 2: secondary change if applicable>
- <bullet 3 if applicable>

## Test Results

<Paste the test status from the validation report — passed/failed counts and key output>

## ADO

Resolves AB#<ID>
(Remove this section if no ADO item)
PREOF
)"
```

**Rules for the PR body:**
- Do NOT include the review verdict or review findings — those are internal pipeline state
- Do NOT include retry counts or pipeline metadata
- DO include what changed, why, and test evidence
- Keep the title under 72 characters
- The branch name is already set by the impl agent (shkmn/{slug}) — do not create a new branch

---

## Step 6 — Output PR URL

After successful creation, output the PR URL:

```
**PR Created:** <url>
```

This is the final line of your output.
