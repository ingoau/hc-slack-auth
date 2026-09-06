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

export function wroteMessage(file: string, keys: string[]): string {
  return `Wrote ${keys.join(", ")} to ${displayName(file)}.`;
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
    ...plan.warnings.map((line) => `warning: ${line}`),
    ...plan.alreadySet.map((key) => `${key} is already set; skipping`),
    ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    unifiedDiff(plan.file, plan.original, plan.next),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function planEnvWrite(
  vars: SlackEnvVars,
  extraWarnings: string[] = [],
  file: string,
): Promise<EnvUpdatePlan> {
  const original = await readEnvFile(file);
  return planEnvUpdate(file, original, vars, extraWarnings);
}

export { applyEnvUpdate, findEnvFiles };
