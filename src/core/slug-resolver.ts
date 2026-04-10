import * as fs from "node:fs";
import * as path from "node:path";
import { STAGE_DIR_MAP, DIR_STAGE_MAP } from "./stage-map.js";
import { TERMINAL_DIR_MAP } from "../config/paths.js";

export interface ActiveTask {
  slug: string;
  dir: string;    // e.g. "06-impl/pending"
  stage: string;  // e.g. "impl"
  status: "active" | "held";
}

/**
 * Scans runtime directory for active tasks across all pipeline stage dirs
 * (pending/ and done/ subdirs of 01-questions through 09-pr) plus 12-hold/.
 * Ignores 10-complete and 11-failed.
 */
export function listActiveSlugs(runtimeDir: string): ActiveTask[] {
  const results: ActiveTask[] = [];

  // Scan pipeline stage dirs (01-questions through 09-pr)
  for (const stageDir of Object.values(STAGE_DIR_MAP)) {
    const stageName = DIR_STAGE_MAP[stageDir] ?? stageDir;

    for (const sub of ["pending", "done"]) {
      const absSubDir = path.join(runtimeDir, stageDir, sub);
      if (!fs.existsSync(absSubDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absSubDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        results.push({
          slug: entry.name,
          dir: `${stageDir}/${sub}`,
          stage: stageName,
          status: "active",
        });
      }
    }
  }

  // Scan 12-hold (flat structure, no pending/done)
  const holdDir = path.join(runtimeDir, TERMINAL_DIR_MAP.hold);
  if (fs.existsSync(holdDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(holdDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      results.push({
        slug: entry.name,
        dir: TERMINAL_DIR_MAP.hold,
        stage: "hold",
        status: "held",
      });
    }
  }

  return results;
}

/**
 * Resolves a user query to one or more active task slugs.
 *
 * Priority:
 * 1. Exact match → single string
 * 2. Prefix match (exactly one) → single string; (2+) → string[]
 * 3. Keyword match (all query words appear in slug) → string (1) or string[] (2+)
 *
 * Returns:
 * - string: unambiguous single match
 * - string[]: ambiguous (2+ matches) or no match (empty array)
 */
export function resolveSlug(
  query: string,
  runtimeDir: string,
): string | string[] {
  const tasks = listActiveSlugs(runtimeDir);
  const slugs = tasks.map((t) => t.slug);

  // 1. Exact match
  if (slugs.includes(query)) {
    return query;
  }

  // 2. Prefix match
  const prefixMatches = slugs.filter((s) => s.startsWith(query));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) return prefixMatches;

  // 3. Keyword match — all words in query must appear in the slug
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const keywordMatches = slugs.filter((s) =>
    words.every((w) => s.toLowerCase().includes(w)),
  );
  if (keywordMatches.length === 1) return keywordMatches[0];
  if (keywordMatches.length > 1) return keywordMatches;

  return [];
}
