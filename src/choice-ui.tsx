import { useState, type JSX } from "react";
import { Box, Text, render, useInput } from "ink";
import { isInteractiveUi } from "./ui.js";

export type Choice<T> = {
  label: string;
  value: T;
};

function ChoiceList<T>({
  title,
  options,
  footer,
  extra,
  confirmKeys = false,
  onDone,
}: {
  title: string;
  options: Array<Choice<T>>;
  footer?: string;
  extra?: string;
  confirmKeys?: boolean;
  onDone: (value: T | null) => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((current) => (current + options.length - 1) % options.length);
      return;
    }
    if (key.downArrow) {
      setIndex((current) => (current + 1) % options.length);
      return;
    }
    if (key.return) {
      onDone(options[index]!.value);
      return;
    }
    if (confirmKeys) {
      if (input === "y" || input === "Y") {
        const yes = options.find((option) => option.value === true);
        if (yes) {
          onDone(yes.value);
          return;
        }
      }
      if (input === "n" || input === "N") {
        const no = options.find((option) => option.value === false);
        if (no) {
          onDone(no.value);
          return;
        }
      }
    }
    if (key.escape || input === "q") {
      onDone(null);
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1}>
      <Text bold>{title}</Text>
      {extra
        ? extra.split("\n").map((line, i) => {
            const isAdd = line.startsWith("+") && !line.startsWith("+++");
            const isDel = line.startsWith("-") && !line.startsWith("---");
            const isWarning = line.startsWith("warning:");
            return (
              <Text
                key={`extra-${i}`}
                color={isWarning ? "yellow" : isAdd ? "green" : isDel ? "red" : undefined}
                dimColor={!isWarning && !isAdd && !isDel}
              >
                {line.length === 0 ? " " : line}
              </Text>
            );
          })
        : null}
      {options.map((option, i) => (
        <Text key={option.label} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
      <Text dimColor>{footer ?? "↑/↓ to move · enter to select · esc to skip"}</Text>
    </Box>
  );
}

async function renderChoice<T>(
  title: string,
  options: Array<Choice<T>>,
  extra?: string,
  confirmKeys = false,
): Promise<T | null> {
  if (!isInteractiveUi()) return null;

  return await new Promise((resolve) => {
    const instance = render(
      <ChoiceList
        title={title}
        options={options}
        extra={extra}
        confirmKeys={confirmKeys}
        footer={
          confirmKeys
            ? "y/n · enter to select · esc to skip"
            : "↑/↓ to move · enter to select · esc to skip"
        }
        onDone={(value) => {
          instance.unmount();
          void instance.waitUntilExit().then(() => resolve(value));
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

export async function choose<T>(
  title: string,
  options: Array<Choice<T>>,
  extra?: string,
): Promise<T | null> {
  return renderChoice(title, options, extra);
}

export async function confirm(title: string, extra?: string): Promise<boolean> {
  const value = await renderChoice(
    title,
    [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ],
    extra,
    true,
  );
  return value === true;
}
