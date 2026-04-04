import type { Command } from "commander";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Heimdall watcher and scheduler")
    .action(() => {
      console.log("shkmn start — not yet implemented (Spec 2: Pipeline Engine)");
      process.exit(1);
    });
}
