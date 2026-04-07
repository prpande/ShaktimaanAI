import { describe, it, expect } from "vitest";
import { extractSlug } from "../../src/core/intent-classifier.js";

describe("extractSlug", () => {
  it("extracts a valid slug with 14-digit timestamp", () => {
    expect(extractSlug("cancel fix-auth-bug-20260404103000")).toBe("fix-auth-bug-20260404103000");
  });

  it("returns null when no slug present", () => {
    expect(extractSlug("hello world")).toBeNull();
  });

  it("requires at least two kebab segments before timestamp", () => {
    expect(extractSlug("fix-20260404103000")).toBeNull();
  });

  it("extracts slug from longer text", () => {
    expect(extractSlug("please cancel my-auth-fix-20260404103000 task")).toBe("my-auth-fix-20260404103000");
  });
});
