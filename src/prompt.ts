import { getUi } from "./ui.js";

export type PromptOptions = {
  hint?: string;
  error?: string;
};

export async function prompt(message: string, options: PromptOptions = {}): Promise<string> {
  const ui = getUi();
  if (!ui) {
    throw new Error("this command must be run in an interactive terminal");
  }
  return ui.prompt(message, options);
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}
