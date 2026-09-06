#!/usr/bin/env node
import { parseArgs, printUsage } from "./args.js";
import { loginAndExtract, printCredentials } from "./flow.js";
import { maybeWriteEnvFile } from "./save-env.js";
import { isInteractiveUi, runWithUi } from "./ui.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.email) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const creds = await runWithUi(() => loginAndExtract(args));
    printCredentials(creds, args.json);
    try {
      await maybeWriteEnvFile(creds);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Could not update env file: ${message}`);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInteractiveUi()) {
      console.error(`error: ${message}`);
    }
    process.exitCode = 1;
  }
}

await main();
