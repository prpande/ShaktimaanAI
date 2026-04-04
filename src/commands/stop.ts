import type { Command } from "commander";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the Heimdall watcher gracefully")
    .action(() => {
      console.log("shkmn stop — not yet implemented (Spec 2: Pipeline Engine)");
      process.exit(1);
    });
}
