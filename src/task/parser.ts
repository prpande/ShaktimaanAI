import { DEFAULT_CONFIG } from "../config/defaults.js";

export interface TaskMeta {
  title: string;
  description: string;
  context: string;
  repo: string;
  adoItem: string;
  slackThread: string;
  stages: string[];
  reviewAfter: string;
  stageHints: Record<string, string>;
}

/**
 * Split the markdown content into a map of `## Heading` -> body text.
 * Each body is the trimmed text between its heading and the next `## ` heading (or EOF).
 */
function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    if (h2Match) {
      if (currentHeading !== null) {
        sections[currentHeading] = currentLines.join("\n").trim();
      }
      currentHeading = h2Match[1];
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    sections[currentHeading] = currentLines.join("\n").trim();
  }

  return sections;
}

/**
 * Return the first non-empty trimmed line from a multi-line body string.
 */
function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function parseTaskFile(content: string): TaskMeta {
  // --- Title (# Task: ...) ---
  const titleMatch = content.match(/^#\s+Task:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Unnamed Task";

  const sections = parseSections(content);

  // --- Description ---
  const description = sections["What I want done"] ?? "";

  // --- Context ---
  const context = sections["Context"] ?? "";

  // --- Repo (single line) ---
  const repo = firstLine(sections["Repo"] ?? "");

  // --- ADO Item (single line) ---
  const adoItem = firstLine(sections["ADO Item"] ?? "");

  // --- Slack Thread (single line) ---
  const slackThread = firstLine(sections["Slack Thread"] ?? "");

  // --- Pipeline Config ---
  const pipelineBody = sections["Pipeline Config"];

  let stages: string[];
  let reviewAfter: string;

  if (pipelineBody !== undefined) {
    const stagesMatch = pipelineBody.match(/^stages:\s*(.+)$/m);
    if (stagesMatch) {
      stages = stagesMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      stages = [...DEFAULT_CONFIG.agents.defaultStages];
    }

    const reviewMatch = pipelineBody.match(/^review_after:\s*(.+)$/m);
    reviewAfter = reviewMatch ? reviewMatch[1].trim() : DEFAULT_CONFIG.agents.defaultReviewAfter;
  } else {
    stages = [...DEFAULT_CONFIG.agents.defaultStages];
    reviewAfter = DEFAULT_CONFIG.agents.defaultReviewAfter;
  }

  // --- Stage Hints ---
  const stageHints: Record<string, string> = {};
  const hintsBody = sections["Stage Hints"];
  if (hintsBody) {
    for (const line of hintsBody.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        stageHints[key] = value;
      }
    }
  }

  return {
    title,
    description,
    context,
    repo,
    adoItem,
    slackThread,
    stages,
    reviewAfter,
    stageHints,
  };
}
