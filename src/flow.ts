import type { CliArgs } from "./args.js";
import type { SlackCredentials } from "./extract.js";
import { hackclubLogin, hackclubLogout } from "./hackclub.js";
import { HttpSession } from "./http.js";
import { slackSso } from "./slack.js";
import { log } from "./ui.js";

export async function loginAndExtract(args: CliArgs): Promise<SlackCredentials> {
  const session = new HttpSession(args.timeoutMs);
  await hackclubLogin(session, args);
  try {
    return await slackSso(session);
  } finally {
    try {
      await hackclubLogout(session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Could not sign out of Hack Club Auth: ${message}`);
    }
  }
}
