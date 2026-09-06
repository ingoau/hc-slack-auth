import { useRef, type JSX } from "react";
import { Box, Text, render, useInput } from "ink";
import { copyToClipboard } from "./clipboard.js";
import { choose } from "./choice-ui.js";
import {
  quoteEnvValue,
  slackVarsFromCredentials,
  SLACK_ENTERPRISE_XOXC,
  SLACK_TEAM_XOXC,
  SLACK_XOXD,
  type SlackEnvVars,
} from "./envfile.js";
import { formatCredentialsMasked, maskSecret, type SlackCredentials } from "./extract.js";
import { maybeWriteEnvFile } from "./save-env.js";
import { isInteractiveUi } from "./ui.js";

type ResultAction = "copy" | "env" | "quit";

function ResultScreen({
  creds,
  notice,
  onAction,
}: {
  creds: SlackCredentials;
  notice: string | null;
  onAction: (action: ResultAction) => void;
}): JSX.Element {
  const done = useRef(false);
  const lines = formatCredentialsMasked(creds);
  const noticeColor = !notice
    ? undefined
    : notice.startsWith("Could not")
      ? "red"
      : notice.startsWith("No ") || notice.startsWith("Nothing")
        ? "yellow"
        : "green";

  useInput((input, key) => {
    if (done.current) return;
    if (key.escape || input === "q") {
      done.current = true;
      onAction("quit");
      return;
    }
    if (input === "c") {
      done.current = true;
      onAction("copy");
      return;
    }
    if (input === "e") {
      done.current = true;
      onAction("env");
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1}>
      <Text bold>Slack tokens</Text>
      {lines.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
      {notice ? <Text color={noticeColor}>{notice}</Text> : null}
      <Text dimColor>c copy · e save to env · q quit</Text>
    </Box>
  );
}

async function renderResult(creds: SlackCredentials, notice: string | null): Promise<ResultAction> {
  return await new Promise((resolve) => {
    const instance = render(
      <ResultScreen
        creds={creds}
        notice={notice}
        onAction={(action) => {
          instance.unmount();
          void instance.waitUntilExit().then(() => resolve(action));
        }}
      />,
      {
        stdout: process.stderr,
        stdin: process.stdin,
        patchConsole: false,
        alternateScreen: false,
        exitOnCtrlC: true,
      },
    );
  });
}

function envLine(key: string, value: string): string {
  return `${key}=${quoteEnvValue(value)}`;
}

function copyTargets(vars: SlackEnvVars): Array<{ label: string; value: string; copied: string }> {
  const xoxd = vars[SLACK_XOXD];
  const team = vars[SLACK_TEAM_XOXC];
  const enterprise = vars[SLACK_ENTERPRISE_XOXC];
  const targets: Array<{ label: string; value: string; copied: string }> = [];
  if (xoxd) {
    targets.push({
      label: `${SLACK_XOXD}  ${maskSecret(xoxd)}`,
      value: xoxd,
      copied: SLACK_XOXD,
    });
  }
  if (team) {
    targets.push({
      label: `${SLACK_TEAM_XOXC}  ${maskSecret(team)}`,
      value: team,
      copied: SLACK_TEAM_XOXC,
    });
  }
  if (enterprise) {
    targets.push({
      label: `${SLACK_ENTERPRISE_XOXC}  ${maskSecret(enterprise)}`,
      value: enterprise,
      copied: SLACK_ENTERPRISE_XOXC,
    });
  }
  if (targets.length > 1) {
    const lines = targets.map((item) => envLine(item.copied, item.value)).join("\n");
    targets.push({
      label: "All as env lines",
      value: lines,
      copied: "env lines",
    });
  }
  return targets;
}

async function copySomething(creds: SlackCredentials): Promise<string | null> {
  const { vars } = slackVarsFromCredentials(creds);
  const targets = copyTargets(vars);
  if (targets.length === 0) return "No tokens to copy.";

  const selected = await choose(
    "Copy which token?",
    targets.map((item) => ({ label: item.label, value: item })),
  );
  if (!selected) return null;

  try {
    await copyToClipboard(selected.value);
    return `Copied ${selected.copied} to the clipboard.`;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not copy to the clipboard: ${message}`;
  }
}

export async function showResultPage(creds: SlackCredentials): Promise<void> {
  if (!isInteractiveUi()) return;

  let notice: string | null = null;
  for (;;) {
    const action = await renderResult(creds, notice);
    if (action === "quit") return;
    if (action === "copy") {
      notice = (await copySomething(creds)) ?? notice;
      continue;
    }
    try {
      notice = (await maybeWriteEnvFile(creds)) || notice;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      notice = `Could not update env file: ${message}`;
    }
  }
}
