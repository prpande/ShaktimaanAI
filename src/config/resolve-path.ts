import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveConfigPath(): string {
  const envPath = process.env.SHKMN_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  const localPath = join(process.cwd(), "shkmn.config.json");
  if (existsSync(localPath)) return localPath;

  const homePath = join(homedir(), ".shkmn", "runtime", "shkmn.config.json");
  if (existsSync(homePath)) return homePath;

  console.error(
    "Config not found. Searched:\n" +
    `  $SHKMN_CONFIG=${envPath ?? "(not set)"}\n` +
    `  ${localPath}\n` +
    `  ${homePath}\n` +
    "Run 'shkmn init' to create a config."
  );
  process.exit(1);
}
