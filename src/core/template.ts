import { readFileSync } from "node:fs";
import { join } from "node:path";

export function hydrateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

export function loadTemplate(templateDir: string, templateName: string): string {
  const filePath = join(templateDir, `prompt-${templateName}.md`);
  return readFileSync(filePath, "utf-8");
}
