import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("CLI version", () => {
  it("package.json version is a valid semver", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../package.json"), "utf8"),
    );
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
