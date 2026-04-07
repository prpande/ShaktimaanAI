// ─── Slug pattern ────────────────────────────────────────────────────────────

/**
 * Matches a kebab-case slug with a 14-digit timestamp suffix.
 * Pattern: at least two kebab segments before the timestamp.
 */
const SLUG_PATTERN = /([a-z0-9]+-){2,}\d{14}/;

export function extractSlug(input: string): string | null {
  const match = input.match(SLUG_PATTERN);
  return match ? match[0] : null;
}
