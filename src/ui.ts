import { AsyncLocalStorage } from "node:async_hooks";

export type UiPhase = "working" | "prompt" | "done" | "error";

export type UiState = {
  status: string;
  logs: string[];
  expanded: boolean;
  phase: UiPhase;
  promptLabel: string;
  promptValue: string;
  promptHint: string;
  promptError: string;
};

const MAX_LOGS = 200;

export const EXPANDED_LOG_LINES = 12;

type Listener = () => void;

export class UiController {
  private state: UiState = {
    status: "Starting…",
    logs: [],
    expanded: false,
    phase: "working",
    promptLabel: "",
    promptValue: "",
    promptHint: "",
    promptError: "",
  };
  private readonly listeners = new Set<Listener>();
  private pendingPrompt: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UiState => this.state;

  setStatus(status: string): void {
    this.patch({ status, phase: this.state.phase === "prompt" ? "prompt" : "working" });
  }

  log(line: string): void {
    const text = line.replace(/\s+/g, " ").trim();
    if (!text) return;
    const logs = [...this.state.logs, text].slice(-MAX_LOGS);
    this.patch({ logs });
  }

  toggleExpanded(): void {
    this.patch({ expanded: !this.state.expanded });
  }

  prompt(label: string, options: { hint?: string; error?: string } = {}): Promise<string> {
    const promptLabel = label.replace(/:\s*$/, "").trim();
    this.patch({
      phase: "prompt",
      promptLabel,
      promptValue: "",
      promptHint: options.hint ?? "",
      promptError: options.error ?? "",
      status: promptLabel,
    });
    return new Promise((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
    });
  }

  appendPrompt(chunk: string): void {
    if (this.state.phase !== "prompt") return;
    this.patch({ promptValue: this.state.promptValue + chunk });
  }

  backspacePrompt(): void {
    if (this.state.phase !== "prompt") return;
    this.patch({ promptValue: this.state.promptValue.slice(0, -1) });
  }

  submitPrompt(): void {
    if (this.state.phase !== "prompt") return;
    const value = this.state.promptValue.trim();
    if (!value) return;
    const pending = this.pendingPrompt;
    this.pendingPrompt = null;
    this.patch({
      phase: "working",
      promptValue: "",
      promptLabel: "",
      promptHint: "",
      promptError: "",
    });
    pending?.resolve(value);
  }

  succeed(status: string): void {
    this.cancelPrompt(new Error("cancelled"));
    this.patch({ phase: "done", status });
  }

  fail(status: string): void {
    this.cancelPrompt(new Error(status));
    this.patch({ phase: "error", status });
  }

  cancelPrompt(error: Error): void {
    this.pendingPrompt?.reject(error);
    this.pendingPrompt = null;
  }

  private patch(partial: Partial<UiState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

const uiStore = new AsyncLocalStorage<UiController>();

export function getUi(): UiController | undefined {
  return uiStore.getStore();
}

export function status(message: string): void {
  getUi()?.setStatus(message);
}

export function log(message: string): void {
  getUi()?.log(message);
}

export function isInteractiveUi(): boolean {
  return Boolean(process.stderr.isTTY && process.stdin.isTTY);
}

export async function runWithUi<T>(
  fn: () => Promise<T>,
  options: { done?: string } = {},
): Promise<T> {
  const ui = new UiController();
  const { startUi } = await import("./ui-app.js");
  const instance = startUi(ui);

  try {
    const result = await uiStore.run(ui, fn);
    ui.succeed(options.done ?? "Got Slack tokens");
    await sleep(120);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.fail(message);
    await sleep(80);
    throw error;
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
