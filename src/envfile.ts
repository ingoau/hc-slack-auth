import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SlackCredentials, SlackTeamToken } from "./extract.js";

export const SLACK_XOXD = "SLACK_XOXD";
export const SLACK_TEAM_XOXC = "SLACK_TEAM_XOXC";
export const SLACK_ENTERPRISE_XOXC = "SLACK_ENTERPRISE_XOXC";

const SKIP_ENV = /\.(example|sample|template|schema|vault)(\.|$)/i;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export type EnvAssignment = {
  key: string;
  value: string;
  line: number;
};

export type SlackEnvVars = {
  [SLACK_XOXD]?: string;
  [SLACK_TEAM_XOXC]?: string;
  [SLACK_ENTERPRISE_XOXC]?: string;
};

export type EnvUpdatePlan = {
  file: string;
  original: string;
  next: string;
  added: Array<{ key: string; value: string }>;
  replaced: Array<{ key: string; from: string; to: string; line: number }>;
  alreadySet: string[];
  blocked: Array<{ key: string; reason: string }>;
  duplicateKeys: string[];
  warnings: string[];
  isNew: boolean;
};

export async function findEnvFiles(cwd = process.cwd()): Promise<string[]> {
  const names = await readdir(cwd, { withFileTypes: true });
  return names
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name === ".env" || name.startsWith(".env."))
    .filter((name) => !SKIP_ENV.test(name))
    .sort()
    .map((name) => path.join(cwd, name));
}

export function parseEnvAssignments(source: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = raw.match(ENV_LINE);
    if (!match) continue;
    assignments.push({
      key: match[1]!,
      value: unquoteEnvValue(match[2] ?? ""),
      line: i + 1,
    });
  }
  return assignments;
}

export function unquoteEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const start = value[0];
    const end = value.at(-1);
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      const inner = value.slice(1, -1);
      if (start === '"') {
        return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      return inner;
    }
  }
  return value;
}

