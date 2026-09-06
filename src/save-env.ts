import path from "node:path";
import { maskSecret, type SlackCredentials } from "./extract.js";
import { choose, confirm } from "./choice-ui.js";
import {
  applyEnvUpdate,
  findEnvFiles,
  planEnvUpdate,
  readEnvFile,
  slackVarsFromCredentials,
  unifiedDiff,
} from "./envfile.js";
import { isInteractiveUi } from "./ui.js";

function displayName(file: string): string {
  return path.basename(file);
}

function wroteMessage(file: string, keys: string[]): string {
  return `Wrote ${keys.join(", ")} to ${displayName(file)}.`;
}

function maskSecretsInText(text: string): string {
  return text.replace(/xox[cd]-[A-Za-z0-9-]+/g, (token) => maskSecret(token));
}

export async function maybeWriteEnvFile(creds: SlackCredentials): Promise<string> {
  if (!isInteractiveUi()) return "";

  const files = await findEnvFiles();
  if (files.length === 0) return "No .env file found in this directory.";

  const { vars, warnings: credWarnings } = slackVarsFromCredentials(creds);
  if (!vars.SLACK_XOXD && !vars.SLACK_TEAM_XOXC && !vars.SLACK_ENTERPRISE_XOXC) {
    return "No Slack tokens to save.";
  }

  let file: string | null = files.length === 1 ? files[0]! : null;
  if (!file) {
    file = await choose(
      "Save Slack credentials to which env file?",
      [
        ...files.map((item) => ({ label: displayName(item), value: item })),
        { label: "Don't save", value: null },
      ],
    );
    if (!file) return "";
  }

  const original = await readEnvFile(file);
  const plan = planEnvUpdate(file, original, vars, credWarnings);

  if (plan.added.length === 0) {
    const notes = [
      ...plan.alreadySet.map((key) => `${key} is already set`),
      ...plan.blocked.map((item) => `${item.key} ${item.reason}`),
    ];
    return notes.length > 0
      ? `Nothing new to write to ${displayName(file)}. ${notes.join("; ")}.`
      : `Nothing new to write to ${displayName(file)}.`;
  }

  const extra = [
    ...plan.warnings.map((line) => `warning: ${line}`),
    ...plan.alreadySet.map((key) => `${key} is already set; skipping`),
    ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    unifiedDiff(plan.file, plan.original, plan.next),
  ]
    .filter(Boolean)
    .join("\n");

  const apply = await confirm(`Apply changes to ${displayName(file)}?`, maskSecretsInText(extra));
  if (!apply) return "";

  await applyEnvUpdate(plan);
  return wroteMessage(file, plan.added.map((item) => item.key));
}
