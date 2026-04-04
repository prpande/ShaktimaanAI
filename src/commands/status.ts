import type { Command } from "commander";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show active pipeline runs and their current stages")
    .action(() => {
      console.log("shkmn status — not yet implemented (Spec 3: Task Lifecycle)");
      process.exit(1);
    });
}
