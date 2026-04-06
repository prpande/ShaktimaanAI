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
  canStartAgent(stage: string): boolean;
  abortAll(): void;
  abortBySlug(slug: string): boolean;
}

export function createAgentRegistry(maxConcurrentTotal: number): AgentRegistry {
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

    canStartAgent(_stage: string) {
      return agents.size < maxConcurrentTotal;
    },

    abortAll() {
      for (const entry of agents.values()) {
        entry.abortController.abort();
      }
      agents.clear();
    },

    abortBySlug(slug: string): boolean {
      for (const [id, entry] of agents.entries()) {
        if (entry.slug === slug) {
          entry.abortController.abort();
          agents.delete(id);
          return true;
        }
      }
      return false;
    },
  };
}
