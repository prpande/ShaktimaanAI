import { readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "agents");
const dest = join(root, "dist", "agents");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith(".md"));
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file));
}

console.log(`Copied ${files.length} agent prompt(s) to dist/agents/`);
