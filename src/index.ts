#!/usr/bin/env node
import { parseArgs, printUsage } from "./args.js";
import { loginAndExtract } from "./flow.js";
import { prompt } from "./prompt.js";
import { showResultPage } from "./result-ui.js";
import { isInteractiveUi, runWithUi } from "./ui.js";

async function askForEmail(): Promise<string> {
  let previous: string | undefined;
  for (;;) {
    const email = await prompt("Hack Club email", {
      hint: "The address you use at auth.hackclub.com",
      error: previous ? "That doesn't look like an email" : undefined,
    });
    if (email.includes("@")) return email;
    previous = email;
  }
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (!isInteractiveUi()) {
    console.error("hc-slack-auth is interactive-only. Run it in a terminal.");
    process.exitCode = 1;
    return;
  }

  try {
    const creds = await runWithUi(async () => {
      if (!args.email) args.email = await askForEmail();
      return loginAndExtract(args);
    });
    await showResultPage(creds);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}

await main();
