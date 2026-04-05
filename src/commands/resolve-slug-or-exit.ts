import { resolveSlug } from "../core/slug-resolver.js";

export function resolveSlugOrExit(query: string, runtimeDir: string): string {
  const result = resolveSlug(query, runtimeDir);
  if (Array.isArray(result)) {
    if (result.length === 0) {
      console.error(`No active or held task matches "${query}".`);
      process.exit(1);
    }
    console.error(`Multiple tasks match "${query}":`);
    for (const s of result) console.error(`  ${s}`);
    console.error("Specify the full slug or a more specific prefix.");
    process.exit(1);
  }
  return result;
}
