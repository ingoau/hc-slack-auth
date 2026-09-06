import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getUi } from "./ui.js";

export async function prompt(message: string): Promise<string> {
  const ui = getUi();
  if (ui) return ui.prompt(message);

  const rl = readline.createInterface({ input, output });
  try {
    const value = (await rl.question(message)).trim();
    if (!value) {
      throw new Error("a value is required");
    }
    return value;
  } finally {
    rl.close();
  }
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}
