import { execSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  slug: string;
}

export interface WorktreeManifestEntry {
  slug: string;
  repoPath: string;
  worktreePath: string;
  completedAt: string;
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
    return worktreePath;
  }

  mkdirSync(worktreesDir, { recursive: true });

  // Build the git worktree add command
  // -b creates a new branch; if baseBranch is given, branch from it
  const baseRef = baseBranch ?? "HEAD";
  execSync(
    `git worktree add -b "${branchName}" "${worktreePath}" ${baseRef}`,
    { cwd: repoPath, stdio: "pipe" },
  );

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
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // If the worktree directory is already gone, git worktree prune will clean metadata
    try {
      execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" });
    } catch {
      // ignore
    }
  }

  // Delete the branch
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoPath, stdio: "pipe" });
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
    output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
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
 * Records a worktree completion entry in the manifest file.
 * Creates the manifest if it doesn't exist. Overwrites existing entry for the same slug.
 */
export function recordWorktreeCompletion(
  manifestPath: string,
  entry: WorktreeManifestEntry,
): void {
  let entries: WorktreeManifestEntry[] = [];
  if (existsSync(manifestPath)) {
    try {
      entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as WorktreeManifestEntry[];
    } catch {
      entries = [];
    }
  }

  // Replace existing entry for same slug or append
  const idx = entries.findIndex(e => e.slug === entry.slug);
  if (idx !== -1) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  writeFileSync(manifestPath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Scans the worktree manifest and removes entries older than retentionDays.
 * Returns an array of worktree paths that were removed.
 */
export function cleanupExpired(manifestPath: string, retentionDays: number): string[] {
  if (!existsSync(manifestPath)) return [];

  let entries: WorktreeManifestEntry[];
  try {
    entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as WorktreeManifestEntry[];
  } catch {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const removed: string[] = [];
  const remaining: WorktreeManifestEntry[] = [];

  for (const entry of entries) {
    const completedAt = new Date(entry.completedAt);
    if (completedAt < cutoff) {
      removeWorktree(entry.repoPath, entry.worktreePath, entry.slug);
      removed.push(entry.worktreePath);
    } else {
      remaining.push(entry);
    }
  }

  writeFileSync(manifestPath, JSON.stringify(remaining, null, 2), "utf-8");
  return removed;
}
