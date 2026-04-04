import { randomUUID } from "node:crypto";

export interface AgentEntry {
  id: string;
  slug: string;
  stage: string;
  agentName: string;
  startedAt: string;
  abortController: AbortController;
}

export interface AgentRegistry {
  register(slug: string, stage: string, agentName: string, abortController: AbortController): string;
  unregister(id: string): void;
  getActive(): AgentEntry[];
  getActiveCount(): number;
  getActiveValidateCount(): number;
  canStartAgent(stage: string): boolean;
  abortAll(): void;
}

export function createAgentRegistry(maxConcurrentTotal: number, maxConcurrentValidate: number): AgentRegistry {
  const agents = new Map<string, AgentEntry>();

  return {
    register(slug, stage, agentName, abortController) {
      const id = randomUUID();
      agents.set(id, {
        id,
        slug,
        stage,
        agentName,
        startedAt: new Date().toISOString(),
        abortController,
      });
      return id;
    },

    unregister(id) {
      agents.delete(id);
    },

    getActive() {
      return Array.from(agents.values());
    },

    getActiveCount() {
      return agents.size;
    },

    getActiveValidateCount() {
      let count = 0;
      for (const entry of agents.values()) {
        if (entry.stage === "validate") count++;
      }
      return count;
    },

    canStartAgent(stage) {
      if (agents.size >= maxConcurrentTotal) return false;
      if (stage === "validate" && this.getActiveValidateCount() >= maxConcurrentValidate) {
        return false;
      }
      return true;
    },

    abortAll() {
      for (const entry of agents.values()) {
        entry.abortController.abort();
      }
      agents.clear();
    },
  };
}
