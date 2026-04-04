import type { Command } from "commander";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show recent completed tasks")
    .option("--count <count>", "Number of tasks to show", "10")
    .action(() => {
      console.log("shkmn history — not yet implemented (Spec 5: History & Reporting)");
      process.exit(1);
    });
}
