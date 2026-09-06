import { useRef, useState, type JSX, type ReactNode } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { copyToClipboard } from "./clipboard.js";
import {
  quoteEnvValue,
  slackVarsFromCredentials,
  SLACK_ENTERPRISE_XOXC,
  SLACK_TEAM_XOXC,
  SLACK_XOXD,
  type EnvUpdatePlan,
  type SlackEnvVars,
} from "./envfile.js";
import {
  identityInfo,
  maskSecret,
  tokenCards,
  type SlackCredentials,
  type TokenCard,
} from "./extract.js";
import {
  applyEnvUpdate,
  defaultEnvFile,
  displayName,
  envConfirmText,
  envConfirmTitle,
  findEnvFiles,
  hasEnvChanges,
  maskSecretsInText,
  nothingToWriteMessage,
  planEnvWrite,
  wroteMessage,
} from "./save-env.js";
import { afterInput, closeScreen, showScreen } from "./screen.js";
import { isInteractiveUi } from "./ui.js";

type View =
  | { kind: "tokens" }
  | { kind: "files"; files: string[]; vars: SlackEnvVars; warnings: string[] }
  | { kind: "confirm"; plan: EnvUpdatePlan };

function noticeColor(notice: string | null): "red" | "yellow" | "green" | undefined {
  if (!notice) return undefined;
  if (notice.startsWith("Could not")) return "red";
  if (
    notice.startsWith("No ") ||
    notice.startsWith("Nothing") ||
    notice.includes("isn't saved")
  ) {
    return "yellow";
  }
  return "green";
}

type ResultRow =
  | { id: string; kind: "identity"; title: string; value: string; savable: false }
  | { id: string; kind: "token"; title: string; value: string; savable: true; card: TokenCard };

function resultRows(creds: SlackCredentials): ResultRow[] {
  const identity = identityInfo(creds);
  const rows: ResultRow[] = [];
  for (const id of identity.userIds) {
    rows.push({ id: `user-${id}`, kind: "identity", title: "user", value: id, savable: false });
  }
  if (identity.enterpriseId) {
    rows.push({
      id: `org-${identity.enterpriseId}`,
      kind: "identity",
      title: "org",
      value: identity.enterpriseId,
      savable: false,
    });
  }
  for (const card of tokenCards(creds)) {
    rows.push({ id: card.id, kind: "token", title: card.title, value: card.value, savable: true, card });
  }
  return rows;
}

function firstSavableIndex(rows: ResultRow[]): number {
  const index = rows.findIndex((row) => row.savable);
  return index >= 0 ? index : 0;
}

function envVarsForCard(card: TokenCard): SlackEnvVars | null {
  if (card.kind === "xoxd") return { [SLACK_XOXD]: card.value };
  if (card.role === "enterprise") return { [SLACK_ENTERPRISE_XOXC]: card.value };
  if (card.role === "workspace") return { [SLACK_TEAM_XOXC]: card.value };
  return null;
}

function envLinesText(vars: SlackEnvVars): string {
  const lines: string[] = [];
  if (vars[SLACK_XOXD]) lines.push(`${SLACK_XOXD}=${quoteEnvValue(vars[SLACK_XOXD])}`);
  if (vars[SLACK_TEAM_XOXC]) lines.push(`${SLACK_TEAM_XOXC}=${quoteEnvValue(vars[SLACK_TEAM_XOXC])}`);
  if (vars[SLACK_ENTERPRISE_XOXC]) {
    lines.push(`${SLACK_ENTERPRISE_XOXC}=${quoteEnvValue(vars[SLACK_ENTERPRISE_XOXC])}`);
  }
  return lines.join("\n");
}

function Card({
  title,
  selected,
  width,
  children,
}: {
  title: string;
  selected?: boolean;
  width: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={selected ? "cyan" : "gray"}
      paddingX={1}
      width={width}
    >
      <Text bold color={selected ? "cyan" : undefined}>
        {selected ? "❯ " : "  "}
        {title}
      </Text>
      {children}
    </Box>
  );
}

