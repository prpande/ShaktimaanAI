export const DEFAULT_AGENT_NAMES = {
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
} as const;

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export const DEFAULT_CONFIG = {
  pipeline: {
    runtimeDir: "",
    dashboardRepoLocal: "",
    dashboardRepoUrl: "",
  },
  repos: {
    root: "",
    aliases: {} as Record<string, { path: string; sequentialBuild?: boolean }>,
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
    names: { ...DEFAULT_AGENT_NAMES } as Record<string, string>,
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "validate", "review", "pr",
    ] as string[],
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
    } as Record<string, number>,
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
    } as Record<string, number>,
    heartbeatTimeoutMinutes: 10,
    retryCount: 1,
  },
  schedule: {
    rollupTime: "23:55",
    notionPushDay: "Friday",
    notionPushTime: "18:00",
    monthlyReportDay: 1,
    monthlyReportTime: "08:00",
  },
} as const;

export type ShkmnConfig = typeof DEFAULT_CONFIG;
