import path from "node:path";
import { maskSecret } from "./extract.js";
import {
  applyEnvUpdate,
  findEnvFiles,
  planEnvUpdate,
  readEnvFile,
  unifiedDiff,
  type EnvUpdatePlan,
  type SlackEnvVars,
} from "./envfile.js";

export function displayName(file: string): string {
  return path.basename(file);
}

export function wroteMessage(plan: EnvUpdatePlan): string {
  const name = displayName(plan.file);
  const added = plan.added.map((item) => item.key);
  const replaced = plan.replaced.map((item) => item.key);
  if (plan.isNew) return `Created ${name} and wrote ${added.join(", ")}.`;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`wrote ${added.join(", ")}`);
  if (replaced.length > 0) parts.push(`replaced ${replaced.join(", ")}`);
  return parts.length > 0 ? `${parts.join("; ")} in ${name}.` : `Updated ${name}.`;
}

export function maskSecretsInText(text: string): string {
  return text.replace(/xox[cd]-[^\s"']+/g, (token) => maskSecret(token));
}

export function nothingToWriteMessage(plan: EnvUpdatePlan): string {
  const notes = [
    ...plan.alreadySet.map((key) => `${key} is already set`),
    ...plan.blocked.map((item) => `${item.key} ${item.reason}`),
  ];
  return notes.length > 0
    ? `Nothing new to write to ${displayName(plan.file)}. ${notes.join("; ")}.`
    : `Nothing new to write to ${displayName(plan.file)}.`;
}

export function envConfirmText(plan: EnvUpdatePlan): string {
  return [
    plan.isNew
      ? `warning: this will create a new file (${displayName(plan.file)}) in the current directory`
      : null,
    ...plan.warnings.map((line) => `warning: ${line}`),
    ...plan.replaced.map((item) => `warning: ${item.key} already exists; will replace`),
    ...plan.alreadySet.map((key) => `${key} is already set; skipping`),
    ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    unifiedDiff(plan.file, plan.original, plan.next),
  ]
    .filter(Boolean)
    .join("\n");
}

export function envConfirmTitle(plan: EnvUpdatePlan): string {
  const name = displayName(plan.file);
  if (plan.isNew) return `Create a new ${name} file?`;
  if (plan.replaced.length > 0 && plan.added.length === 0) {
    return `Replace ${plan.replaced.map((item) => item.key).join(", ")} in ${name}?`;
  }
  return `Apply changes to ${name}?`;
}

export function hasEnvChanges(plan: EnvUpdatePlan): boolean {
  return plan.added.length > 0 || plan.replaced.length > 0;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function defaultEnvFile(cwd = process.cwd()): string {
  return path.join(cwd, ".env");
}

export async function planEnvWrite(
  vars: SlackEnvVars,
  extraWarnings: string[] = [],
  file: string,
): Promise<EnvUpdatePlan> {
  let original = "";
  let isNew = false;
  try {
    original = await readEnvFile(file);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
    isNew = true;
  }
  return { ...planEnvUpdate(file, original, vars, extraWarnings), isNew };
}

export { applyEnvUpdate, findEnvFiles };
