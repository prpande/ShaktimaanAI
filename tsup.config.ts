import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
