import type { ReactNode } from "react";
import { render, type Instance, type RenderOptions } from "ink";

const OPTIONS: RenderOptions = {
  stdout: process.stderr,
  stdin: process.stdin,
  patchConsole: false,
  alternateScreen: false,
  exitOnCtrlC: true,
};

let instance: Instance | null = null;

export function afterInput(fn: () => void): void {
  setTimeout(fn, 0);
}

export function showScreen(node: ReactNode): Instance {
  if (instance) {
    instance.rerender(node);
    return instance;
  }
  instance = render(node, OPTIONS);
  return instance;
}

export async function closeScreen(): Promise<void> {
  if (!instance) return;
  const current = instance;
  instance = null;
  current.unmount();
  await current.waitUntilExit();
}