function ResultApp({
  creds,
  onQuit,
}: {
  creds: SlackCredentials;
  onQuit: () => void;
}): JSX.Element {
  const rows = resultRows(creds);
  const identityRows = rows.filter(
    (row): row is Extract<ResultRow, { kind: "identity" }> => row.kind === "identity",
  );
  const tokenRows = rows.filter(
    (row): row is Extract<ResultRow, { kind: "token" }> => row.kind === "token",
  );
  const { columns } = useWindowSize();
  const width = Math.max(24, (columns || 80) - 2);
  const [view, setView] = useState<View>({ kind: "tokens" });
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState(() => firstSavableIndex(rows));
  const [fileIndex, setFileIndex] = useState(0);
  const [confirmYes, setConfirmYes] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef(view);
  const selectedRef = useRef(selected);
  const fileIndexRef = useRef(fileIndex);
  const confirmYesRef = useRef(confirmYes);
  const rowsRef = useRef(rows);
  const busy = useRef(false);
  viewRef.current = view;
  selectedRef.current = selected;
  fileIndexRef.current = fileIndex;
  confirmYesRef.current = confirmYes;
  rowsRef.current = rows;

  const showTokens = (message?: string) => {
    if (message !== undefined) setNotice(message);
    setView({ kind: "tokens" });
  };

  const openConfirm = async (
    file: string,
    vars: SlackEnvVars,
    warnings: string[],
  ): Promise<void> => {
    const plan = await planEnvWrite(vars, warnings, file);
    if (!hasEnvChanges(plan)) {
      showTokens(nothingToWriteMessage(plan));
      return;
    }
    setConfirmYes(plan.replaced.length === 0);
    setView({ kind: "confirm", plan });
  };

  const beginSave = (vars: SlackEnvVars, warnings: string[]) => {
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        if (!vars.SLACK_XOXD && !vars.SLACK_TEAM_XOXC && !vars.SLACK_ENTERPRISE_XOXC) {
          showTokens("No Slack tokens to save.");
          return;
        }
        const files = await findEnvFiles();
        if (files.length === 0) {
          await openConfirm(defaultEnvFile(), vars, warnings);
          return;
        }
        if (files.length === 1) {
          await openConfirm(files[0]!, vars, warnings);
          return;
        }
        setFileIndex(0);
        setView({ kind: "files", files, vars, warnings });
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        showTokens(`Could not update env file: ${text}`);
      } finally {
        busy.current = false;
      }
    })();
  };

  const saveSelected = () => {
    const row = rowsRef.current[selectedRef.current];
    if (!row) {
      setNotice("No tokens to save.");
      return;
    }
    if (!row.savable) {
      setNotice(`${row.title} isn't saved to env; press c to copy`);
      return;
    }
    const vars = envVarsForCard(row.card);
    if (!vars) {
      setNotice("Don't know which env var to use for this token.");
      return;
    }
    beginSave(vars, []);
  };

  const saveAll = () => {
    const { vars, warnings } = slackVarsFromCredentials(creds);
    beginSave(vars, warnings);
  };

  const copySelected = () => {
    const row = rowsRef.current[selectedRef.current];
    if (!row) {
      setNotice("Nothing to copy.");
      return;
    }
    void copyToClipboard(row.value)
      .then(() => setNotice(`Copied ${row.title} to the clipboard.`))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setNotice(`Could not copy to the clipboard: ${text}`);
      });
  };

  const copyAll = () => {
    const text = envLinesText(slackVarsFromCredentials(creds).vars);
    if (!text) {
      setNotice("No tokens to copy.");
      return;
    }
    void copyToClipboard(text)
      .then(() => setNotice("Copied all tokens to the clipboard."))
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error);
        setNotice(`Could not copy to the clipboard: ${messageText}`);
      });
  };

  useInput((input, key) => {
    const current = viewRef.current;

    if (current.kind === "files") {
      const options = [...current.files, null];
      if (key.upArrow || input === "k") {
        setFileIndex((index) => (index + options.length - 1) % options.length);
        return;
      }
      if (key.downArrow || input === "j") {
        setFileIndex((index) => (index + 1) % options.length);
        return;
      }
      if (key.escape || input === "q") {
        showTokens();
        return;
      }
      if (key.return) {
        const picked = options[fileIndexRef.current];
        if (!picked) {
          showTokens();
          return;
        }
        if (busy.current) return;
        busy.current = true;
        void openConfirm(picked, current.vars, current.warnings).finally(() => {
          busy.current = false;
        });
      }
      return;
    }

    if (current.kind === "confirm") {
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        setConfirmYes((value) => !value);
        return;
      }
      if (input === "y" || input === "Y") {
        setConfirmYes(true);
        void applyAndReturn(current.plan);
        return;
      }
      if (input === "n" || input === "N" || key.escape || input === "q") {
        showTokens();
        return;
      }
      if (key.return) {
        if (confirmYesRef.current) void applyAndReturn(current.plan);
        else showTokens();
      }
      return;
    }

    if (key.upArrow || input === "k") {
      if (rowsRef.current.length === 0) return;
      setSelected((index) => (index + rowsRef.current.length - 1) % rowsRef.current.length);
      return;
    }
    if (key.downArrow || input === "j") {
      if (rowsRef.current.length === 0) return;
      setSelected((index) => (index + 1) % rowsRef.current.length);
      return;
    }
    if (input === "v") {
      setRevealed((value) => !value);
      return;
    }
    if (input === "c") {
      copySelected();
      return;
    }
    if (input === "C") {
      copyAll();
      return;
    }
    if (input === "e") {
      saveSelected();
      return;
    }
    if (input === "E") {
      saveAll();
      return;
    }
    if (input === "q" || key.escape) {
      afterInput(onQuit);
    }
  });

  async function applyAndReturn(plan: EnvUpdatePlan): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    try {
      await applyEnvUpdate(plan);
      showTokens(wroteMessage(plan));
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      showTokens(`Could not update env file: ${text}`);
    } finally {
      busy.current = false;
    }
  }

  if (view.kind === "files") {
    const options = [
      ...view.files.map((file) => ({ label: displayName(file), value: file })),
      { label: "Don't save", value: null },
    ];
    return (
      <Box flexDirection="column" paddingLeft={1} marginY={1}>
        <Text bold>Save Slack credentials to which env file?</Text>
        {options.map((option, index) => (
          <Text key={option.label} color={index === fileIndex ? "cyan" : undefined}>
            {index === fileIndex ? "❯ " : "  "}
            {option.label}
          </Text>
        ))}
        <Text dimColor>↑/↓ or j/k to move · enter to select · esc to skip</Text>
      </Box>
    );
  }

  if (view.kind === "confirm") {
    const extra = maskSecretsInText(envConfirmText(view.plan));
    return (
      <Box flexDirection="column" paddingLeft={1} marginY={1}>
        <Text bold>{envConfirmTitle(view.plan)}</Text>
        {extra.split("\n").map((line, i) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++");
          const isDel = line.startsWith("-") && !line.startsWith("---");
          const isWarning = line.startsWith("warning:");
          return (
            <Text
              key={`extra-${i}`}
              color={isWarning ? "yellow" : isAdd ? "green" : isDel ? "red" : undefined}
              dimColor={!isWarning && !isAdd && !isDel}
              wrap="truncate"
            >
              {line.length === 0 ? " " : line}
            </Text>
          );
        })}
        <Text color={confirmYes ? "cyan" : undefined}>{confirmYes ? "❯ " : "  "}Yes</Text>
        <Text color={!confirmYes ? "cyan" : undefined}>{!confirmYes ? "❯ " : "  "}No</Text>
        <Text dimColor>y/n · enter to select · esc to skip</Text>
      </Box>
    );
  }

  const footer = `j/k · c copy · C copy all · e save · E save all · v ${revealed ? "hide" : "show"} · q quit`;

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1} gap={1}>
      {identityRows.length > 0 ? (
        <Box flexDirection="column">
          {identityRows.map((row) => {
            const isSelected = rows[selected]?.id === row.id;
            return (
              <Text
                key={row.id}
                color={isSelected ? "cyan" : undefined}
                dimColor={!isSelected && row.title === "org"}
                wrap="truncate"
              >
                {isSelected ? "❯ " : "  "}
                {row.title.padEnd(4)}  {row.value}
              </Text>
            );
          })}
        </Box>
      ) : null}

      <Text bold>Slack tokens</Text>

      {tokenRows.map((row) => {
        const isSelected = rows[selected]?.id === row.id;
        const shown = revealed ? row.value : maskSecret(row.value);
        return (
          <Card key={row.id} title={row.card.title} selected={isSelected} width={width}>
            <Text wrap={revealed ? "wrap" : "truncate"} color={isSelected ? "cyan" : undefined}>
              {shown}
            </Text>
            {row.card.details.map((detail) => (
              <Text key={detail.label} dimColor wrap="truncate">
                {detail.label}  {detail.value}
              </Text>
            ))}
          </Card>
        );
      })}

      <Text color={noticeColor(notice)}>{notice && notice.length > 0 ? notice : " "}</Text>
      <Text dimColor wrap="truncate">
        {footer}
      </Text>
    </Box>
  );
}

export async function showResultPage(creds: SlackCredentials): Promise<void> {
  if (!isInteractiveUi()) return;

  try {
    await new Promise<void>((resolve) => {
      showScreen(<ResultApp creds={creds} onQuit={resolve} />);
    });
  } finally {
    await closeScreen();
  }
}
