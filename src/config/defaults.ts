export const DEFAULT_AGENT_NAMES: Record<string, string> = {
  questions: "Narada",
  research: "Chitragupta",
  design: "Vishwakarma",
  structure: "Vastu",
  plan: "Chanakya",
  workTree: "Hanuman",
  impl: "Karigar",
  validate: "Dharma",
  review: "Drona",
  pr: "Garuda",
  watcher: "Heimdall",
  taskCreator: "Brahma",
  approvalHandler: "Indra",
  intentClassifier: "Sutradhaar",
};

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export interface ShkmnConfig {
  pipeline: {
    runtimeDir: string;
    agentsDir: string;
    dashboardRepoLocal: string;
    dashboardRepoUrl: string;
  };
  repos: {
    root: string;
    aliases: Record<string, { path: string; sequentialBuild?: boolean }>;
  };
  ado: {
    org: string;
    project: string;
    defaultArea: string;
  };
  slack: {
    enabled: boolean;
    channel: string;
    channelId: string;
    pollIntervalSeconds: number;
  };
  agents: {
    names: Record<string, string>;
    defaultStages: string[];
    defaultReviewAfter: string;
    maxConcurrentTotal: number;
    maxConcurrentValidate: number;
    maxTurns: Record<string, number>;
    timeoutsMinutes: Record<string, number>;
    heartbeatTimeoutMinutes: number;
    retryCount: number;
    maxValidateRetries: number;
    maxReviewRecurrence: number;
  };
  schedule: {
    rollupTime: string;
    notionPushDay: string;
    notionPushTime: string;
    monthlyReportDay: number;
    monthlyReportTime: string;
  };
  worktree: {
    retentionDays: number;
    cleanupOnStartup: boolean;
  };
  review: {
    enforceSuggestions: boolean;
  };
}

export const DEFAULT_CONFIG: ShkmnConfig = {
  pipeline: {
    runtimeDir: "",
    agentsDir: "",
    dashboardRepoLocal: "",
    dashboardRepoUrl: "",
  },
  repos: {
    root: "",
    aliases: {},
  },
  ado: {
    org: "",
    project: "",
    defaultArea: "",
  },
  slack: {
    enabled: false,
    channel: "#agent-pipeline",
    channelId: "",
    pollIntervalSeconds: 30,
  },
  agents: {
    names: { ...DEFAULT_AGENT_NAMES },
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ],
    defaultReviewAfter: "design",
    maxConcurrentTotal: 3,
    maxConcurrentValidate: 1,
    maxTurns: {
      questions: 15,
      research: 30,
      design: 20,
      structure: 15,
      plan: 20,
      impl: 60,
      validate: 10,
      review: 30,
      classify: 5,
    },
    timeoutsMinutes: {
      questions: 15,
      research: 45,
      design: 30,
      structure: 20,
      plan: 30,
      impl: 90,
      validate: 15,
      review: 45,
      classify: 2,
    },
    heartbeatTimeoutMinutes: 10,
    retryCount: 1,
    maxValidateRetries: 2,
    maxReviewRecurrence: 3,
  },
  schedule: {
    rollupTime: "23:55",
    notionPushDay: "Friday",
    notionPushTime: "18:00",
    monthlyReportDay: 1,
    monthlyReportTime: "08:00",
  },
  worktree: {
    retentionDays: 7,
    cleanupOnStartup: true,
  },
  review: {
    enforceSuggestions: true,
  },
};
