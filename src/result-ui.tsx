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
  displayName,
  envConfirmText,
  findEnvFiles,
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
  if (notice.startsWith("No ") || notice.startsWith("Nothing")) return "yellow";
  return "green";
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
  const identity = identityInfo(creds);
  const cards = tokenCards(creds);
  const { columns } = useWindowSize();
  const width = Math.max(24, (columns || 80) - 2);
  const [view, setView] = useState<View>({ kind: "tokens" });
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [confirmYes, setConfirmYes] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef(view);
  const selectedRef = useRef(selected);
  const fileIndexRef = useRef(fileIndex);
  const confirmYesRef = useRef(confirmYes);
  const cardsRef = useRef(cards);
  const busy = useRef(false);
  viewRef.current = view;
  selectedRef.current = selected;
  fileIndexRef.current = fileIndex;
  confirmYesRef.current = confirmYes;
  cardsRef.current = cards;

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
    if (plan.added.length === 0) {
      showTokens(nothingToWriteMessage(plan));
      return;
    }
    setConfirmYes(true);
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
          showTokens("No .env file found in this directory.");
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
    const card = cardsRef.current[selectedRef.current];
    const vars = card ? envVarsForCard(card) : null;
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
    const card = cardsRef.current[selectedRef.current];
    if (!card) {
      setNotice("No tokens to copy.");
      return;
    }
    void copyToClipboard(card.value)
      .then(() => setNotice(`Copied ${card.title} to the clipboard.`))
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
      if (key.upArrow) {
        setFileIndex((index) => (index + options.length - 1) % options.length);
        return;
      }
      if (key.downArrow) {
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
      if (key.upArrow || key.downArrow) {
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

    if (key.upArrow) {
      if (cardsRef.current.length === 0) return;
      setSelected((index) => (index + cardsRef.current.length - 1) % cardsRef.current.length);
      return;
    }
    if (key.downArrow) {
      if (cardsRef.current.length === 0) return;
      setSelected((index) => (index + 1) % cardsRef.current.length);
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
      showTokens(wroteMessage(plan.file, plan.added.map((item) => item.key)));
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
        <Text dimColor>↑/↓ to move · enter to select · esc to skip</Text>
      </Box>
    );
  }

  if (view.kind === "confirm") {
    const extra = maskSecretsInText(envConfirmText(view.plan));
    return (
      <Box flexDirection="column" paddingLeft={1} marginY={1}>
        <Text bold>Apply changes to {displayName(view.plan.file)}?</Text>
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

  const footer = `c copy · C copy all · e save · E save all · v ${revealed ? "hide" : "show"} · q quit`;

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1} gap={1}>
      <Box flexDirection="column">
        {identity.userIds.map((id) => (
          <Text key={id} wrap="truncate">
            user  {id}
          </Text>
        ))}
        {identity.enterpriseId ? (
          <Text dimColor wrap="truncate">
            org   {identity.enterpriseId}
          </Text>
        ) : null}
      </Box>

      <Text bold>Slack tokens</Text>

      {cards.map((card, index) => {
        const isSelected = index === selected;
        const shown = revealed ? card.value : maskSecret(card.value);
        return (
          <Card key={card.id} title={card.title} selected={isSelected} width={width}>
            <Text wrap={revealed ? "wrap" : "truncate"} color={isSelected ? "cyan" : undefined}>
              {shown}
            </Text>
            {card.details.map((detail) => (
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
