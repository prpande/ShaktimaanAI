export const DEFAULT_AGENT_NAMES = {
  questions: "Gargi",
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
  quick: "Astra",
  slackIO: "Narada",
} as const satisfies Record<string, string>;

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export const DEFAULT_STAGE_TOOLS: Record<string, { allowed: string[]; disallowed: string[] }> = {
  questions:  { allowed: ["Read","Glob","Grep","Bash","WebSearch","WebFetch"], disallowed: ["Write","Edit"] },
  research:   { allowed: ["Read","Glob","Grep","Bash","WebSearch","WebFetch","mcp__claude_ai_Slack__*","mcp__plugin_notion_notion__*"], disallowed: ["Write","Edit"] },
  design:     { allowed: ["Read","Glob","Grep","Bash"], disallowed: ["Write","Edit"] },
  structure:  { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  plan:       { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  impl:       { allowed: ["Read","Write","Edit","Bash","Glob","Grep"], disallowed: [] },
  validate:   { allowed: ["Read","Bash","Glob","Grep"], disallowed: ["Write","Edit"] },
  review:     { allowed: ["Read","Glob","Grep"], disallowed: ["Write","Edit","Bash"] },
  pr:         { allowed: ["Bash"], disallowed: ["Write","Edit","Read","Glob","Grep"] },
  quick:      { allowed: ["Read","Glob","Grep","Bash","WebSearch","WebFetch","mcp__plugin_notion_notion__*","mcp__claude_ai_Slack__slack_read_*"], disallowed: ["Write","Edit"] },
  "quick-execute": { allowed: ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","mcp__plugin_notion_notion__*","mcp__claude_ai_Slack__*"], disallowed: [] },
  "slack-io":  { allowed: ["mcp__claude_ai_Slack__*","Read","Write"], disallowed: ["Edit","Bash","Glob","Grep"] },
};

export const STAGE_CONTEXT_RULES: Record<string, {
  includeTaskContent: boolean;
  previousOutputLabel: string | null;
  includeRepoContext: boolean;
}> = {
  questions: { includeTaskContent: true,  previousOutputLabel: null,                      includeRepoContext: true },
  research:  { includeTaskContent: false, previousOutputLabel: "Questions to Investigate", includeRepoContext: true },
  design:    { includeTaskContent: true,  previousOutputLabel: "Research Findings",        includeRepoContext: true },
  structure: { includeTaskContent: false, previousOutputLabel: "Design Document",          includeRepoContext: false },
  plan:      { includeTaskContent: false, previousOutputLabel: "Implementation Slices",    includeRepoContext: true },
  impl:      { includeTaskContent: true,  previousOutputLabel: "Implementation Plan",      includeRepoContext: true },
  review:    { includeTaskContent: true,  previousOutputLabel: "Implementation Output",   includeRepoContext: true },
  validate:  { includeTaskContent: false, previousOutputLabel: "Review Output",            includeRepoContext: true },
  pr:        { includeTaskContent: true,  previousOutputLabel: "Review Output",            includeRepoContext: false },
  quick:     { includeTaskContent: true,  previousOutputLabel: null,                      includeRepoContext: true },
  "quick-execute": { includeTaskContent: true, previousOutputLabel: null,                includeRepoContext: true },
  "slack-io": { includeTaskContent: true, previousOutputLabel: null,                      includeRepoContext: false },
};

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
    pollIntervalActiveSec: number;
    pollIntervalIdleSec: number;
    notifyLevel: "minimal" | "bookends" | "stages";
    allowDMs: boolean;
    requirePrefix: boolean;
    prefix: string;
    dmUserIds: string[];
  };
  quickTask: {
    requireReview: boolean;
  };
  agents: {
    names: Record<string, string>;
    defaultStages: string[];
    defaultReviewAfter: string;
    maxConcurrentTotal: number;
    maxTurns: Record<string, number>;
    timeoutsMinutes: Record<string, number>;
    heartbeatTimeoutMinutes: number;
    retryCount: number;
    maxValidateRetries: number;
    maxSuggestionRetriesPerCycle: number;
    tools: Record<string, { allowed?: string[]; disallowed?: string[] }>;
    models: Record<string, string>;
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
    pollIntervalActiveSec: 300,
    pollIntervalIdleSec: 45,
    notifyLevel: "bookends",
    allowDMs: false,
    requirePrefix: true,
    prefix: "shkmn",
    dmUserIds: [],
  },
  quickTask: {
    requireReview: true,
  },
  agents: {
    names: { ...DEFAULT_AGENT_NAMES },
    defaultStages: [
      "questions", "research", "design", "structure", "plan",
      "impl", "review", "validate", "pr",
    ],
    defaultReviewAfter: "design",
    maxConcurrentTotal: 3,
    maxTurns: {
      questions: 30,
      research: 60,
      design: 30,
      structure: 20,
      plan: 30,
      impl: 100,
      validate: 15,
      review: 40,
      pr: 20,
      "quick-triage": 5,
      quick: 5,
      "quick-execute": 40,
      "slack-io": 15,
    },
    timeoutsMinutes: {
      questions: 15,
      research: 45,
      design: 30,
      structure: 20,
      plan: 30,
      impl: 90,
      validate: 30,
      review: 45,
      pr: 15,
      "quick-triage": 2,
      quick: 2,
      "quick-execute": 30,
      "slack-io": 2,
    },
    heartbeatTimeoutMinutes: 10,
    retryCount: 1,
    maxValidateRetries: 2,
    maxSuggestionRetriesPerCycle: 1,
    tools: {},
    models: {
      questions: "sonnet",
      research: "opus",
      design: "opus",
      structure: "sonnet",
      plan: "opus",
      impl: "opus",
      review: "sonnet",
      validate: "sonnet",
      pr: "sonnet",
      "quick-triage": "haiku",
      quick: "haiku",
      "quick-execute": "sonnet",
      "slack-io": "haiku",
    },
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
