import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { type ResolvedConfig } from "../config/loader.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  source: "slack" | "dashboard" | "cli";
  content: string;
  repo?: string;
  adoItem?: string;
  slackThread?: string;
  stages?: string[];
  reviewAfter?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the first non-empty trimmed line of the content (max 80 chars),
 * or "untitled-task" if no non-empty line exists.
 */
export function extractTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 80);
    }
  }
  return "untitled-task";
}

/**
 * Kebab-cases a title: lowercase, replaces non-alphanumeric chars with hyphens,
 * collapses consecutive hyphens, trims leading/trailing hyphens, truncates the
 * base to 50 chars, then appends a "-YYYYMMDDHHMMSS" timestamp.
 */
export function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, ""); // trim any trailing hyphen introduced by truncation

  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const timestamp =
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  return `${base}-${timestamp}`;
}

/**
 * Builds the markdown content for a .task file from the given input and config.
 */
export function buildTaskFileContent(
  input: CreateTaskInput,
  config: ResolvedConfig,
): string {
  const title = extractTitle(input.content);
  const stages =
    input.stages && input.stages.length > 0
      ? input.stages.join(", ")
      : config.agents.defaultStages.join(", ");
  const reviewAfter = input.reviewAfter ?? config.agents.defaultReviewAfter;

  const lines: string[] = [];

  lines.push(`# Task: ${title}`);
  lines.push("");
  lines.push("## What I want done");
  lines.push(input.content);
  lines.push("");
  lines.push("## Context");
  lines.push(`Source: ${input.source}`);
  lines.push("");
  lines.push("## Repo");
  if (input.repo) {
    lines.push(input.repo);
  }
  lines.push("");
  lines.push("## ADO Item");
  if (input.adoItem) {
    lines.push(input.adoItem);
  }
  lines.push("");
  lines.push("## Slack Thread");
  if (input.slackThread) {
    lines.push(input.slackThread);
  }
  lines.push("");
  lines.push("## Pipeline Config");
  lines.push(`stages: ${stages}`);
  lines.push(`review_after: ${reviewAfter}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Creates a task: extracts title, generates slug, builds .task file content,
 * writes to {runtimeDir}/00-inbox/{slug}.task, and returns the slug.
 */
export function createTask(
  input: CreateTaskInput,
  runtimeDir: string,
  config: ResolvedConfig,
): string {
  const title = extractTitle(input.content);
  const slug = generateSlug(title);
  const content = buildTaskFileContent(input, config);
  const filePath = join(runtimeDir, "00-inbox", `${slug}.task`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return slug;
}
