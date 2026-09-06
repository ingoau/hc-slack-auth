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
  const keys = plan.added.map((item) => item.key).join(", ");
  if (plan.isNew) return `Created ${displayName(plan.file)} and wrote ${keys}.`;
  return `Wrote ${keys} to ${displayName(plan.file)}.`;
}

export function maskSecretsInText(text: string): string {
  return text.replace(/xox[cd]-[A-Za-z0-9-]+/g, (token) => maskSecret(token));
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
    ...plan.alreadySet.map((key) => `${key} is already set; skipping`),
    ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    unifiedDiff(plan.file, plan.original, plan.next),
  ]
    .filter(Boolean)
    .join("\n");
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