export function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function duplicateKeys(assignments: EnvAssignment[]): string[] {
  const counts = new Map<string, number>();
  for (const item of assignments) {
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

function firstBy(teams: SlackTeamToken[], pred: (team: SlackTeamToken) => boolean): SlackTeamToken[] {
  return teams.filter(pred);
}

export function slackVarsFromCredentials(creds: SlackCredentials): {
  vars: SlackEnvVars;
  warnings: string[];
} {
  const warnings: string[] = [];
  const vars: SlackEnvVars = {};

  if (creds.xoxd) vars[SLACK_XOXD] = creds.xoxd;

  const enterpriseTeams = firstBy(
    creds.teams,
    (team) => team.teamId.startsWith("E") || team.teamId === creds.enterpriseId,
  );
  const workspaceTeams = firstBy(creds.teams, (team) => team.teamId.startsWith("T"));

  if (enterpriseTeams.length > 1) {
    warnings.push(
      `Multiple enterprise xoxc tokens found (${enterpriseTeams.map((team) => team.teamId).join(", ")}); using ${enterpriseTeams[0]!.teamId}.`,
    );
  }
  if (workspaceTeams.length > 1) {
    warnings.push(
      `Multiple workspace xoxc tokens found (${workspaceTeams.map((team) => team.teamId).join(", ")}); using ${workspaceTeams[0]!.teamId}.`,
    );
  }

  if (enterpriseTeams[0]) vars[SLACK_ENTERPRISE_XOXC] = enterpriseTeams[0].token;
  if (workspaceTeams[0]) vars[SLACK_TEAM_XOXC] = workspaceTeams[0].token;

  return { vars, warnings };
}

export function planEnvUpdate(file: string, original: string, vars: SlackEnvVars, extraWarnings: string[] = []): EnvUpdatePlan {
  const assignments = parseEnvAssignments(original);
  const duplicates = duplicateKeys(assignments);
  const byKey = new Map<string, EnvAssignment[]>();
  for (const item of assignments) {
    const list = byKey.get(item.key) ?? [];
    list.push(item);
    byKey.set(item.key, list);
  }

  const warnings = [...extraWarnings];
  const added: Array<{ key: string; value: string }> = [];
  const replaced: Array<{ key: string; from: string; to: string; line: number }> = [];
  const alreadySet: string[] = [];
  const blocked: Array<{ key: string; reason: string }> = [];

  for (const key of duplicates) {
    warnings.push(`${key} appears ${byKey.get(key)!.length} times in ${path.basename(file)}; leaving it unchanged.`);
  }

  for (const key of [SLACK_XOXD, SLACK_TEAM_XOXC, SLACK_ENTERPRISE_XOXC] as const) {
    const incoming = vars[key];
    if (!incoming) continue;
    const existing = byKey.get(key) ?? [];
    if (existing.length > 1) {
      blocked.push({ key, reason: "duplicate assignments already in the file" });
      continue;
    }
    if (existing.length === 1) {
      if (existing[0]!.value === incoming) {
        alreadySet.push(key);
      } else {
        replaced.push({
          key,
          from: existing[0]!.value,
          to: incoming,
          line: existing[0]!.line,
        });
      }
      continue;
    }
    added.push({ key, value: incoming });
  }

  let next = original;
  for (const item of replaced) {
    next = rewriteEnvAssignment(next, item.line, item.key, item.to);
  }
  if (added.length > 0) {
    const body = next.endsWith("\n") || next.length === 0 ? next : `${next}\n`;
    const prefix = body.length === 0 || body.endsWith("\n\n") ? "" : "\n";
    const lines = added.map(({ key, value }) => `${key}=${quoteEnvValue(value)}`).join("\n");
    next = `${body}${prefix}${lines}\n`;
  }

  return {
    file,
    original,
    next,
    added,
    replaced,
    alreadySet,
    blocked,
    duplicateKeys: duplicates,
    warnings,
    isNew: false,
  };
}

function rewriteEnvAssignment(source: string, lineNumber: number, key: string, value: string): string {
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const endedWithNl = source.endsWith("\n");
  const lines = source.split(/\r?\n/);
  if (endedWithNl && lines.at(-1) === "") lines.pop();
  const idx = lineNumber - 1;
  const raw = lines[idx] ?? "";
  const prefix = raw.match(/^\s*(?:export\s+)?/)?.[0] ?? "";
  lines[idx] = `${prefix}${key}=${quoteEnvValue(value)}`;
  return endedWithNl ? `${lines.join(nl)}\n` : lines.join(nl);
}

function splitLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function unifiedDiff(filename: string, before: string, after: string): string {
  if (before === after) return `(no changes to ${path.basename(filename)})`;

  const a = splitLines(before);
  const b = splitLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aChangeStart = prefix;
  const aChangeEnd = a.length - suffix;
  const bChangeStart = prefix;
  const bChangeEnd = b.length - suffix;
  const context = 3;
  const hunkStart = Math.max(0, aChangeStart - context);
  const hunkOldEnd = Math.min(a.length, aChangeEnd + context);
  const oldCount = hunkOldEnd - hunkStart;
  const newCount =
    aChangeStart - hunkStart + (bChangeEnd - bChangeStart) + (hunkOldEnd - aChangeEnd);

  const lines = [
    `--- ${path.basename(filename)}`,
    `+++ ${path.basename(filename)}`,
    `@@ -${hunkStart + 1},${oldCount} +${hunkStart + 1},${newCount} @@`,
  ];

  for (let i = hunkStart; i < aChangeStart; i++) lines.push(` ${a[i]}`);
  for (let i = aChangeStart; i < aChangeEnd; i++) lines.push(`-${a[i]}`);
  for (let i = bChangeStart; i < bChangeEnd; i++) lines.push(`+${b[i]}`);
  for (let i = aChangeEnd; i < hunkOldEnd; i++) lines.push(` ${a[i]}`);

  return lines.join("\n");
}

export async function applyEnvUpdate(plan: EnvUpdatePlan): Promise<void> {
  if (plan.original === plan.next) return;
  await writeFile(plan.file, plan.next, "utf8");
}

export async function readEnvFile(file: string): Promise<string> {
  return readFile(file, "utf8");
}
