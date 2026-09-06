import path from "node:path";
import type { SlackCredentials } from "./extract.js";
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

export async function maybeWriteEnvFile(creds: SlackCredentials): Promise<void> {
  if (!isInteractiveUi()) return;

  const files = await findEnvFiles();
  if (files.length === 0) return;

  const { vars, warnings: credWarnings } = slackVarsFromCredentials(creds);
  if (!vars.SLACK_XOXD && !vars.SLACK_TEAM_XOXC && !vars.SLACK_ENTERPRISE_XOXC) return;

  let file: string | null = null;
  if (files.length === 1) {
    const accepted = await confirm(`Add Slack credentials to ${displayName(files[0]!)}?`);
    if (!accepted) return;
    file = files[0]!;
  } else {
    file = await choose(
      "Add Slack credentials to which env file?",
      [
        ...files.map((item) => ({ label: displayName(item), value: item })),
        { label: "Don't save", value: null },
      ],
    );
    if (!file) return;
  }

  const original = await readEnvFile(file);
  const plan = planEnvUpdate(file, original, vars, credWarnings);

  if (plan.added.length === 0) {
    const notes = [
      ...plan.warnings.map((line) => `warning: ${line}`),
      ...plan.alreadySet.map((key) => `${key} is already set`),
      ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    ]
      .filter(Boolean)
      .join("\n");
    await choose("Nothing new to write to the env file.", [{ label: "OK", value: true }], notes);
    return;
  }

  const extra = [
    ...plan.warnings.map((line) => `warning: ${line}`),
    ...plan.alreadySet.map((key) => `${key} is already set; skipping`),
    ...plan.blocked.map((item) => `warning: ${item.key} ${item.reason}`),
    unifiedDiff(plan.file, plan.original, plan.next),
  ]
    .filter(Boolean)
    .join("\n");

  const apply = await confirm(`Apply changes to ${displayName(file)}?`, extra);
  if (!apply) return;

  await applyEnvUpdate(plan);
}
