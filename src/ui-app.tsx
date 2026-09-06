import { useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { Box, Text, render, useInput, type Instance } from "ink";
import { EXPANDED_LOG_LINES, type UiController, type UiState } from "./ui.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function Spinner(): JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

function glyph(state: UiState): JSX.Element {
  if (state.phase === "working") return <Spinner />;
  if (state.phase === "prompt") return <Text color="yellow">?</Text>;
  if (state.phase === "done") return <Text color="green">✓</Text>;
  return <Text color="red">✗</Text>;
}

function visibleLogs(state: UiState): string[] {
  if (state.logs.length === 0) return [];
  if (state.expanded) return state.logs.slice(-EXPANDED_LOG_LINES);
  return state.logs.slice(-1);
}

function App({ ui }: { ui: UiController }): JSX.Element {
  const state = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
  const logs = visibleLogs(state);
  const showHint = state.phase === "working";

  useInput((input, key) => {
    if (input === "l" && !key.ctrl && !key.meta && ui.getSnapshot().phase !== "prompt") {
      ui.toggleExpanded();
      return;
    }
    if (ui.getSnapshot().phase !== "prompt") return;
    if (key.return) {
      ui.submitPrompt();
      return;
    }
    if (key.backspace || key.delete) {
      ui.backspacePrompt();
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.escape) return;
    if (input) ui.appendPrompt(input);
  });

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1}>
      <Box>
        {glyph(state)}
        <Text> </Text>
        <Text bold={state.phase !== "error"} color={state.phase === "error" ? "red" : undefined}>
          {state.status}
        </Text>
      </Box>

      {state.phase === "prompt" ? (
        <Box flexDirection="column" paddingLeft={2}>
          {state.promptHint
            ? state.promptHint.split("\n").map((line) => (
                <Text key={line} dimColor>
                  {line}
                </Text>
              ))
            : null}
          {state.promptError ? <Text color="red">{state.promptError}</Text> : null}
          <Box>
            <Text color="cyan">{state.promptValue}</Text>
            <Text inverse> </Text>
          </Box>
        </Box>
      ) : null}

      {logs.map((line, index) => (
        <Box key={`${index}-${line.slice(0, 24)}`} paddingLeft={2}>
          <Text dimColor wrap="truncate">
            {line}
          </Text>
        </Box>
      ))}

      {showHint ? (
        <Box paddingLeft={2}>
          <Text dimColor>
            {state.expanded ? "l collapse logs" : "l expand logs"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function startUi(ui: UiController): Instance {
  return render(<App ui={ui} />, {
    stdout: process.stderr,
    stdin: process.stdin,
    patchConsole: false,
    alternateScreen: false,
    exitOnCtrlC: true,
  });
}
