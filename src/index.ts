#!/usr/bin/env node
import { parseArgs, printUsage } from "./args.js";
import { loginAndExtract } from "./flow.js";

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

  await loginAndExtract(args);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
