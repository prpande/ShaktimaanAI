import type { Command } from "commander";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail logs for a specific task")
    .argument("<slug>", "Task slug to tail logs for")
    .action(() => {
      console.log("shkmn logs — not yet implemented (Spec 3: Task Lifecycle)");
      process.exit(1);
    });
}
