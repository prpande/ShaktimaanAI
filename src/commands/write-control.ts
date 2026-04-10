import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findConfigPath, loadConfig } from "../config/loader.js";
import { resolveSlugOrExit } from "./resolve-slug-or-exit.js";

export function writeControlFile(
  rawSlug: string,
  payload: Record<string, unknown>,
): string {
  const config = loadConfig(findConfigPath());
  const slug = resolveSlugOrExit(rawSlug, config.paths.runtimeDir);
  const inboxDir = config.paths.terminals.inbox;
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, `${slug}.control`),
    JSON.stringify({ ...payload, slug }),
    "utf-8",
  );
  return slug;
}
