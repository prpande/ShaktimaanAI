import { describe, it, expect, beforeEach } from "vitest";
import { createAgentRegistry } from "../../src/core/registry.js";

// ─── register ────────────────────────────────────────────────────────────────

describe("register", () => {
  it("returns a non-empty id string", () => {
    const registry = createAgentRegistry(5, 2);
    const id = registry.register("my-slug", "questions", "Narada", new AbortController());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("increments active count after each registration", () => {
    const registry = createAgentRegistry(5, 2);
    expect(registry.getActiveCount()).toBe(0);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    expect(registry.getActiveCount()).toBe(1);
    registry.register("slug-2", "impl", "Parashurama", new AbortController());
    expect(registry.getActiveCount()).toBe(2);
  });

  it("returns unique ids for each registration", () => {
    const registry = createAgentRegistry(5, 2);
    const id1 = registry.register("slug-1", "questions", "Narada", new AbortController());
    const id2 = registry.register("slug-2", "impl", "Parashurama", new AbortController());
    expect(id1).not.toBe(id2);
  });

  it("stores agent details accessible via getActive()", () => {
    const registry = createAgentRegistry(5, 2);
    const beforeRegister = new Date().toISOString();
    const ctrl = new AbortController();
    const id = registry.register("feature-slug", "validate", "Chitragupta", ctrl);
    const afterRegister = new Date().toISOString();

    const active = registry.getActive();
    expect(active).toHaveLength(1);

    const entry = active[0];
    expect(entry.id).toBe(id);
    expect(entry.slug).toBe("feature-slug");
    expect(entry.stage).toBe("validate");
    expect(entry.agentName).toBe("Chitragupta");
    expect(entry.abortController).toBe(ctrl);

    // startedAt should be a valid ISO timestamp between before/after
    expect(entry.startedAt >= beforeRegister).toBe(true);
    expect(entry.startedAt <= afterRegister).toBe(true);
  });
});

// ─── unregister ──────────────────────────────────────────────────────────────

describe("unregister", () => {
  it("removes an agent by id", () => {
    const registry = createAgentRegistry(5, 2);
    const id = registry.register("slug-1", "questions", "Narada", new AbortController());
    expect(registry.getActiveCount()).toBe(1);
    registry.unregister(id);
    expect(registry.getActiveCount()).toBe(0);
  });

  it("is a no-op for unknown ids", () => {
    const registry = createAgentRegistry(5, 2);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    expect(() => registry.unregister("non-existent-id")).not.toThrow();
    expect(registry.getActiveCount()).toBe(1);
  });

  it("only removes the specified agent, leaving others intact", () => {
    const registry = createAgentRegistry(5, 2);
    const id1 = registry.register("slug-1", "questions", "Narada", new AbortController());
    const id2 = registry.register("slug-2", "impl", "Parashurama", new AbortController());
    registry.unregister(id1);

    const active = registry.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id2);
  });
});

// ─── getActiveValidateCount ───────────────────────────────────────────────────

describe("getActiveValidateCount", () => {
  it("returns 0 when no agents are registered", () => {
    const registry = createAgentRegistry(5, 2);
    expect(registry.getActiveValidateCount()).toBe(0);
  });

  it("counts only validate-stage agents", () => {
    const registry = createAgentRegistry(10, 5);
    registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    registry.register("slug-2", "questions", "Narada", new AbortController());
    registry.register("slug-3", "validate", "Chitragupta", new AbortController());
    expect(registry.getActiveValidateCount()).toBe(2);
  });

  it("updates count after unregister", () => {
    const registry = createAgentRegistry(10, 5);
    const id = registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    registry.register("slug-2", "validate", "Chitragupta", new AbortController());
    expect(registry.getActiveValidateCount()).toBe(2);
    registry.unregister(id);
    expect(registry.getActiveValidateCount()).toBe(1);
  });
});

// ─── canStartAgent ───────────────────────────────────────────────────────────

describe("canStartAgent", () => {
  it("returns true when no agents are running", () => {
    const registry = createAgentRegistry(2, 1);
    expect(registry.canStartAgent("questions")).toBe(true);
  });

  it("returns true when under total limit", () => {
    const registry = createAgentRegistry(3, 2);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    expect(registry.canStartAgent("impl")).toBe(true);
  });

  it("returns false when at total limit (2 agents, limit 2)", () => {
    const registry = createAgentRegistry(2, 1);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    registry.register("slug-2", "impl", "Parashurama", new AbortController());
    expect(registry.canStartAgent("questions")).toBe(false);
  });

  it("returns true again after unregistering one agent below total limit", () => {
    const registry = createAgentRegistry(2, 1);
    const id1 = registry.register("slug-1", "questions", "Narada", new AbortController());
    registry.register("slug-2", "impl", "Parashurama", new AbortController());
    expect(registry.canStartAgent("questions")).toBe(false);
    registry.unregister(id1);
    expect(registry.canStartAgent("questions")).toBe(true);
  });

  it("returns false when validate limit reached, even if total limit not reached", () => {
    const registry = createAgentRegistry(5, 1);
    registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    expect(registry.canStartAgent("validate")).toBe(false);
  });

  it("allows a non-validate agent when validate limit is reached but total is not", () => {
    const registry = createAgentRegistry(5, 1);
    registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    expect(registry.canStartAgent("questions")).toBe(true);
  });

  it("allows validate when under both limits", () => {
    const registry = createAgentRegistry(5, 2);
    registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    expect(registry.canStartAgent("validate")).toBe(true);
  });

  it("blocks validate when exactly at validate limit with maxConcurrentValidate=2", () => {
    const registry = createAgentRegistry(10, 2);
    registry.register("slug-1", "validate", "Chitragupta", new AbortController());
    registry.register("slug-2", "validate", "Chitragupta", new AbortController());
    expect(registry.canStartAgent("validate")).toBe(false);
    expect(registry.canStartAgent("questions")).toBe(true);
  });
});

// ─── abortAll ────────────────────────────────────────────────────────────────

describe("abortAll", () => {
  it("calls abort() on all registered controllers", () => {
    const registry = createAgentRegistry(5, 2);
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const ctrl3 = new AbortController();

    registry.register("slug-1", "questions", "Narada", ctrl1);
    registry.register("slug-2", "impl", "Parashurama", ctrl2);
    registry.register("slug-3", "validate", "Chitragupta", ctrl3);

    registry.abortAll();

    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl3.signal.aborted).toBe(true);
  });

  it("clears the registry after aborting", () => {
    const registry = createAgentRegistry(5, 2);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    registry.register("slug-2", "impl", "Parashurama", new AbortController());

    registry.abortAll();

    expect(registry.getActiveCount()).toBe(0);
    expect(registry.getActive()).toHaveLength(0);
  });

  it("is a no-op when registry is empty", () => {
    const registry = createAgentRegistry(5, 2);
    expect(() => registry.abortAll()).not.toThrow();
    expect(registry.getActiveCount()).toBe(0);
  });

  it("allows new registrations after abortAll", () => {
    const registry = createAgentRegistry(5, 2);
    registry.register("slug-1", "questions", "Narada", new AbortController());
    registry.abortAll();

    const id = registry.register("slug-2", "impl", "Parashurama", new AbortController());
    expect(registry.getActiveCount()).toBe(1);
    expect(typeof id).toBe("string");
  });
});
