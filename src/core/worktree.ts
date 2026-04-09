import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { join, dirname, sep } from "node:path";

const SENSITIVE_GITIGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.local",
  "credentials.*",
  "secrets.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "shkmn.config.json",
];

export interface WorktreeInfo {
  path: string;
  branch: string;
  slug: string;
}

export interface WorktreeManifestEntry {
  slug: string;
  repoPath: string;
  worktreePath: string;
  createdAt?: string;
  completedAt?: string;
}

/**
 * Creates a git worktree for the given repo at {worktreesDir}/{slug}.
 * Creates branch shkmn/{slug} from HEAD (or baseBranch if provided).
 * If the worktree already exists (crash recovery), returns its path unchanged.
 */
export function createWorktree(
  repoPath: string,
  slug: string,
  worktreesDir: string,
  baseBranch?: string,
): string {
  const worktreePath = join(worktreesDir, slug);
  const branchName = `shkmn/${slug}`;

  // If the worktree path already exists, assume it's a crash-recovery scenario — reuse it.
  if (existsSync(worktreePath)) {
    try {
      ensureSensitiveGitignore(worktreePath);
    } catch { /* non-fatal */ }
    return worktreePath;
  }

  mkdirSync(worktreesDir, { recursive: true });

  // Build the git worktree add command
  // -b creates a new branch; if baseBranch is given, branch from it
  const baseRef = baseBranch ?? "HEAD";
  execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, baseRef], {
    cwd: repoPath,
    stdio: "pipe",
  });

  // Record creation in manifest
  const manifestPath = join(dirname(worktreesDir), "worktree-manifest.json");
  try {
    recordWorktreeCreation(manifestPath, {
      slug,
      repoPath,
      worktreePath,
      createdAt: new Date().toISOString(),
    });
  } catch { /* intentionally ignore manifest write failures to avoid failing worktree creation */ }

  // Ensure .gitignore excludes sensitive files
  try {
    ensureSensitiveGitignore(worktreePath);
  } catch { /* non-fatal: gitignore enforcement is defense-in-depth */ }

  return worktreePath;
}

/**
 * Removes a git worktree and deletes the associated shkmn/{slug} branch.
 * Does not throw if the worktree or branch is already gone.
 */
export function removeWorktree(
  repoPath: string,
  worktreePath: string,
  slug: string,
): void {
  const branchName = `shkmn/${slug}`;

  // Remove the worktree (--force handles detached HEAD or unclean state)
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // If the worktree directory is already gone, git worktree prune will clean metadata
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repoPath, stdio: "pipe" });
    } catch {
      // ignore
    }
  }

  // Delete the branch
  try {
    execFileSync("git", ["branch", "-D", branchName], { cwd: repoPath, stdio: "pipe" });
  } catch {
    // Branch may already be deleted — ignore
  }
}

/**
 * Lists all ShaktimaanAI-managed worktrees (branches matching shkmn/*) for a repo.
 * Parses `git worktree list --porcelain` output.
 */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  let output: string;
  try {
    output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    }) as string;
  } catch {
    return [];
  }

  // Each worktree entry is separated by a blank line
  const entries = output.trim().split(/\n\n+/);
  const result: WorktreeInfo[] = [];

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    const pathLine = lines.find(l => l.startsWith("worktree "));
    const branchLine = lines.find(l => l.startsWith("branch "));

    if (!pathLine || !branchLine) continue;

    const path = pathLine.replace(/^worktree /, "").trim();
    // branch line format: "branch refs/heads/shkmn/slug"
    const branchRef = branchLine.replace(/^branch /, "").trim();
    const branch = branchRef.replace(/^refs\/heads\//, "");

    if (!branch.startsWith("shkmn/")) continue;

    const slug = branch.replace(/^shkmn\//, "");
    result.push({ path, branch, slug });
  }

  return result;
}

/**
 * Resolves the parent repository path from a git worktree directory.
 * Worktrees have a `.git` file (not directory) containing:
 *   gitdir: /path/to/parent/.git/worktrees/<name>
 * Returns the parent repo root, or null if the path is not a worktree.
 */
export function resolveParentRepo(worktreePath: string): string | null {
  try {
    const dotGit = join(worktreePath, ".git");
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return null;

    const content = readFileSync(dotGit, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;

    const gitdir = match[1].trim();
    const worktreesDir = dirname(gitdir);         // .git/worktrees or bare/worktrees
    const gitStoreDir = dirname(worktreesDir);    // .git or bare-repo-root
    // For regular repos, gitStoreDir is the .git dir; for bare repos, it IS the repo root
    const parentPath = gitStoreDir.endsWith(".git") || gitStoreDir.endsWith(sep + ".git")
      ? dirname(gitStoreDir)
      : gitStoreDir;
    // Resolve to canonical long path (handles Windows 8.3 short names stored by git)
    try {
      return realpathSync(parentPath);
    } catch {
      return parentPath;
    }
  } catch {
    return null;
  }
}

/**
 * Ensures that the worktree's .gitignore includes all sensitive-file patterns.
 * Appends missing patterns without duplicating existing ones.
 */
function ensureSensitiveGitignore(worktreePath: string): void {
  const gitignorePath = join(worktreePath, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet
  }

  const existingLines = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const missing = SENSITIVE_GITIGNORE_PATTERNS.filter(p => !existingLines.has(p));

  if (missing.length === 0) return;

  const leadingNewline = existing.length > 0 ? "\n" : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${separator}${leadingNewline}# ShaktimaanAI: sensitive file exclusions\n${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, existing + block, "utf-8");
}

// ─── Manifest helpers ──────────────────────────────────────────────────────

function readManifest(manifestPath: string): WorktreeManifestEntry[] {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as WorktreeManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(manifestPath: string, entries: WorktreeManifestEntry[]): void {
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Records a worktree creation entry in the manifest file.
 * Creates the manifest if it doesn't exist.
 */
export function recordWorktreeCreation(
  manifestPath: string,
  entry: { slug: string; repoPath: string; worktreePath: string; createdAt: string },
): void {
  const entries = readManifest(manifestPath);
  const idx = entries.findIndex(e => e.slug === entry.slug);
  if (idx !== -1) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.push(entry);
  }
  writeManifest(manifestPath, entries);
}

/**
 * Records a worktree completion entry in the manifest file.
 * Creates the manifest if it doesn't exist. Overwrites existing entry for the same slug.
 */
export function recordWorktreeCompletion(
  manifestPath: string,
  entry: WorktreeManifestEntry,
): void {
  const entries = readManifest(manifestPath);
  const idx = entries.findIndex(e => e.slug === entry.slug);
  if (idx !== -1) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.push(entry);
  }
  writeManifest(manifestPath, entries);
}

/**
 * Scans the worktree manifest and removes entries older than retentionDays.
 * Returns an array of worktree paths that were removed.
 */
export function cleanupExpired(manifestPath: string, retentionDays: number): string[] {
  const entries = readManifest(manifestPath);
  if (entries.length === 0) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const removed: string[] = [];
  const remaining: WorktreeManifestEntry[] = [];

  for (const entry of entries) {
    if (!entry.completedAt) {
      remaining.push(entry);
      continue;
    }
    const completedAt = new Date(entry.completedAt);
    if (completedAt < cutoff) {
      removeWorktree(entry.repoPath, entry.worktreePath, entry.slug);
      removed.push(entry.worktreePath);
    } else {
      remaining.push(entry);
    }
  }

  writeManifest(manifestPath, remaining);
  return removed;
}
